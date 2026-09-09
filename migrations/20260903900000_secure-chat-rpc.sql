-- Migration: Secure chat via post_chat RPC (audit 022, Phase 1 item 2)
--
-- WHY: chat_messages INSERT was open (WITH CHECK room_id NOT NULL only), so
--   anyone with a leaked room_id could spam a PRIVATE room's chat without
--   joining, and forge any user_name/user_id. Queue RPCs are token-gated;
--   chat was explicitly deferred (20260903600000:132-136). Closing it now.
-- WHAT:
--   1. Adds chat_messages.session_id (nullable, abuse control; old rows NULL).
--   2. New post_chat() RPC: room active+unexpired check, private rooms require
--      presence proof (member_token+session, recent) or host, 500/50 caps,
--      control-char strip, reserved-name forcing, per-session throttle
--      (10/min), server-side realtime fan-out (with client_id for dedupe).
--   3. REVOKEs direct INSERT on chat_messages from anon/authenticated.
--      (Trigger protect_chat_display_name still fires; SECURITY DEFINER RPC
--      bypasses RLS by design. Reads unchanged.)
--   4. Expands reserved display names to room_members + room_queue via trigger
--      (previously chat-only, exact-match only).
-- ROLLBACK: GRANT INSERT ON public.chat_messages TO anon, authenticated;
--   DROP FUNCTION public.post_chat(UUID,TEXT,TEXT,UUID,TEXT,TEXT);
--   frontend reverts to direct insert (useChatMessages).
-- VERIFY (after apply): anon direct insert → 42501/RLS deny;
--   post_chat without token on private room → 'Join the room…';
--   11th message within 60s → throttled.
-- NOTE: realtime chat publish moves server-side (see 040); frontend must call
--   post_chat (Phase 2 code change) in the same deploy.

-- 1. Session column for abuse control (additive, nullable).
ALTER TABLE public.chat_messages
  ADD COLUMN IF NOT EXISTS session_id UUID;

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_recent
  ON public.chat_messages(room_id, session_id, created_at DESC);

-- 2. Shared reserved-name fold (server-side; mirrors src/lib/displayName.ts
-- intent: block staff-impersonating names on every stored-name table).
CREATE OR REPLACE FUNCTION public.normalize_display_name(p_name TEXT)
RETURNS TEXT AS $$
DECLARE
  v_clean TEXT := substr(trim(COALESCE(p_name, '')), 1, 50);
  v_fold TEXT;
BEGIN
  IF v_clean = '' THEN
    RETURN 'Guest';
  END IF;
  -- Fold: lowercase, drop spaces/underscores/dashes (catches 'Host ',
  -- 'H O S T', 'Ad_min'). Full leet-fold stays client-side (displayName.ts).
  v_fold := lower(regexp_replace(v_clean, '[\s_\-]+', '', 'g'));
  IF v_fold IN ('host', 'admin', 'administrator', 'moderator', 'mod',
                'support', 'system', 'owner', 'wifi', 'wifijokey', 'dj') THEN
    RETURN 'Guest';
  END IF;
  -- Strip control characters (layout/terminal abuse), keep printable text.
  RETURN regexp_replace(v_clean, '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g');
END;
$$ LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp;

-- Apply to chat_messages (replaces narrow protect_chat_display_name trigger).
CREATE OR REPLACE FUNCTION public.enforce_display_name()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'chat_messages' THEN
    NEW.user_name := public.normalize_display_name(NEW.user_name);
  ELSIF TG_TABLE_NAME = 'room_members' THEN
    NEW.display_name := public.normalize_display_name(NEW.display_name);
  ELSIF TG_TABLE_NAME = 'room_queue' THEN
    NEW.requested_by_name := public.normalize_display_name(NEW.requested_by_name);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trg_protect_chat_display_name ON public.chat_messages;
DROP TRIGGER IF EXISTS chat_messages_protect_display_name ON public.chat_messages;
DROP TRIGGER IF EXISTS trg_enforce_display_name_chat ON public.chat_messages;
CREATE TRIGGER trg_enforce_display_name_chat
  BEFORE INSERT OR UPDATE OF user_name ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_display_name();

DROP TRIGGER IF EXISTS trg_enforce_display_name_members ON public.room_members;
CREATE TRIGGER trg_enforce_display_name_members
  BEFORE INSERT OR UPDATE OF display_name ON public.room_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_display_name();

DROP TRIGGER IF EXISTS trg_enforce_display_name_queue ON public.room_queue;
CREATE TRIGGER trg_enforce_display_name_queue
  BEFORE INSERT OR UPDATE OF requested_by_name ON public.room_queue
  FOR EACH ROW EXECUTE FUNCTION public.enforce_display_name();

-- 3. The secure chat RPC.
CREATE OR REPLACE FUNCTION public.post_chat(
  p_room_id UUID,
  p_message TEXT,
  p_user_name TEXT,
  p_session_id UUID,
  p_member_token TEXT DEFAULT NULL,
  p_client_id TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
  v_clean_msg TEXT;
  v_clean_name TEXT;
  v_recent_count INT;
  v_new_id UUID;
  v_uid UUID := auth.uid();
BEGIN
  SELECT * INTO v_room FROM public.rooms
  WHERE id = p_room_id AND expires_at > now() AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'This room has expired or is inactive.');
  END IF;

  -- Private rooms: prove presence (recent member_token+session) or be host.
  -- Public rooms stay open (lobby visitors can chat).
  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM v_uid THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.room_members m
      WHERE m.room_id = p_room_id
        AND m.session_id = p_session_id
        AND m.member_token = p_member_token
        AND m.last_seen > now() - interval '45 seconds'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Join the room before chatting.');
    END IF;
  END IF;

  v_clean_msg := regexp_replace(trim(COALESCE(p_message, '')), '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g');
  IF char_length(v_clean_msg) NOT BETWEEN 1 AND 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Message must be 1–500 characters.');
  END IF;

  -- Per-session throttle: 10 messages/minute/room (spam barrier).
  SELECT count(*) INTO v_recent_count FROM public.chat_messages
  WHERE room_id = p_room_id
    AND session_id = p_session_id
    AND created_at > now() - interval '1 minute';
  IF v_recent_count >= 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You are sending messages too quickly. Slow down.');
  END IF;

  v_clean_name := public.normalize_display_name(p_user_name);

  INSERT INTO public.chat_messages (room_id, user_id, user_name, message, session_id)
  VALUES (p_room_id, v_uid, v_clean_name, v_clean_msg, p_session_id)
  RETURNING id INTO v_new_id;

  -- Server-side fan-out (clients subscribe; no direct publish needed).
  PERFORM realtime.publish(
    'room:' || p_room_id || ':chat',
    'message',
    jsonb_build_object(
      'id', v_new_id,
      'room_id', p_room_id,
      'user_id', v_uid,
      'user_name', v_clean_name,
      'message', v_clean_msg,
      'session_id', p_session_id,
      'client_id', p_client_id,
      'created_at', now()
    )
  );

  RETURN jsonb_build_object('success', true, 'id', v_new_id, 'user_name', v_clean_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 4. Close direct INSERT (reads + trigger behavior unchanged).
REVOKE ALL ON FUNCTION public.post_chat(UUID, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_chat(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

REVOKE INSERT ON public.chat_messages FROM anon, authenticated;
