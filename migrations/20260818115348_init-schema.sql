-- Enable UUID extension if not present
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Create rooms table
CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    host_id TEXT NOT NULL,
    current_song TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Create chat_messages table
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT,
    user_name TEXT,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create song_requests table
CREATE TABLE IF NOT EXISTS song_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT,
    provider_song_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Realtime replication identity for tables
ALTER TABLE rooms REPLICA IDENTITY FULL;
ALTER TABLE chat_messages REPLICA IDENTITY FULL;
ALTER TABLE song_requests REPLICA IDENTITY FULL;

-- Ensure supabase_realtime and insforge_realtime publications exist and include the tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'insforge_realtime') THEN
    CREATE PUBLICATION insforge_realtime;
  END IF;
END $$;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE rooms, chat_messages, song_requests;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
  BEGIN
    ALTER PUBLICATION insforge_realtime ADD TABLE rooms, chat_messages, song_requests;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;

-- Enable Row Level Security (RLS)
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE song_requests ENABLE ROW LEVEL SECURITY;

-- Create open RLS policies for rooms
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Public select rooms') THEN
    CREATE POLICY "Public select rooms" ON rooms FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Public insert rooms') THEN
    CREATE POLICY "Public insert rooms" ON rooms FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Public update rooms') THEN
    CREATE POLICY "Public update rooms" ON rooms FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'rooms' AND policyname = 'Public delete rooms') THEN
    CREATE POLICY "Public delete rooms" ON rooms FOR DELETE USING (true);
  END IF;
END $$;

-- Create open RLS policies for chat_messages
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'Public select chat_messages') THEN
    CREATE POLICY "Public select chat_messages" ON chat_messages FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'Public insert chat_messages') THEN
    CREATE POLICY "Public insert chat_messages" ON chat_messages FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'Public update chat_messages') THEN
    CREATE POLICY "Public update chat_messages" ON chat_messages FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'chat_messages' AND policyname = 'Public delete chat_messages') THEN
    CREATE POLICY "Public delete chat_messages" ON chat_messages FOR DELETE USING (true);
  END IF;
END $$;

-- Create open RLS policies for song_requests
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'song_requests' AND policyname = 'Public select song_requests') THEN
    CREATE POLICY "Public select song_requests" ON song_requests FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'song_requests' AND policyname = 'Public insert song_requests') THEN
    CREATE POLICY "Public insert song_requests" ON song_requests FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'song_requests' AND policyname = 'Public update song_requests') THEN
    CREATE POLICY "Public update song_requests" ON song_requests FOR UPDATE USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'song_requests' AND policyname = 'Public delete song_requests') THEN
    CREATE POLICY "Public delete song_requests" ON song_requests FOR DELETE USING (true);
  END IF;
END $$;

-- Grants for roles if they exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT ALL ON TABLE rooms TO anon;
    GRANT ALL ON TABLE chat_messages TO anon;
    GRANT ALL ON TABLE song_requests TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT ALL ON TABLE rooms TO authenticated;
    GRANT ALL ON TABLE chat_messages TO authenticated;
    GRANT ALL ON TABLE song_requests TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE rooms TO service_role;
    GRANT ALL ON TABLE chat_messages TO service_role;
    GRANT ALL ON TABLE song_requests TO service_role;
  END IF;
END $$;
