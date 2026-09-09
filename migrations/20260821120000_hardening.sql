-- Post-audit hardening.
--
-- 1. UNIQUE constraint on rooms.name prevents a race where two first-time
--    visitors each create their own 'main' room and split the audience.
-- 2. Length caps on chat content stop unbounded payloads via the anon API.
-- 3. BEFORE INSERT trigger stops anonymous posters from using reserved
--    display names ('Host') to impersonate the room owner.

-- ============================================================
-- 1. One room per name
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rooms_name_key' AND conrelid = 'public.rooms'::regclass
  ) THEN
    -- Collapse any pre-existing duplicates first (keep the oldest row).
    DELETE FROM public.rooms a
    USING public.rooms b
    WHERE a.name = b.name AND a.created_at > b.created_at;
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_name_key UNIQUE (name);
  END IF;
END $$;

-- ============================================================
-- 2. Chat payload limits
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_message_len' AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_message_len CHECK (char_length(message) <= 500);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chat_messages_user_name_len' AND conrelid = 'public.chat_messages'::regclass
  ) THEN
    ALTER TABLE public.chat_messages
      ADD CONSTRAINT chat_messages_user_name_len
      CHECK (user_name IS NULL OR char_length(user_name) <= 50);
  END IF;
END $$;

-- ============================================================
-- 3. Anti-impersonation guard for anonymous posters
-- ============================================================

CREATE OR REPLACE FUNCTION public.protect_chat_display_name()
RETURNS trigger AS $$
BEGIN
  IF auth.uid() IS NULL AND NEW.user_name ILIKE 'host' THEN
    NEW.user_name := 'Guest';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS chat_messages_protect_display_name ON public.chat_messages;

CREATE TRIGGER chat_messages_protect_display_name
BEFORE INSERT ON public.chat_messages
FOR EACH ROW EXECUTE FUNCTION public.protect_chat_display_name();
