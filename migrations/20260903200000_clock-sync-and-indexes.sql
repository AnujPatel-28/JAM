-- Migration: Microsecond Clock Sync, Index Hardening & Trigger Clean-up

-- 1. Microsecond-accurate server timestamp for Cristian's Algorithm
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ AS $$
  SELECT clock_timestamp();
$$ LANGUAGE sql STABLE SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.get_server_time() TO PUBLIC;

-- 2. Clean up trigger: Remove legacy player_sync fallback
CREATE OR REPLACE FUNCTION public.broadcast_playback_state()
RETURNS trigger AS $$
BEGIN
  IF NEW.playback_state IS DISTINCT FROM OLD.playback_state THEN
    -- Publish ONLY to room-isolated channel
    PERFORM realtime.publish('room:' || NEW.id || ':sync', 'sync', NEW.playback_state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Missing FK and Query Indexes
CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON public.room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_room_queue_rate_limit ON public.room_queue(room_id, requested_by_session, status);

-- 4. Clean up any orphaned chat messages with null room_id before setting NOT NULL
DELETE FROM public.chat_messages WHERE room_id IS NULL;
ALTER TABLE public.chat_messages ALTER COLUMN room_id SET NOT NULL;
