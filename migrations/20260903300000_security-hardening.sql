-- Migration: Security Hardening C1–C3 (host-only sync, private-room scoping, member tokens)
--
-- SCOPE: code + SQL files only — DO NOT APPLY without staging review.
-- Fixes SECURITY-AUDIT.md C1–C3 and security_hardening_plan.md blockers:
--   B1 status enum uses 'rejected' (matches src/hooks/useRoomQueue.ts:17)
--   B2 adds room_queue.updated_at (plan referenced a missing column)
--   B3 fail-closed private predicates (plan's "any active member" predicate was world-readable)
--   B4 seq-jump filter REJECTED (seq is Date.now-based, ~3000 normal jumps)
--
-- ROLLBACK: prior policy/function definitions live in
--   20260903000001_multiroom-realtime-rls.sql, 20260903100000_ephemeral-and-queue.sql,
--   20260903000000_multiroom-core.sql, 20260824120000_host-handover.sql,
--   20260903200000_clock-sync-and-indexes.sql. Re-apply those files to revert.
--
-- RESEARCH: Supabase Realtime Authorization (separate SELECT/INSERT on realtime.messages,
-- topic + auth.uid() match), Supabase RLS (ownership EXISTS, pinned search_path,
-- REVOKE EXECUTE least-privilege), Stack Overflow authenticated-room token-per-emit.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- §1. Schema additive fix (blocker B2)
-- ============================================================
ALTER TABLE public.room_queue
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS member_token VARCHAR(64) NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex');

CREATE INDEX IF NOT EXISTS idx_room_members_token ON public.room_members(room_id, session_id);

-- Status CHECK with the CORRECT enum (blocker B1: 'rejected', not 'dismissed')
ALTER TABLE public.room_queue DROP CONSTRAINT IF EXISTS chk_queue_status;
ALTER TABLE public.room_queue
  ADD CONSTRAINT chk_queue_status CHECK (status IN ('queued', 'playing', 'played', 'rejected'));

-- ============================================================
-- §2. C1 — Realtime sync publish: host-only + strict channel shape
-- ============================================================
DROP POLICY IF EXISTS "room host can publish room sync" ON realtime.messages;
DROP POLICY IF EXISTS "room host can publish sync" ON realtime.messages;

-- NOTE: SQL does not guarantee AND short-circuit order. The CASE guard ensures a
-- malformed channel_name fails closed instead of raising a ::uuid cast error.
CREATE POLICY "room host can publish room sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-fA-F-]{36}:sync$'
    AND CASE
      WHEN channel_name ~ '^room:[0-9a-fA-F-]{36}:sync$' THEN EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = (split_part(channel_name, ':', 2))::uuid
          AND r.host_id = (SELECT auth.uid())
      )
      ELSE false
    END
  );

-- Chat publish stays member-capable but gets the same strict shape (was LIKE 'room:%:chat').
DROP POLICY IF EXISTS "anyone can publish room chat" ON realtime.messages;
DROP POLICY IF EXISTS "anyone can publish chat" ON realtime.messages;
CREATE POLICY "anyone can publish room chat" ON realtime.messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-fA-F-]{36}:chat$'
    OR channel_name IN ('chat_messages', 'realtime:chat_messages')
  );

-- Disable legacy global channels (re-enable to rollback).
UPDATE realtime.channels SET enabled = false WHERE pattern IN ('player_sync', 'chat_messages');

-- ============================================================
-- §3. C2 — Private-room read scoping (fail-closed interim)
-- ============================================================
-- Rationale (docs/002): anon cannot prove membership in pure RLS (no auth.uid()),
-- so private rows are host-or-denied at RLS; private content flows via
-- join_room_secure() (password-gated). Public rooms stay readable.

-- rooms directory: public rows, or rows the caller hosts.
DROP POLICY IF EXISTS "select chat_messages by room" ON public.chat_messages;
DROP POLICY IF EXISTS "rooms select" ON public.rooms;
DROP POLICY IF EXISTS "public select rooms" ON public.rooms;
DROP POLICY IF EXISTS "rooms select public or member" ON public.rooms;
CREATE POLICY "rooms select public or host" ON public.rooms
  FOR SELECT TO anon, authenticated
  USING (
    NOT is_private
    OR host_id = (SELECT auth.uid())
  );

-- chat_messages: parent room public, or caller hosts it.
DROP POLICY IF EXISTS "select chat_messages by room" ON public.chat_messages;
CREATE POLICY "select chat_messages by room" ON public.chat_messages
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = chat_messages.room_id
        AND (NOT r.is_private OR r.host_id = (SELECT auth.uid()))
    )
  );

-- room_queue: same parent-room rule.
DROP POLICY IF EXISTS "anyone can view room_queue" ON public.room_queue;
CREATE POLICY "select room_queue by room" ON public.room_queue
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_queue.room_id
        AND (NOT r.is_private OR r.host_id = (SELECT auth.uid()))
    )
  );

