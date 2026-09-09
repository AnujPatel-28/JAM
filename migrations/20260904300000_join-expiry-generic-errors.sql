-- Migration: Join expiry gate, generic credential errors, drop pg_sleep
-- (audit 022, Phase 1 items 7+14)
--
-- WHY:
--   (a) join_room_secure() never checked expires_at — expiry was client-clock
--       only (RoomPage), bypassable by direct RPC (verified in SQL text).
--   (b) pg_sleep(1) on every failure path holds a pooled backend per bad
--       attempt → parallel bad-password calls starve the pool (connection-hold
--       DoS). Throttling belongs at the edge/client, not inside a transaction.
--   (c) Distinct 'not found' vs 'incorrect password' vs 'full' strings let
--       attackers enumerate valid room codes without the password.
-- WHAT:
--   1. join: expires_at <= now() (or inactive) → generic error; not-found and
--      bad-password collapse to 'Invalid code or password.'; 'full' stays
--      distinct (the UI needs it for the full-room screen + retry).
--   2. Removes pg_sleep from join + claim_abandoned_room failure paths.
--      Inherent throttle remains: bcrypt cost-12 verify (~250ms) per guess +
--      client 10s/3-fail cooldown + Turnstile ticket on create. If spray is
--      observed, add Cloudflare WAF rate-limiting on the RPC path (platform).
--   3. Same signature (no overload churn): join(TEXT,UUID,TEXT,TEXT),
--      claim(UUID,TEXT).
-- ROLLBACK: re-apply both functions from 20260903400000_password-hardening.sql.
-- VERIFY: join expired room → 'Invalid code or password.'; bad password
--   responds in ~300ms (bcrypt) not ~1300ms+ (sleep); full room → distinct
--   'full' message preserved.

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
    RETURN jsonb_build_object('success', false, 'error', 'Invalid code or password.');
  END IF;

  -- Server-side expiry (was client-only and bypassable).
  IF v_room.expires_at IS NOT NULL AND v_room.expires_at <= now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid code or password.');
  END IF;

  IF char_length(trim(COALESCE(p_display_name, ''))) NOT BETWEEN 1 AND 24 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Display name must be 1–24 characters.');
  END IF;

  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    -- Generic error: valid-code enumeration via oracle is closed. bcrypt
    -- cost-12 compare (~250ms) is the remaining per-guess throttle.
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Invalid code or password.');
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
  VALUES (v_room.id, auth.uid(), p_session_id, substr(trim(p_display_name), 1, 50), v_role, v_token, now())
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
