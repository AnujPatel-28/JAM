-- Secure RLS lockdown + host authentication schema.
--
-- Model: a single shared room named 'main'. The room's host_id references
-- auth.users(id); only the owning authenticated user may insert/update/delete
-- their room row. Listeners stay anonymous: they get SELECT everywhere and
-- INSERT on chat_messages / song_requests only.

-- ============================================================
-- 1. Schema changes
-- ============================================================

-- rooms.host_id was TEXT; make it a real reference to auth users.
-- (Safe: rooms table is empty in this environment.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'rooms'
      AND column_name = 'host_id' AND data_type = 'text'
  ) THEN
    ALTER TABLE public.rooms ALTER COLUMN host_id TYPE uuid USING host_id::uuid;
  END IF;
END $$;

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_host_id_fkey;
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_host_id_fkey FOREIGN KEY (host_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_rooms_host_id ON public.rooms(host_id);

-- Attribute chat messages to logged-in users when available.
-- (user_id may pre-exist as TEXT in some environments; normalize it.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_messages'
      AND column_name = 'user_id'
  ) THEN
    ALTER TABLE public.chat_messages ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'chat_messages'
      AND column_name = 'user_id' AND data_type <> 'uuid'
  ) THEN
    UPDATE public.chat_messages SET user_id = NULL WHERE user_id IS NOT NULL;
    ALTER TABLE public.chat_messages ALTER COLUMN user_id TYPE uuid USING user_id::uuid;
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON public.chat_messages(user_id);

-- ============================================================
-- 2. Drop the open "public everything" policies
-- ============================================================

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('rooms', 'chat_messages', 'song_requests')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  END LOOP;
END $$;

-- ============================================================
-- 3. Recreate least-privilege policies
-- ============================================================

-- rooms: world-readable; writes restricted to the owning authenticated host.
CREATE POLICY "public select rooms" ON public.rooms
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "host inserts own room" ON public.rooms
  FOR INSERT TO authenticated
  WITH CHECK (host_id = (SELECT auth.uid()));

CREATE POLICY "host updates own room" ON public.rooms
  FOR UPDATE TO authenticated
  USING (host_id = (SELECT auth.uid()))
  WITH CHECK (host_id = (SELECT auth.uid()));

CREATE POLICY "host deletes own room" ON public.rooms
  FOR DELETE TO authenticated
  USING (host_id = (SELECT auth.uid()));

-- chat_messages: anyone can read and post; nobody can edit or erase history via the API.
CREATE POLICY "public select chat_messages" ON public.chat_messages
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "anyone can post chat_messages" ON public.chat_messages
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    user_id IS NULL OR user_id = (SELECT auth.uid())
  );

-- song_requests: anyone can read/request; lifecycle changes are admin-only.
CREATE POLICY "public select song_requests" ON public.song_requests
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY "anyone can create song_requests" ON public.song_requests
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- ============================================================
-- 4. Align SQL privileges with the policy surface
-- ============================================================

REVOKE ALL ON public.rooms FROM anon, authenticated;
GRANT SELECT ON public.rooms TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.rooms TO authenticated;

REVOKE ALL ON public.chat_messages FROM anon, authenticated;
GRANT SELECT, INSERT ON public.chat_messages TO anon, authenticated;

REVOKE ALL ON public.song_requests FROM anon, authenticated;
GRANT SELECT, INSERT ON public.song_requests TO anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
