-- Migration: Queue hardening round 2 — album-art allowlist + name fold
-- (audit 022, Phase 2 item 11)
--
-- WHY: room_queue.album_art accepted any 500-char string (server did substr()
--   only), so a direct-RPC caller could store tracker/offensive image URLs
--   rendered to every viewer (SongQueuePanel/RoomPage <img src>). The sync
--   path already allowlists art; the queue path did not.
-- WHAT: CREATE OR REPLACE request_song (same 8-arg signature, no overload
--   churn): album_art not matching ^https://(img.youtube.com|i.ytimg.com)/
--   is coerced to the deterministic thumbnail for the verified video id
--   (attackers can't smuggle hosts; legit clients already send these hosts).
--   requested_by_name now passes through normalize_display_name (039).
-- ROLLBACK: re-apply request_song from 20260903600000_membership-rpcs.sql.
-- VERIFY: request with album_art https://evil/x.png → stored art is
--   https://img.youtube.com/vi/<id>/hqdefault.jpg.

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
  v_clean_art TEXT := trim(COALESCE(p_album_art, ''));
BEGIN
  IF v_clean_vid !~ '^[a-zA-Z0-9_-]{11}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid YouTube Video ID format.');
  END IF;

  -- Coerce artwork to the allowlist (tracker/defacement barrier). The video
  -- id above is already regex-verified, so the fallback is always safe.
  IF v_clean_art !~ '^https://(img\.youtube\.com|i\.ytimg\.com)/' THEN
    v_clean_art := 'https://img.youtube.com/vi/' || v_clean_vid || '/hqdefault.jpg';
  END IF;
  v_clean_art := substr(v_clean_art, 1, 500);

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
    v_clean_art,
    p_session_id, public.normalize_display_name(p_display_name), 1, 'queued'
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.queue_votes (queue_id, session_id)
  VALUES (v_new_id, p_session_id)
  ON CONFLICT DO NOTHING;

  PERFORM realtime.publish('room:' || p_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'added', 'id', v_new_id));

  RETURN jsonb_build_object('success', true, 'queue_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
