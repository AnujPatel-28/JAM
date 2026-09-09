-- Migration: Password hardening (H3) — stronger hashes for NEW rooms + spray throttle
-- SCOPE: code + SQL files only, not applied. Existing 3-char rooms keep working
-- (crypt verifies regardless of cost); only new private rooms require 8+.
-- ROLLBACK: re-apply create_room_secure/join_room_secure/claim_abandoned_room from
-- 20260903000000_multiroom-core.sql and 20260903300000_security-hardening.sql.

-- New private rooms: min 8 chars, bcrypt cost 12 (was 3 / cost 8).
CREATE OR REPLACE FUNCTION public.create_room_secure(
  p_name TEXT,
  p_is_private BOOLEAN DEFAULT false,
  p_password TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_code TEXT;
  v_host_id UUID := auth.uid();
BEGIN
  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to create a room.';
  END IF;

  IF p_name IS NULL OR char_length(trim(p_name)) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Room name must be 1–60 characters.';
  END IF;

  IF p_description IS NOT NULL AND char_length(p_description) > 200 THEN
    RAISE EXCEPTION 'Description must be at most 200 characters.';
  END IF;

  IF p_is_private AND (p_password IS NULL OR char_length(trim(p_password)) < 8) THEN
    RAISE EXCEPTION 'Private rooms require a password with at least 8 characters.';
  END IF;

  v_code := public.generate_unique_room_code();

  INSERT INTO public.rooms (name, host_id, code, is_private, max_members, description, host_last_seen)
  VALUES (substr(trim(p_name), 1, 60), v_host_id, v_code, p_is_private, 5, substr(trim(COALESCE(p_description, '')), 1, 200), now())
  RETURNING id INTO v_room_id;

  IF p_is_private THEN
    INSERT INTO public.room_secrets (room_id, password_hash)
    VALUES (v_room_id, crypt(trim(p_password), gen_salt('bf', 12)));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'room_id', v_room_id,
    'code', v_code,
    'name', p_name,
    'is_private', p_is_private
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- join_room_secure: same C3 token logic as 20260903300000, plus pg_sleep(1) on
-- every failure path as a cheap online-spray throttle. Error strings unchanged
-- (frontend branches on includes('password'/'full')) — the delay, not secrecy
-- of the strings, is the mitigation; documented oracle accepted.
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
    PERFORM pg_sleep(1);
    RETURN jsonb_build_object('success', false, 'error', 'Room not found or inactive.');
  END IF;

  IF char_length(trim(COALESCE(p_display_name, ''))) NOT BETWEEN 1 AND 24 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Display name must be 1–24 characters.');
  END IF;

  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      PERFORM pg_sleep(1);
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

-- claim_abandoned_room: same as 20260903300000 plus failure delay.
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
    PERFORM pg_sleep(1);
    RETURN jsonb_build_object('success', false, 'error', 'Room not found.');
  END IF;

  IF v_room.host_last_seen IS NOT NULL AND v_room.host_last_seen > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Current host is still active.');
  END IF;

  IF v_room.is_private THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      PERFORM pg_sleep(1);
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
