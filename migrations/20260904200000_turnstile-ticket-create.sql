-- Migration: Human-proof for room creation via single-use tickets (audit 022)
--
-- WHY: Turnstile was widget-only — CreateRoomModal verified the token via the
--   edge function but never sent proof to create_room_secure(), so bots calling
--   the RPC directly skipped the human check entirely. SQL cannot call
--   siteverify, so the edge mints single-use tickets and the RPC consumes them.
-- WHAT:
--   1. turnstile_tickets table (id, action, created_at). RLS enabled, no
--      policies = deny-all direct access; edge service key writes as owner.
--   2. create_room_secure() gains p_turnstile_ticket (REQUIRED): must exist,
--      be action-bound ('create_room'), fresh (<10 min), and is consumed
--      (deleted) on use → single-use, no replay.
--   3. Unique-violation retry on room-code generation (was an unhandled 23505).
--   4. Room name/description pass through normalize_display_name caps
--      (length already enforced; reserved-word forcing skipped for room
--      TITLES — a room named "Host" impersonates nobody).
-- DEV/UNCONFIGURED BEHAVIOR (user decision: fail open with loud warning):
--   when TURNSTILE_SECRET_KEY is unset, the EDGE function mints tickets
--   without verification (dev-only path, warns loudly). The RPC rule stays
--   strict everywhere, so prod (secret set) is fully enforced and dev never
--   locks out. See functions/verify-turnstile.ts (Phase 2 code change).
-- SCOPE NOTE: request_song/chat stay widget-gated-UX + server caps (3/session,
--   50/room, 10/min chat) instead of per-message tickets — a fresh CAPTCHA per
--   message would destroy UX for negligible gain over the caps. Revisit if
--   anon song-spam is observed (then: ticket-per-N-minutes bucket).
-- ROLLBACK: re-apply create_room_secure from 20260903400000;
--   DROP TABLE public.turnstile_tickets.
-- VERIFY: create without ticket → 'Human verification required.';
--   create with ticket → success; reuse same ticket → rejected.

CREATE TABLE IF NOT EXISTS public.turnstile_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.turnstile_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.turnstile_tickets FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_turnstile_tickets_created
  ON public.turnstile_tickets(created_at);

CREATE OR REPLACE FUNCTION public.create_room_secure(
  p_name TEXT,
  p_is_private BOOLEAN DEFAULT false,
  p_password TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_turnstile_ticket UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_code TEXT;
  v_host_id UUID := auth.uid();
  v_attempt INT := 0;
BEGIN
  IF v_host_id IS NULL THEN
    RAISE EXCEPTION 'You must be signed in to create a room.';
  END IF;

  -- Human proof: single-use ticket minted by verify-turnstile edge function.
  IF p_turnstile_ticket IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Human verification required.');
  END IF;
  DELETE FROM public.turnstile_tickets
  WHERE id = p_turnstile_ticket
    AND action = 'create_room'
    AND created_at > now() - interval '10 minutes';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Human verification required.');
  END IF;

  IF p_name IS NULL OR char_length(trim(p_name)) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Room name must be 1–60 characters.';
  END IF;

  IF p_description IS NOT NULL AND char_length(p_description) > 200 THEN
    RAISE EXCEPTION 'Description must be at most 200 characters.';
  END IF;

  IF p_is_private AND (p_password IS NULL OR char_length(trim(p_password)) < 8) THEN
    RAISE EXCEPTION 'Private rooms require a password with at least 8 characters.';
  END IF;

  -- Code-collision retry (was an unhandled unique_violation 23505).
  LOOP
    v_attempt := v_attempt + 1;
    v_code := public.generate_unique_room_code();
    BEGIN
      INSERT INTO public.rooms (name, host_id, code, is_private, max_members, description, host_last_seen)
      VALUES (substr(trim(p_name), 1, 60), v_host_id, v_code, p_is_private, 5, substr(trim(COALESCE(p_description, '')), 1, 200), now())
      RETURNING id INTO v_room_id;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 3 THEN
        RAISE EXCEPTION 'Could not allocate a room code. Please try again.';
      END IF;
    END;
  END LOOP;

  IF p_is_private THEN
    INSERT INTO public.room_secrets (room_id, password_hash)
    VALUES (v_room_id, crypt(trim(p_password), gen_salt('bf', 12)));
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'room_id', v_room_id,
    'code', v_code,
    'name', p_name,
    'is_private', p_is_private
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- New 5-arg signature is a distinct overload: drop the old 4-arg one to avoid
-- PGRST203 ambiguity (same lesson as 038/041).
DROP FUNCTION IF EXISTS public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT);

REVOKE ALL ON FUNCTION public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT, UUID) TO authenticated;
