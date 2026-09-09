-- Migration: Membership-token checks for queue RPCs (Phase B, docs/011)
-- SCOPE: code + SQL files only, not applied.
-- Rule: PUBLIC rooms keep lightweight anon access (lobby visitors can request/vote);
-- PRIVATE rooms require presence proof: valid member_token for the session OR host.
-- DEFAULT NULL keeps old 2-arg callers compiling but fail-closed on private rooms.
-- ROLLBACK: re-apply request_song/toggle_upvote_song from 20260903300000/20260903400000.

CREATE OR REPLACE FUNCTION public.request_song(
  p_room_id UUID,
  p_video_id TEXT,
  p_title TEXT,
  p_artist TEXT,
  p_album_art TEXT,
  p_session_id UUID,
  p_display_name TEXT,
  p_member_token TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_active_count INT;
  v_total_queue INT;
  v_new_id UUID;
  v_room public.rooms%ROWTYPE;
  v_clean_vid TEXT := trim(COALESCE(p_video_id, ''));
BEGIN
  IF v_clean_vid !~ '^[a-zA-Z0-9_-]{11}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid YouTube Video ID format.');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id AND expires_at > now() AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'This room has expired or is inactive.');
  END IF;

  -- Private rooms: prove presence (token) or host. Public rooms: open.
  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.room_members m
      WHERE m.room_id = p_room_id
        AND m.session_id = p_session_id
        AND m.member_token = p_member_token
        AND m.last_seen > now() - interval '45 seconds'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Join the room before requesting songs.');
    END IF;
  END IF;

  SELECT count(*) INTO v_total_queue FROM public.room_queue WHERE room_id = p_room_id AND status = 'queued';
  IF v_total_queue >= 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room queue is currently full (Maximum 50 songs).');
  END IF;

  SELECT count(*) INTO v_active_count
  FROM public.room_queue
  WHERE room_id = p_room_id
    AND requested_by_session = p_session_id
    AND status = 'queued';

  IF v_active_count >= 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have 3 songs in the queue. Wait for one to play!');
  END IF;

  INSERT INTO public.room_queue (
    room_id, video_id, title, artist, album_art, requested_by_session, requested_by_name, vote_count, status
  )
  VALUES (
    p_room_id, v_clean_vid,
    substr(trim(COALESCE(p_title, 'Untitled')), 1, 200),
    substr(trim(COALESCE(p_artist, 'YouTube Request')), 1, 100),
    substr(trim(COALESCE(p_album_art, '')), 1, 500),
    p_session_id, substr(trim(COALESCE(p_display_name, 'Guest')), 1, 50), 1, 'queued'
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.queue_votes (queue_id, session_id)
  VALUES (v_new_id, p_session_id)
  ON CONFLICT DO NOTHING;

  PERFORM realtime.publish('room:' || p_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'added', 'id', v_new_id));

  RETURN jsonb_build_object('success', true, 'queue_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.toggle_upvote_song(
  p_queue_id UUID,
  p_session_id UUID,
  p_member_token TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_room public.rooms%ROWTYPE;
  v_has_voted BOOLEAN;
  v_new_votes INT;
BEGIN
  SELECT room_id INTO v_room_id FROM public.room_queue WHERE id = p_queue_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Track not found in queue.');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = v_room_id;
  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.room_members m
      WHERE m.room_id = v_room_id
        AND m.session_id = p_session_id
        AND m.member_token = p_member_token
        AND m.last_seen > now() - interval '45 seconds'
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'Join the room before voting.');
    END IF;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id
  ) INTO v_has_voted;

  IF v_has_voted THEN
    DELETE FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id;
  ELSE
    INSERT INTO public.queue_votes (queue_id, session_id) VALUES (p_queue_id, p_session_id);
  END IF;

  SELECT count(*) INTO v_new_votes FROM public.queue_votes WHERE queue_id = p_queue_id;
  UPDATE public.room_queue SET vote_count = v_new_votes, updated_at = now() WHERE id = p_queue_id;

  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'vote', 'id', p_queue_id, 'votes', v_new_votes));

  RETURN jsonb_build_object('success', true, 'votes', v_new_votes, 'voted', NOT v_has_voted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- chat_messages INSERT: intentionally unchanged (anon private INSERT stays allowed).
-- Rationale: anon private members (password-joined, user_id NULL) cannot prove
-- membership in pure RLS; reads are already denied (20260903300000 §3), payloads
-- capped (500/50 + trigger truncation), rows purge with the room. Full fix needs
-- a token column on chat_messages — deferred, see docs/011.
