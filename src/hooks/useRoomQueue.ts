import { useState, useEffect, useCallback } from 'react';
import { insforge } from '../lib/insforge';
import { realtime } from '../lib/realtime';
import { getOrCreateSessionId, getMemberToken } from '../lib/session';
import { resolveYouTubeTrack } from '../lib/youtubeMetadata';

export interface QueuedSong {
  id: string;
  room_id: string;
  video_id: string;
  title: string;
  artist: string;
  album_art?: string | null;
  requested_by_name: string;
  requested_by_session: string;
  vote_count: number;
  status: 'queued' | 'playing' | 'played' | 'rejected';
  created_at: string;
  has_voted?: boolean;
}

export function useRoomQueue(roomId?: string) {
  const [queue, setQueue] = useState<QueuedSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [userVotedIds, setUserVotedIds] = useState<Set<string>>(new Set());
  const sessionId = getOrCreateSessionId();

  // 021: never show raw DB/PostgREST text (e.g. "schema cache", PGRST203).
  // Known backend messages pass through; everything else becomes generic.
  const mapQueueError = (raw: string | undefined | null): string => {
    const msg = (raw || '').trim();
    if (!msg) return 'Could not add track to queue.';
    if (/schema cache|PGRST|relation .* does not exist|function .* does not exist/i.test(msg)) {
      return 'Song service is updating. Please try again in a moment.';
    }
    if (/expired|inactive/i.test(msg)) return msg;
    if (/join the room/i.test(msg)) return msg;
    if (/already have 3 songs|queue is .* full/i.test(msg)) return msg;
    if (/invalid youtube|valid youtube/i.test(msg)) return msg;
    if (/network|fetch|timeout|failed/i.test(msg)) return 'Network hiccup. Please try again.';
    return msg.length <= 120 ? msg : 'Could not add track to queue.';
  };

  const fetchQueue = useCallback(async () => {
    if (!roomId) return;
    try {
      // 022: explicit columns (was select('*') — never fetch member-adjacent
      // or future sensitive columns into the browser).
      const { data, error } = await insforge.database
        .from('room_queue')
        .select('id,room_id,video_id,title,artist,album_art,requested_by_name,requested_by_session,vote_count,status,created_at')
        .eq('room_id', roomId)
        .eq('status', 'queued')
        .order('vote_count', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(30);

      if (error || !data) return;

      // 2. Fetch user's votes for this session
      const queueIds = data.map((item: any) => item.id);
      let votedSet = new Set<string>();

      if (queueIds.length > 0) {
        const { data: votes } = await insforge.database
          .from('queue_votes')
          .select('queue_id')
          .eq('session_id', sessionId)
          .in('queue_id', queueIds);

        if (votes && Array.isArray(votes)) {
          votedSet = new Set(votes.map((v: any) => v.queue_id));
        }
      }

      setUserVotedIds(votedSet);
      setQueue(
        data.map((item: any) => ({
          ...item,
          has_voted: votedSet.has(item.id),
        }))
      );
    } catch {
      // Ignore network blips
    }
  }, [roomId, sessionId]);

  // Realtime subscription to queue channel
  useEffect(() => {
    if (!roomId) return;
    let isSubscribed = true;
    let offChannel: (() => void) | null = null;
    const channelName = `room:${roomId}:queue`;

    const handleQueueUpdate = () => {
      if (isSubscribed) fetchQueue();
    };

    async function initQueueRealtime() {
      try {
        await realtime.connect();
        if (!isSubscribed) return;
        await realtime.subscribe(channelName);
        // C1: channel-aware dispatch drops forged cross-room queue events.
        offChannel = realtime.onChannel(channelName, 'queue_update', handleQueueUpdate);
        fetchQueue();
      } catch (err) {
        console.warn('Queue realtime subscription note:', err);
      }
    }

    initQueueRealtime();

    return () => {
      isSubscribed = false;
      try {
        offChannel?.();
        realtime.unsubscribe(channelName);
      } catch {}
    };
  }, [roomId, fetchQueue]);

  // Request a new track
  const requestSong = async (urlOrId: string, displayName: string): Promise<string | null> => {
    if (!roomId) return 'Room not loaded';
    setLoading(true);

    try {
      const meta = await resolveYouTubeTrack(urlOrId);
      if (!meta) {
        return 'Please enter a valid YouTube Video ID or URL.';
      }

      // 022/044: coerce artwork client-side too (server re-coerces; this keeps
      // the UI consistent and never renders a non-allowlisted host).
      const art =
        meta.thumbnail.startsWith('https://img.youtube.com/') ||
        meta.thumbnail.startsWith('https://i.ytimg.com/')
          ? meta.thumbnail
          : `https://img.youtube.com/vi/${meta.videoId}/hqdefault.jpg`;

      const { data, error } = await insforge.database.rpc('request_song', {
        p_room_id: roomId,
        p_video_id: meta.videoId,
        p_title: meta.title,
        p_artist: meta.artist,
        p_album_art: art,
        p_session_id: sessionId,
        p_display_name: displayName,
        // Phase B (docs/011): presence proof for private rooms; ignored for public.
        p_member_token: getMemberToken(roomId),
      });

      if (error) return mapQueueError(error.message);
      if (!data?.success) return mapQueueError(data?.error);

      await fetchQueue();
      return null;
    } catch (err: any) {
      return mapQueueError(err?.message);
    } finally {
      setLoading(false);
    }
  };

  // Toggle upvote
  const toggleUpvote = async (queueId: string): Promise<void> => {
    // Optimistic update
    const alreadyVoted = userVotedIds.has(queueId);
    setQueue((prev) =>
      prev.map((item) =>
        item.id === queueId
          ? {
              ...item,
              vote_count: Math.max(1, item.vote_count + (alreadyVoted ? -1 : 1)),
              has_voted: !alreadyVoted,
            }
          : item
      ).sort((a, b) => b.vote_count - a.vote_count)
    );

    setUserVotedIds((prev) => {
      const next = new Set(prev);
      if (alreadyVoted) next.delete(queueId);
      else next.add(queueId);
      return next;
    });

    try {
      await insforge.database.rpc('toggle_upvote_song', {
        p_queue_id: queueId,
        p_session_id: sessionId,
        // Phase B (docs/011): presence proof for private rooms.
        p_member_token: roomId ? getMemberToken(roomId) : null,
      });
    } catch {
      fetchQueue();
    }
  };

  // Moderate queue status (Host Only)
  const updateStatus = async (queueId: string, status: 'playing' | 'played' | 'rejected') => {
    try {
      await insforge.database.rpc('update_queue_status', {
        p_queue_id: queueId,
        p_status: status,
      });
      fetchQueue();
    } catch (err) {
      console.warn('Could not update track status:', err);
    }
  };

  return {
    queue,
    loading,
    // A-slim: guests see their live quota (server enforces 3/session).
    myQueuedCount: queue.filter(
      (q) => q.requested_by_session === sessionId && q.status === 'queued'
    ).length,
    requestSong,
    toggleUpvote,
    updateStatus,
    refreshQueue: fetchQueue,
  };
}
