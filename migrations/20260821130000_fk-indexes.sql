-- Index the room_id foreign keys so ON DELETE CASCADE doesn't require
-- full table scans (locks all writes during delete) per advisor finding.

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_id ON public.chat_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_song_requests_room_id ON public.song_requests(room_id);
