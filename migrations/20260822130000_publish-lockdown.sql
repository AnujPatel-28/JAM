-- Server-side publish authorization (closes forged-sync / chat-spam gap).
--
-- realtime.messages RLS:
--   * chat_messages channel  -> anyone may publish (anonymous listeners chat)
--   * player_sync channel    -> ONLY the room's authenticated host
--   * everything else        -> denied
--
-- Channel name is matched both bare ('player_sync') and transport-prefixed
-- ('realtime:player_sync') so the policy holds regardless of how the server
-- stores the name.

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anyone can publish chat" ON realtime.messages;
CREATE POLICY "anyone can publish chat" ON realtime.messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    channel_name IN ('chat_messages', 'realtime:chat_messages')
  );

DROP POLICY IF EXISTS "room host can publish sync" ON realtime.messages;
CREATE POLICY "room host can publish sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name IN ('player_sync', 'realtime:player_sync')
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.host_id = (SELECT auth.uid())
    )
  );

-- Rollback (if needed):
--   DROP POLICY "anyone can publish chat" ON realtime.messages;
--   DROP POLICY "room host can publish sync" ON realtime.messages;
--   ALTER TABLE realtime.messages DISABLE ROW LEVEL SECURITY;
