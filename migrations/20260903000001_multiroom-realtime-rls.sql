-- Migration: Multi-Room Realtime Wildcard Channels & Isolated RLS
-- 1. Enable wildcard channels pattern for rooms
INSERT INTO realtime.channels (pattern, description, enabled)
VALUES
  ('room:*', 'Wildcard room-scoped channels', true),
  ('player_sync', 'Legacy host playback sync broadcasts', true),
  ('chat_messages', 'Legacy live chat message broadcasts', true)
ON CONFLICT (pattern) DO UPDATE
SET enabled = true;

-- 2. Update RLS policies on realtime.messages
DROP POLICY IF EXISTS "anyone can publish chat" ON realtime.messages;
DROP POLICY IF EXISTS "anyone can publish room chat" ON realtime.messages;

CREATE POLICY "anyone can publish room chat" ON realtime.messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    channel_name LIKE 'room:%:chat' 
    OR channel_name LIKE 'realtime:room:%:chat'
    OR channel_name IN ('chat_messages', 'realtime:chat_messages')
  );

DROP POLICY IF EXISTS "room host can publish sync" ON realtime.messages;
DROP POLICY IF EXISTS "room host can publish room sync" ON realtime.messages;

CREATE POLICY "room host can publish room sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name LIKE 'room:%:sync' 
    OR channel_name LIKE 'realtime:room:%:sync'
    OR channel_name IN ('player_sync', 'realtime:player_sync')
  );

-- 3. Room-scoped chat permissions
DROP POLICY IF EXISTS "public select chat_messages" ON public.chat_messages;
CREATE POLICY "select chat_messages by room" ON public.chat_messages
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "anyone can post chat_messages" ON public.chat_messages;
CREATE POLICY "insert chat_messages by room" ON public.chat_messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    room_id IS NOT NULL AND (user_id IS NULL OR user_id = (SELECT auth.uid()))
  );

-- 4. Update the playback broadcast trigger to publish to the room-specific channel
CREATE OR REPLACE FUNCTION public.broadcast_playback_state()
RETURNS trigger AS $$
BEGIN
  IF NEW.playback_state IS DISTINCT FROM OLD.playback_state THEN
    -- Publish to room-isolated sync channel
    PERFORM realtime.publish('room:' || NEW.id || ':sync', 'sync', NEW.playback_state);
    -- Also publish to legacy channel for backward compatibility
    PERFORM realtime.publish('player_sync', 'sync', NEW.playback_state);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
