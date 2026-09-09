-- Host handover: recover a dead room.
--
-- Problem: rooms.host_id points at whoever claimed the room first. If that
-- host closes the tab / loses power mid-party, nobody can ever become host
-- again ("room already has a different host") and the party dies.
--
-- Fix: rooms.host_last_seen records when the host was last active (written
-- by the client on every playback broadcast + a periodic heartbeat). When it
-- goes stale (>2 minutes), any AUTHENTICATED user may CLAIM the room by
-- updating host_id to themselves. Anonymous users still cannot touch rows.
--
-- The staleness check uses the DATABASE clock (now()), so client clock skew
-- cannot fake or block a claim.

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS host_last_seen TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'rooms'
      AND policyname = 'claim abandoned room'
  ) THEN
    CREATE POLICY "claim abandoned room" ON public.rooms
      FOR UPDATE TO authenticated
      -- Old row must look abandoned...
      USING (
        host_last_seen IS NULL
        OR host_last_seen < now() - interval '2 minutes'
      )
      -- ...and the claimer must take ownership themselves.
      WITH CHECK (host_id = (SELECT auth.uid()));
  END IF;
END $$;

-- Note: no GRANT changes needed — authenticated already holds UPDATE on
-- public.rooms; this only widens WHICH rows may be updated.
