-- Migration: 24-Hour Ephemeral Rooms & Collaborative Song Queue
-- 1. Add 24-Hour Expiration to rooms
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours');

CREATE INDEX IF NOT EXISTS idx_rooms_expires_at ON public.rooms(expires_at);

-- Backfill any existing rooms with a fresh 24h window
UPDATE public.rooms
SET expires_at = created_at + interval '24 hours'
WHERE expires_at IS NULL;

-- 2. Collaborative Song Queue Table
CREATE TABLE IF NOT EXISTS public.room_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  video_id VARCHAR(20) NOT NULL,
  title TEXT NOT NULL,
  artist TEXT DEFAULT 'YouTube Request',
  album_art TEXT,
  requested_by_name VARCHAR(50) NOT NULL,
  requested_by_session UUID NOT NULL,
  vote_count INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'queued', -- 'queued' | 'playing' | 'played' | 'rejected'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_room_queue_room_status ON public.room_queue(room_id, status, vote_count DESC, created_at ASC);

-- 3. Vote tracking table (prevents duplicate votes per user session)
CREATE TABLE IF NOT EXISTS public.queue_votes (
  queue_id UUID NOT NULL REFERENCES public.room_queue(id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, session_id)
);

-- Enable RLS
ALTER TABLE public.room_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_votes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anyone can view room_queue" ON public.room_queue
  FOR SELECT TO anon, authenticated USING (true);

CREATE POLICY "anyone can view queue_votes" ON public.queue_votes
  FOR SELECT TO anon, authenticated USING (true);

-- 4. Atomic Song Request RPC Function (with rate-limiting)
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
  v_new_id UUID;
  v_is_room_valid BOOLEAN;
BEGIN
  -- Verify room is alive and not expired
  SELECT EXISTS(
    SELECT 1 FROM public.rooms WHERE id = p_room_id AND expires_at > now() AND is_active = true
  ) INTO v_is_room_valid;

  IF NOT v_is_room_valid THEN
    RETURN jsonb_build_object('success', false, 'error', 'This room has expired or is inactive.');
  END IF;

  -- Rate limit: Maximum 3 active queued songs per session
  SELECT count(*) INTO v_active_count 
  FROM public.room_queue 
  WHERE room_id = p_room_id 
    AND requested_by_session = p_session_id 
    AND status = 'queued';

  IF v_active_count >= 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have 3 songs in the queue. Wait for one to play!');
  END IF;

  -- Insert song request
  INSERT INTO public.room_queue (
    room_id, video_id, title, artist, album_art, requested_by_session, requested_by_name, vote_count, status
  )
  VALUES (
    p_room_id, trim(p_video_id), trim(p_title), trim(p_artist), trim(p_album_art), p_session_id, trim(p_display_name), 1, 'queued'
  )
  RETURNING id INTO v_new_id;

  -- Seed initial upvote from requester
  INSERT INTO public.queue_votes (queue_id, session_id)
  VALUES (v_new_id, p_session_id)
  ON CONFLICT DO NOTHING;

  -- Broadcast queue update event
  PERFORM realtime.publish('room:' || p_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'added', 'id', v_new_id));

  RETURN jsonb_build_object('success', true, 'queue_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Atomic Upvote Song Function
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
    RETURN jsonb_build_object('success', false, 'error', 'Song request not found.');
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id) INTO v_has_voted;

  IF v_has_voted THEN
    -- Remove vote (toggle off)
    DELETE FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id;
    UPDATE public.room_queue SET vote_count = GREATEST(1, vote_count - 1) WHERE id = p_queue_id RETURNING vote_count INTO v_new_votes;
  ELSE
    -- Add vote
    INSERT INTO public.queue_votes (queue_id, session_id) VALUES (p_queue_id, p_session_id);
    UPDATE public.room_queue SET vote_count = vote_count + 1 WHERE id = p_queue_id RETURNING vote_count INTO v_new_votes;
  END IF;

  -- Broadcast queue update
  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'vote', 'id', p_queue_id, 'votes', v_new_votes));

  RETURN jsonb_build_object('success', true, 'votes', v_new_votes, 'voted', NOT v_has_voted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Update Song Status (Host Only)
CREATE OR REPLACE FUNCTION public.update_queue_status(
  p_queue_id UUID,
  p_status TEXT
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_host_id UUID;
BEGIN
  SELECT q.room_id, r.host_id INTO v_room_id, v_host_id
  FROM public.room_queue q
  JOIN public.rooms r ON r.id = q.room_id
  WHERE q.id = p_queue_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Track not found.');
  END IF;

  -- Host verification
  IF v_host_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only the room host can moderate the queue.');
  END IF;

  UPDATE public.room_queue SET status = p_status WHERE id = p_queue_id;

  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'status', 'id', p_queue_id, 'status', p_status));

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Purge Expired Rooms Function (Deletes rooms older than 24 hours, triggers CASCADE)
CREATE OR REPLACE FUNCTION public.purge_expired_rooms()
RETURNS INT AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM public.rooms WHERE expires_at < now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