-- queue_votes: visible iff parent queue's room is public or hosted by caller.
DROP POLICY IF EXISTS "anyone can view queue_votes" ON public.queue_votes;
CREATE POLICY "select queue_votes by room" ON public.queue_votes
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.room_queue q
      JOIN public.rooms r ON r.id = q.room_id
      WHERE q.id = queue_votes.queue_id
        AND (NOT r.is_private OR r.host_id = (SELECT auth.uid()))
    )
  );

-- room_members: parent room public, or caller hosts it, or caller owns the row.
DROP POLICY IF EXISTS "members can view room occupants" ON public.room_members;
CREATE POLICY "select room_members scoped" ON public.room_members
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_members.room_id
        AND (
          NOT r.is_private
          OR r.host_id = (SELECT auth.uid())
          OR (room_members.user_id IS NOT NULL AND room_members.user_id = (SELECT auth.uid()))
        )
    )
  );

-- ---- request_song: validation + caps (membership-token check = follow-up) ----
CREATE OR REPLACE FUNCTION public.request_song(
  p_room_id UUID,
  p_video_id TEXT,
  p_title TEXT,
  p_artist TEXT,
  p_album_art TEXT,
  p_session_id UUID,
  p_display_name TEXT
) RETURNS JSONB AS $$
DECLARE
  v_active_count INT;
  v_total_queue INT;
  v_new_id UUID;
  v_is_room_valid BOOLEAN;
  v_clean_vid TEXT := trim(COALESCE(p_video_id, ''));
