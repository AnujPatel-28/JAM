-- Server-enforced host playback sync.
--
-- Publishing to a realtime channel is not permission-gated on this backend,
-- so anyone could forge 'player_sync' broadcasts. Instead the HOST writes
-- playback state into its own rooms row -- protected by the existing RLS
-- policy (only host_id = auth.uid() may update) -- and this trigger relays
-- it onto the player_sync channel for listeners.

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS playback_state JSONB;

CREATE OR REPLACE FUNCTION public.broadcast_playback_state()
RETURNS trigger AS $$
BEGIN
  IF NEW.playback_state IS DISTINCT FROM OLD.playback_state THEN
    PERFORM realtime.publish('player_sync', 'sync', NEW.playback_state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS rooms_playback_broadcast ON public.rooms;

CREATE TRIGGER rooms_playback_broadcast
AFTER UPDATE OF playback_state ON public.rooms
FOR EACH ROW EXECUTE FUNCTION public.broadcast_playback_state();
