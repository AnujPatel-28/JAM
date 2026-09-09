-- Migration: Medium hardening (M) — impersonation guard + defense-in-depth checks
-- SCOPE: code + SQL files only, not applied.
-- ROLLBACK: re-apply protect_chat_display_name() from 20260821120000_hardening.sql.

-- Broaden the anonymous anti-impersonation guard: exact 'host' was bypassed by
-- 'Host ', 'H0st'-style homoglyphs aside, the trivial ' host ', 'ADMIN',
-- 'MODERATOR' variants all worked. This blocks the trimmed case-insensitive
-- reserved set; homoglyph/lookalike policing stays a client-display concern
-- (rendered names are React-escaped; reservation is anti-spoof, not anti-XSS).
-- Also defensively truncates over-length payloads that bypass the client.
CREATE OR REPLACE FUNCTION public.protect_chat_display_name()
RETURNS trigger AS $$
BEGIN
  IF NEW.user_name IS NOT NULL THEN
    NEW.user_name := substr(trim(NEW.user_name), 1, 50);
    IF NEW.user_name = '' THEN
      NEW.user_name := 'Guest';
    ELSIF auth.uid() IS NULL AND NEW.user_name ILIKE ANY (ARRAY['host', 'admin', 'moderator']) THEN
      NEW.user_name := 'Guest';
    END IF;
  END IF;
  IF NEW.message IS NOT NULL AND char_length(NEW.message) > 500 THEN
    NEW.message := substr(NEW.message, 1, 500);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
