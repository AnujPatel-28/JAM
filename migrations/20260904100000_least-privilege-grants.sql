-- Migration: Least-privilege EXECUTE, members-RPC auth, secrets hardening
-- (audit 022, Phase 1 items 4+6)
--
-- WHY:
--   (a) Postgres grants EXECUTE to PUBLIC by default and this repo never
--       revoked it — anon could call purge_expired_rooms() (verified live:
--       anon → 200) and every pg_sleep failure path (pool-hold DoS).
--   (b) get_active_room_members() had no auth check — private-room presence
--       enumerable by UUID (verified in SQL text).
--   (c) Legacy insecure overloads (leave/ping 2-arg, request 7-arg, toggle
--       2-arg) are STILL callable live (verified: 2-arg ping → 204), i.e.
--       20260903800000 never applied — C3 regression. Re-dropped here so 041
--       is self-sufficient regardless of 038.
--   (d) room_members.member_token is API-readable on public rooms (credential
--       theft → vote/ping as victim). room_secrets has REVOKE but no RLS.
-- WHAT:
--   1. Re-drop legacy overloads (idempotent).
--   2. get_active_room_members gains p_member_token: public rooms stay open;
--      private rooms require host, valid token, or own-row ownership.
--   3. REVOKE ALL FROM PUBLIC (+anon/authenticated where noted) then
--      least-privilege GRANTs. purge_expired_rooms: authenticated only PLUS
--      60s internal throttle (spam bound even for authed callers).
--   4. REVOKE SELECT(member_token) on room_members from anon/authenticated
--      (column is only ever consumed via join RPC return value).
--   5. ENABLE RLS on room_secrets (no policies = deny-all defence in depth;
--      SECURITY DEFINER RPCs run as owner and are unaffected).
--   6. Drop the superseded protect_chat_display_name() (trigger moved to
--      enforce_display_name in 039).
-- ROLLBACK: re-GRANT EXECUTE … TO anon, authenticated per function;
--   re-apply get_active_room_members from 20260903300000.
-- VERIFY: anon purge → 42501; 2-arg ping → 42883 (undefined function);
--   anon members-list on private room → empty; SELECT member_token via API → denied.

-- 1. Legacy overloads (re-drop; harmless if 038 already applied).
DROP FUNCTION IF EXISTS public.leave_room(UUID, UUID);
DROP FUNCTION IF EXISTS public.ping_room_presence(UUID, UUID);
DROP FUNCTION IF EXISTS public.request_song(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.toggle_upvote_song(UUID, UUID);

-- 2. Members list with private-room gate.
-- NOTE: new (UUID, TEXT) signature is a DISTINCT overload from the old (UUID)
-- one, so the old must be dropped first (same lesson as 038) — else PostgREST
-- reports PGRST203 ambiguous.
DROP FUNCTION IF EXISTS public.get_active_room_members(UUID);
CREATE OR REPLACE FUNCTION public.get_active_room_members(
  p_room_id UUID,
  p_member_token TEXT DEFAULT NULL
) RETURNS TABLE (
  session_id UUID,
  display_name VARCHAR(50),
  role VARCHAR(20),
  joined_at TIMESTAMPTZ,
  is_active BOOLEAN
) AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Private rooms: host, valid recent token, or own row — else empty.
  -- Public rooms stay open (lobby occupancy + guest UI need it).
  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.room_members m
      WHERE m.room_id = p_room_id
        AND m.last_seen > now() - interval '45 seconds'
        AND (
          m.member_token = p_member_token
          OR (m.user_id IS NOT NULL AND m.user_id = auth.uid())
        )
    ) THEN
      RETURN;
    END IF;
  END IF;

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

-- 3. Purge throttle (spam bound) + least-privilege EXECUTE grants.
CREATE TABLE IF NOT EXISTS public.maintenance_runs (
  name TEXT PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.purge_expired_rooms()
RETURNS INT AS $$
DECLARE
  v_last TIMESTAMPTZ;
  v_deleted INT := 0;
BEGIN
  -- Max once per 60s no matter who calls (lobby already throttles client-side).
  -- NOTE: return type stays INT (original signature) — CREATE OR REPLACE
  -- cannot change it; throttled calls return 0.
  SELECT ran_at INTO v_last FROM public.maintenance_runs WHERE name = 'purge_expired_rooms';
  IF v_last IS NOT NULL AND v_last > now() - interval '60 seconds' THEN
    RETURN 0;
  END IF;
  INSERT INTO public.maintenance_runs (name, ran_at)
  VALUES ('purge_expired_rooms', now())
  ON CONFLICT (name) DO UPDATE SET ran_at = now();

  DELETE FROM public.rooms WHERE expires_at <= now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON TABLE public.maintenance_runs FROM PUBLIC, anon, authenticated;

-- Strip default PUBLIC execute, then grant least privilege.
REVOKE ALL ON FUNCTION public.join_room_secure(TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_room_secure(TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.ping_room_presence(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ping_room_presence(UUID, UUID, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.leave_room(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.leave_room(UUID, UUID, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_active_room_members(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_room_members(UUID, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.request_song(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_song(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.toggle_upvote_song(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_upvote_song(UUID, UUID, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.post_chat(UUID, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_chat(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_server_time() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_server_time() TO anon, authenticated;

-- Host-gated inside the body; only signed-in users can be hosts.
REVOKE ALL ON FUNCTION public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.update_queue_status(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_queue_status(UUID, TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.claim_abandoned_room(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_abandoned_room(UUID, TEXT) TO authenticated;

-- Purge: authenticated only (anon lobby visits simply skip it; client already
-- try/catches). Service/cron keys run as owner and bypass grants anyway.
REVOKE ALL ON FUNCTION public.purge_expired_rooms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_rooms() TO authenticated;

-- Trigger-only helpers: not callable by clients at all.
REVOKE ALL ON FUNCTION public.broadcast_playback_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_display_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.normalize_display_name(TEXT) FROM PUBLIC, anon, authenticated;

-- 4. Member tokens never leave via table API (only via join RPC return).
REVOKE SELECT (member_token) ON public.room_members FROM anon, authenticated;

-- 5. Defence in depth on secrets (REVOKE already exists since day one).
ALTER TABLE public.room_secrets ENABLE ROW LEVEL SECURITY;

-- 6. Remove superseded trigger function (039 replaced it; 039's DROP used a
-- wrong trigger name on first apply, so drop the real one here too).
DROP TRIGGER IF EXISTS chat_messages_protect_display_name ON public.chat_messages;
DROP FUNCTION IF EXISTS public.protect_chat_display_name();
