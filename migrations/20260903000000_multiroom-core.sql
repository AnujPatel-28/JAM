-- Migration: Multi-Room Core Schema & Secure Capacity Engine
-- 1. Enable pgcrypto for password hashing & code generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Drop the restrictive global name constraint
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_name_key;

-- 3. Enhance rooms table
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS code VARCHAR(8),
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_members INT NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Create unique index on room code (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_code_upper ON public.rooms(UPPER(code));

-- Backfill any existing rooms (e.g. 'main') with a code if null
UPDATE public.rooms
SET code = 'MAIN01'
WHERE code IS NULL AND name = 'main';

-- 4. Isolated room secrets table (Zero client access)
CREATE TABLE IF NOT EXISTS public.room_secrets (
  room_id UUID PRIMARY KEY REFERENCES public.rooms(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deny direct access to secrets from client roles
REVOKE ALL ON public.room_secrets FROM anon, authenticated;

-- 5. Active room members table (Enforces 5-person limit)
CREATE TABLE IF NOT EXISTS public.room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  display_name VARCHAR(50) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'listener', -- 'host' | 'listener'
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_room_member UNIQUE(room_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_room_members_room ON public.room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_active ON public.room_members(room_id, last_seen);

-- Enable RLS on room_members
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can view room occupants" ON public.room_members
  FOR SELECT TO anon, authenticated
  USING (true);

-- 6. Partition chat_messages and song_requests by room_id
CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created ON public.chat_messages(room_id, created_at DESC);

-- 7. Random human-readable room code generator (excludes easily confused characters)
CREATE OR REPLACE FUNCTION public.generate_unique_room_code()
RETURNS TEXT AS $$
DECLARE
  v_code TEXT;
  v_exists BOOLEAN;
  v_chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i INT;
BEGIN
  LOOP
    v_code := '';
    FOR i IN 1..6 LOOP
      v_code := v_code || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
    END LOOP;
    
    SELECT EXISTS(SELECT 1 FROM public.rooms WHERE UPPER(code) = v_code) INTO v_exists;
    IF NOT v_exists THEN
      RETURN v_code;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 8. Atomic Room Creation Function
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

  IF p_is_private AND (p_password IS NULL OR length(trim(p_password)) < 3) THEN
    RAISE EXCEPTION 'Private rooms require a password with at least 3 characters.';
  END IF;

  v_code := public.generate_unique_room_code();

  INSERT INTO public.rooms (name, host_id, code, is_private, max_members, description, host_last_seen)
  VALUES (p_name, v_host_id, v_code, p_is_private, 5, p_description, now())
  RETURNING id INTO v_room_id;

  -- Store password hash securely if private
  IF p_is_private THEN
    INSERT INTO public.room_secrets (room_id, password_hash)
    VALUES (v_room_id, crypt(trim(p_password), gen_salt('bf', 8)));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'room_id', v_room_id,
    'code', v_code,
    'name', p_name,
    'is_private', p_is_private
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Atomic Join & Capacity Enforcement Function
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
BEGIN
  -- 1. Find room by code
  SELECT * INTO v_room FROM public.rooms WHERE UPPER(code) = UPPER(trim(p_code)) AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room not found or inactive.');
  END IF;

  -- 2. Check password if private
  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Incorrect password for this private room.');
    END IF;
  END IF;

  -- 3. Prune stale members (heartbeat timed out > 45 seconds ago)
  DELETE FROM public.room_members
  WHERE room_id = v_room.id AND last_seen < now() - interval '45 seconds';

  -- 4. Check active member count (Lock the room row to avoid race condition)
  PERFORM 1 FROM public.rooms WHERE id = v_room.id FOR UPDATE;

  SELECT count(*) INTO v_count FROM public.room_members WHERE room_id = v_room.id;

  -- If user is rejoining with their same session_id, allow them in even if count is 5
  IF NOT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = v_room.id AND session_id = p_session_id) THEN
    IF v_count >= v_room.max_members THEN
      RETURN jsonb_build_object('success', false, 'error', 'Room is currently full (Maximum 5 listeners).');
    END IF;
  END IF;

  -- Determine role
  IF auth.uid() IS NOT NULL AND auth.uid() = v_room.host_id THEN
    v_role := 'host';
  END IF;

  -- 5. Upsert membership
  INSERT INTO public.room_members (room_id, user_id, session_id, display_name, role, last_seen)
  VALUES (v_room.id, auth.uid(), p_session_id, trim(p_display_name), v_role, now())
  ON CONFLICT (room_id, session_id) DO UPDATE
  SET display_name = EXCLUDED.display_name, last_seen = now();

  RETURN jsonb_build_object(
    'success', true,
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. Heartbeat Ping Function
CREATE OR REPLACE FUNCTION public.ping_room_presence(p_room_id UUID, p_session_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.room_members
  SET last_seen = now()
  WHERE room_id = p_room_id AND session_id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. Leave Room Function
CREATE OR REPLACE FUNCTION public.leave_room(p_room_id UUID, p_session_id UUID)
RETURNS VOID AS $$
BEGIN
  DELETE FROM public.room_members
  WHERE room_id = p_room_id AND session_id = p_session_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. List Active Room Members
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
