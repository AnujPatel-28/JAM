-- Register the realtime channel patterns the app actually uses.
-- The SDK rejects subscriptions to channels that don't match a registered,
-- enabled pattern -- so 'player_sync' (playback sync) and 'chat_messages'
-- (live chat) must exist here or host broadcasts never reach listeners.

INSERT INTO realtime.channels (pattern, description, enabled)
VALUES
  ('player_sync', 'Host playback sync broadcasts', true),
  ('chat_messages', 'Live chat message broadcasts', true)
ON CONFLICT (pattern) DO UPDATE
SET description = EXCLUDED.description,
    enabled = EXCLUDED.enabled;