BEGIN
  IF v_clean_vid !~ '^[a-zA-Z0-9_-]{11}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid YouTube Video ID format.');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.rooms WHERE id = p_room_id AND expires_at > now() AND is_active = true
  ) INTO v_is_room_valid;

  IF NOT v_is_room_valid THEN
    RETURN jsonb_build_object('success', false, 'error', 'This room has expired or is inactive.');
  END IF;

  SELECT count(*) INTO v_total_queue FROM public.room_queue WHERE room_id = p_room_id AND status = 'queued';
  IF v_total_queue >= 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room queue is currently full (Maximum 50 songs).');
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.room_queue
  WHERE room_id = p_room_id
    AND requested_by_session = p_session_id
    AND status = 'queued';

  IF v_active_count >= 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have 3 songs in the queue. Wait for one to play!');
  END IF;

  INSERT INTO public.room_queue (
    room_id, video_id, title, artist, album_art, requested_by_session, requested_by_name, vote_count, status
  )
  VALUES (
    p_room_id, v_clean_vid,
    substr(trim(COALESCE(p_title, 'Untitled')), 1, 200),
    substr(trim(COALESCE(p_artist, 'YouTube Request')), 1, 100),
    substr(trim(COALESCE(p_album_art, '')), 1, 500),
    p_session_id, substr(trim(COALESCE(p_display_name, 'Guest')), 1, 50), 1, 'queued'
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.queue_votes (queue_id, session_id)
  VALUES (v_new_id, p_session_id)
  ON CONFLICT DO NOTHING;

  PERFORM realtime.publish('room:' || p_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'added', 'id', v_new_id));

  RETURN jsonb_build_object('success', true, 'queue_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ---- update_queue_status: whitelist + host check ----
CREATE OR REPLACE FUNCTION public.update_queue_status(
  p_queue_id UUID,
  p_status TEXT
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_host_id UUID;
BEGIN
  IF p_status NOT IN ('queued', 'playing', 'played', 'rejected') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid queue status.');
  END IF;

  SELECT q.room_id, r.host_id INTO v_room_id, v_host_id
  FROM public.room_queue q
  JOIN public.rooms r ON r.id = q.room_id
  WHERE q.id = p_queue_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Track not found.');
  END IF;

  IF v_host_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only the room host can moderate the queue.');
  END IF;

  UPDATE public.room_queue SET status = p_status, updated_at = now() WHERE id = p_queue_id;

  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'status', 'id', p_queue_id, 'status', p_status));

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ---- toggle_upvote_song: atomic recount ----
CREATE OR REPLACE FUNCTION public.toggle_upvote_song(
  p_queue_id UUID,
  p_session_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_has_voted BOOLEAN;
  v_new_votes INT;
BEGIN
  SELECT room_id INTO v_room_id FROM public.room_queue WHERE id = p_queue_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Track not found in queue.');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id
  ) INTO v_has_voted;

  IF v_has_voted THEN
    DELETE FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id;
  ELSE
    INSERT INTO public.queue_votes (queue_id, session_id) VALUES (p_queue_id, p_session_id);
  END IF;

  SELECT count(*) INTO v_new_votes FROM public.queue_votes WHERE queue_id = p_queue_id;
  UPDATE public.room_queue SET vote_count = v_new_votes, updated_at = now() WHERE id = p_queue_id;

  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'vote', 'id', p_queue_id, 'votes', v_new_votes));

  RETURN jsonb_build_object('success', true, 'votes', v_new_votes, 'voted', NOT v_has_voted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- §4. C3 — Member tokens: join mints, ping/leave require
-- ============================================================
CREATE OR REPLACE FUNCTION public.join_room_secure(
  p_code TEXT,
  p_session_id UUID,
  p_display_name TEXT,
  p_password TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
  v_hash TEXT;
  v_count INT;
  v_role TEXT := 'listener';
  v_token VARCHAR(64);
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE UPPER(code) = UPPER(trim(p_code)) AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room not found or inactive.');
  END IF;

  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Incorrect password for this private room.');
    END IF;
  END IF;

  DELETE FROM public.room_members
  WHERE room_id = v_room.id AND last_seen < now() - interval '45 seconds';

  PERFORM 1 FROM public.rooms WHERE id = v_room.id FOR UPDATE;

  SELECT count(*) INTO v_count FROM public.room_members WHERE room_id = v_room.id;

  IF NOT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = v_room.id AND session_id = p_session_id) THEN
    IF v_count >= v_room.max_members THEN
      RETURN jsonb_build_object('success', false, 'error', 'Room is currently full (Maximum 5 listeners).');
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = v_room.host_id THEN
    v_role := 'host';
  END IF;

  v_token := encode(gen_random_bytes(24), 'hex');

  INSERT INTO public.room_members (room_id, user_id, session_id, display_name, role, member_token, last_seen)
  VALUES (v_room.id, auth.uid(), p_session_id, substr(trim(COALESCE(p_display_name, 'Guest')), 1, 50), v_role, v_token, now())
  ON CONFLICT (room_id, session_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      member_token = v_token,
      last_seen = now();

  RETURN jsonb_build_object(
    'success', true,
    'member_token', v_token,
    'room', jsonb_build_object(
      'id', v_room.id,
      'code', v_room.code,
      'name', v_room.name,
      'is_private', v_room.is_private,
      'host_id', v_room.host_id,
      'role', v_role
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- DEFAULT NULL keeps old 2-arg calls compiling but fail-closed (NULL matches nothing).
CREATE OR REPLACE FUNCTION public.ping_room_presence(
  p_room_id UUID,
  p_session_id UUID,
  p_member_token TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  UPDATE public.room_members
  SET last_seen = now()
  WHERE room_id = p_room_id
    AND session_id = p_session_id
    AND (member_token = p_member_token OR (user_id IS NOT NULL AND user_id = (SELECT auth.uid())));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.leave_room(
  p_room_id UUID,
  p_session_id UUID,
  p_member_token TEXT DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  DELETE FROM public.room_members
  WHERE room_id = p_room_id
    AND session_id = p_session_id
    AND (member_token = p_member_token OR (user_id IS NOT NULL AND user_id = (SELECT auth.uid())));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- get_active_room_members keeps its shape (no token column — token never listed).
CREATE OR REPLACE FUNCTION public.get_active_room_members(p_room_id UUID)
RETURNS TABLE (
  session_id UUID,
  display_name VARCHAR(50),
  role VARCHAR(20),
  joined_at TIMESTAMPTZ,
  is_active BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.session_id,
    m.display_name,
    m.role,
    m.joined_at,
    (m.last_seen > now() - interval '45 seconds') AS is_active
  FROM public.room_members m
  WHERE m.room_id = p_room_id
    AND m.last_seen > now() - interval '45 seconds'
  ORDER BY m.joined_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- §5. H2 — Host handover via RPC (replaces direct UPDATE policy)
-- ============================================================
DROP POLICY IF EXISTS "claim abandoned room" ON public.rooms;

CREATE OR REPLACE FUNCTION public.claim_abandoned_room(
  p_room_id UUID,
  p_password TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
  v_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Must be signed in to claim host.');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room not found.');
  END IF;

  IF v_room.host_last_seen IS NOT NULL AND v_room.host_last_seen > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Current host is still active.');
  END IF;

  IF v_room.is_private THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Incorrect room password.');
    END IF;
  END IF;

  UPDATE public.rooms
  SET host_id = auth.uid(),
      host_last_seen = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- §6. Pin search_path on remaining SECURITY DEFINER functions
-- (keeps EXECUTE grants as-is for InsForge RPC; InsForge needs anon/authenticated
-- execute on join/ping/leave/request/toggle/purge — revoke is follow-up with dashboard test)
-- ============================================================
ALTER FUNCTION public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.purge_expired_rooms() SET search_path = public, pg_temp;
ALTER FUNCTION public.broadcast_playback_state() SET search_path = public, pg_temp;
ALTER FUNCTION public.protect_chat_display_name() SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_unique_room_code() SET search_path = public, pg_temp;
ALTER FUNCTION public.get_server_time() SET search_path = public, pg_temp;
