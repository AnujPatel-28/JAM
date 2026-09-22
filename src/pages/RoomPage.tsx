import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Send,
  Music,
  Video,
  Image as ImageIcon,
  Volume2,
  VolumeX,
  Plus,
  AlertCircle,
  CheckCircle2,
  ArrowLeft,
  MessageSquare,
  ListMusic,
  Clock,
  X,
  Lock,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useYouTubeMusic } from '../hooks/useYouTubeMusic';
import { useChatMessages } from '../hooks/useChatMessages';
import { useRoomQueue } from '../hooks/useRoomQueue';
import { insforge } from '../lib/insforge';
import { getOrCreateSessionId, getStoredDisplayName, getMemberToken, setMemberToken, clearMemberToken, getRoomPasswordMemory, setRoomPasswordMemory, clearRoomPasswordMemory } from '../lib/session';
import { safeStoredDisplayName } from '../lib/displayName';
import { YouTubePlayer } from '../components/YouTubePlayer';
import { YouTubeIcon } from '../components/Icons';
import { extractYouTubeId, getYouTubeThumbnail } from '../lib/providers/youtube';
import { RoomHeader, type ActiveMember } from '../components/RoomHeader';
import { PasswordPromptModal } from '../components/PasswordPromptModal';
import { SongQueuePanel } from '../components/SongQueuePanel';
import { RequestSongModal } from '../components/RequestSongModal';
import type { MusicTrack } from '../lib/providers/types';

export const RoomPage: React.FC = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const auth = useAuth();

  const [roomData, setRoomData] = useState<{
    id: string;
    code: string;
    name: string;
    is_private: boolean;
    host_id: string;
    role: string;
    expires_at?: string;
  } | null>(null);

  const [joining, setJoining] = useState(true);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const [isExpired, setIsExpired] = useState(false);
  const [activeMembers, setActiveMembers] = useState<ActiveMember[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  // Sidebar Tabs: 'chat' | 'queue' (desktop). On phones the queue opens
  // as a bottom sheet instead — see openQueue / queueSheetOpen.
  const [sidebarTab, setSidebarTab] = useState<'chat' | 'queue'>('chat');
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [queueSheetOpen, setQueueSheetOpen] = useState(false);
  // Now-playing overlay (phones only — desktop renders the player inline and
  // ignores this). Collapsed by default: chat owns the screen, the mini-bar
  // is the doorway (family-values gradual revelation).
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [npDragY, setNpDragY] = useState(0);
  const npDragRef = useRef<{ startY: number; dy: number; reduced: boolean } | null>(null);

  // Player & Chat UI States
  const [message, setMessage] = useState('');
  const [showVideo, setShowVideo] = useState(false);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  const progressBarRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const sessionId = useRef(getOrCreateSessionId()).current;
  // C3: memory-only secrets (never sessionStorage). NOTE: neither router
  // state nor this memory survives a refresh — private rooms always re-prompt
  // after reload (by design). Token proves presence ownership.
  const passwordRef = useRef<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  };

  // 1. Join Room Pre-flight Validation
  // Returns an error string on failure (surfaced in the password modal),
  // or null on success.
  const attemptJoin = useCallback(
    async (passwordAttempt?: string | null): Promise<string | null> => {
      if (!roomCode) return 'Missing room code.';
      // 022: reject garbage codes before the RPC (e.g. /room/<script>).
      if (!/^[A-Z0-9]{3,8}$/i.test(roomCode.trim())) {
        const msg = 'Invalid room code. Codes are 3–8 letters and numbers.';
        setJoinError(msg);
        setJoining(false);
        return msg;
      }
      setJoining(true);
      setJoinError(null);

      // C3/H4: password from explicit attempt → router state → memory.
      // Never sessionStorage (XSS-readable, predictable key).
      const upperCode = roomCode.toUpperCase();
      const cachedPassword =
        passwordAttempt ||
        (location.state as any)?.password ||
        getRoomPasswordMemory(upperCode) ||
        passwordRef.current;

      try {
        const { data, error } = await insforge.database.rpc('join_room_secure', {
          p_code: roomCode.toUpperCase(),
          p_session_id: sessionId,
          p_display_name: getStoredDisplayName(),
          p_password: cachedPassword || null,
        });

        if (error) {
          const msg = error.message || 'Could not join room.';
          setJoinError(msg);
          setJoining(false);
          return msg;
        }

        if (data?.success && data?.room) {
          // Check expiration
          const { data: fullRoom } = await insforge.database
            .from('rooms')
            .select('expires_at')
            .eq('id', data.room.id)
            .single();

          if (fullRoom?.expires_at && new Date(fullRoom.expires_at).getTime() < Date.now()) {
            setIsExpired(true);
            setJoining(false);
            return 'This room has expired.';
          }

          setRoomData({
            ...data.room,
            expires_at: fullRoom?.expires_at,
          });
          setNeedsPassword(false);
          setIsFull(false);
          setIsExpired(false);
          // C3: capture presence token + password in memory only.
          if (typeof data?.member_token === 'string' && data.member_token) {
            setMemberToken(data.room.id, data.member_token);
          }
          if (cachedPassword) {
            passwordRef.current = cachedPassword;
            setRoomPasswordMemory(upperCode, cachedPassword);
          }
          return null;
        } else if (data?.error?.includes('password')) {
          setNeedsPassword(true);
          return data.error;
        } else if (data?.error?.includes('full')) {
          setIsFull(true);
          return data.error;
        } else if (data?.error?.includes('expired')) {
          setIsExpired(true);
          return data.error;
        } else {
          const msg = data?.error || 'Could not join room.';
          setJoinError(msg);
          return msg;
        }
      } catch (err: any) {
        const msg = err?.message || 'Failed to connect to room.';
        setJoinError(msg);
        return msg;
      } finally {
        setJoining(false);
      }
    },
    [roomCode, location.state, sessionId]
  );

  useEffect(() => {
    attemptJoin();
  }, [attemptJoin]);

  // 2. Poll Active Members & Heartbeat Ping
  const fetchActiveMembers = useCallback(async () => {
    if (!roomData?.id) return;
    try {
      // Check 24-hour expiration
      if (roomData.expires_at && new Date(roomData.expires_at).getTime() < Date.now()) {
        setIsExpired(true);
        return;
      }

      // C3: prove ownership with member_token (fail-closed if missing).
      await insforge.database.rpc('ping_room_presence', {
        p_room_id: roomData.id,
        p_session_id: sessionId,
        p_member_token: getMemberToken(roomData.id),
      });

      const { data } = await insforge.database.rpc('get_active_room_members', {
        p_room_id: roomData.id,
      });

      if (data && Array.isArray(data)) {
        setActiveMembers(data);
      }
    } catch {
      // Silent catch
    }
  }, [roomData?.id, roomData?.expires_at, sessionId]);

  useEffect(() => {
    if (!roomData?.id) return;
    fetchActiveMembers();
    const interval = setInterval(fetchActiveMembers, 20000);
    return () => clearInterval(interval);
  }, [roomData?.id, fetchActiveMembers]);

  // 3. Departure Cleanup
  // 022: React unmount cleanup often never runs on tab close, so ALSO leave
  // on pagehide (bfcache-compatible, unlike beforeunload). Raw sendBeacon
  // can't carry the SDK auth shape, so this stays best-effort fetch — the
  // 45s presence timeout remains the backstop (noted in the full-room copy).
  useEffect(() => {
    const currentRoomId = roomData?.id;
    if (!currentRoomId) return;
    const leave = () => {
      const token = getMemberToken(currentRoomId);
      insforge.database.rpc('leave_room', {
        p_room_id: currentRoomId,
        p_session_id: sessionId,
        p_member_token: token,
      });
      clearMemberToken(currentRoomId);
    };
    const onPageHide = () => leave();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      leave();
    };
  }, [roomData?.id, sessionId]);

  const handleLeaveRoom = async () => {
    if (roomData?.id) {
      await insforge.database.rpc('leave_room', {
        p_room_id: roomData.id,
        p_session_id: sessionId,
        p_member_token: getMemberToken(roomData.id),
      });
      clearMemberToken(roomData.id);
      if (roomCode) clearRoomPasswordMemory(roomCode);
      passwordRef.current = null;
    }
    navigate('/');
  };

  const isHost = !!(auth.user && roomData && roomData.host_id === auth.user.id);

  // Mobile Queue entry: bottom sheet on phones, inline tab on desktop.
  const openQueue = useCallback(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches) {
      setQueueSheetOpen(true);
    } else {
      setSidebarTab('queue');
    }
  }, []);

  // Now-playing overlay lifecycle: Esc closes, background scroll locks,
  // auto-closes past phone width (CSS only shows the overlay on mobile).
  useEffect(() => {
    if (!nowPlayingOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNowPlayingOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const mq = window.matchMedia('(max-width: 640px)');
    const onViewportChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setNowPlayingOpen(false);
    };
    mq.addEventListener('change', onViewportChange);
    return () => {
      document.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onViewportChange);
      document.body.style.overflow = prevOverflow;
    };
  }, [nowPlayingOpen]);

  // Swipe-down to dismiss, confined to the overlay head so overlay scroll
  // never fights the gesture. Reduced-motion: no live follow, just close.
  const onNpTouchStart = (e: React.TouchEvent) => {
    npDragRef.current = {
      startY: e.touches[0].clientY,
      dy: 0,
      reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    };
    if (!npDragRef.current.reduced) setNpDragY(0);
  };

  const onNpTouchMove = (e: React.TouchEvent) => {
    const d = npDragRef.current;
    if (!d || d.reduced) return;
    const dy = Math.max(0, e.touches[0].clientY - d.startY);
    d.dy = dy;
    setNpDragY(dy);
  };

  const onNpTouchEnd = () => {
    const d = npDragRef.current;
    npDragRef.current = null;
    if (d && d.dy > 96) setNowPlayingOpen(false);
    setNpDragY(0);
  };

  // Bottom-sheet lifecycle: Esc closes, background scroll locks while open.
  // Auto-closes if the viewport grows past phone size (CSS hides the sheet
  // there, so state must follow or scroll stays locked behind nothing).
  useEffect(() => {
    if (!queueSheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setQueueSheetOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const mq = window.matchMedia('(max-width: 640px)');
    const onViewportChange = (e: MediaQueryListEvent) => {
      if (!e.matches) setQueueSheetOpen(false);
    };
    mq.addEventListener('change', onViewportChange);
    return () => {
      document.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onViewportChange);
      document.body.style.overflow = prevOverflow;
    };
  }, [queueSheetOpen]);

  // 4. Hook Up YouTube Music Player
  const {
    tracks,
    currentTrack,
    currentTrackIndex,
    isPlaying,
    progress,
    timeElapsed,
    timeTotal,
    volume,
    isMuted,
    isBuffering,
    error: playbackError,
    syncStatus,
    togglePlay,
    seekByPercentage,
    setVolume,
    toggleMute,
    loadTrack,
    nextTrack,
    prevTrack,
    playerProps,
  } = useYouTubeMusic({
    isHost,
    hostId: roomData?.host_id,
    roomId: roomData?.id,
    onTrackSkipped: showToast,
  });

  // 5. Hook Up Room-Scoped Chat Messages
  const { messages: chatMessages, sendMessage, isConnected, error: chatError } = useChatMessages(roomData?.id);

  // 6. Hook Up Collaborative Song Queue
  const {
    queue,
    myQueuedCount,
    requestSong,
    toggleUpvote,
    updateStatus,
  } = useRoomQueue(roomData?.id);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;

    // 022: every writer resolves through safeStoredDisplayName (never render
    // or store a reserved name, even if storage predates the reservation).
    sendMessage(message, safeStoredDisplayName(getStoredDisplayName()), auth.user?.id ?? null);
    setMessage('');
  };

  const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isHost || !progressBarRef.current) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(100, (clickX / rect.width) * 100));
    seekByPercentage(percentage);
  };

  const handleAddCustomTrack = (e: React.FormEvent) => {
    e.preventDefault();
    const videoId = extractYouTubeId(customUrlInput);
    if (!videoId) {
      showToast('Please enter a valid YouTube Video ID or URL');
      return;
    }

    loadTrack({
      id: videoId,
      title: `Custom Video (${videoId})`,
      artist: 'YouTube Request',
      albumArt: getYouTubeThumbnail(videoId),
      provider: 'youtube',
      url: `https://www.youtube.com/watch?v=${videoId}`,
    });

    setCustomUrlInput('');
    setShowCustomInput(false);
  };

  // Host manually plays track from the collaborative queue
  const handlePlayQueuedTrack = (track: MusicTrack, queueId: string) => {
    loadTrack(track);
    updateStatus(queueId, 'playing');
    showToast(`Now playing: ${track.title}`);
  };

  // --- RENDERING BARRIERS / LOADING ---

  // During a password retry the modal stays mounted (it shows its own
  // "Verifying..." state) so its input + error message are not wiped.
  if (joining && !needsPassword) {
    return (
      <div className="room-barrier-container">
        <div className="spinner" />
        <p style={{ marginTop: '16px', color: 'var(--text-secondary)' }} role="status">
          Connecting to room {roomCode}...
        </p>
      </div>
    );
  }

  // Locked private room: show a dedicated locked screen instead of the full
  // player UI (roomData is still null here).
  if (needsPassword && !roomData) {
    return (
      <div className="app-container">
        <div className="room-barrier-container">
          <div className="room-barrier-card glass-panel">
            <Lock size={40} color="var(--accent-color)" />
            <h1>Private Room</h1>
            <p>
              Room <strong>{roomCode}</strong> is password-protected. Enter the room password to join.
            </p>
          </div>
        </div>
        <PasswordPromptModal
          roomName={roomCode || 'Room'}
          roomCode={roomCode || ''}
          onClose={() => navigate('/')}
          onSubmit={(pwd) => attemptJoin(pwd)}
        />
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="room-barrier-container">
        <div className="room-barrier-card glass-panel">
          <Clock size={40} color="#fbbf24" />
          <h1>24-Hour Session Expired</h1>
          <p>
            Room <strong>{roomCode}</strong> was active for 24 hours and has concluded. All chat messages and queue data have been permanently cleared.
          </p>
          <button className="hero-create-btn" style={{ marginTop: '20px' }} onClick={() => navigate('/')}>
            Return to Lobby
          </button>
        </div>
      </div>
    );
  }

  if (isFull) {
    return (
      <div className="room-barrier-container">
        <div className="room-barrier-card glass-panel">
          <AlertCircle size={40} color="#f87171" />
          <h1>Room is Currently Full</h1>
          <p>
            Room <strong>{roomCode}</strong> has reached its maximum capacity of 5 listeners.
            Seats free up within ~45 seconds after someone closes their tab.
          </p>
          <div className="room-barrier-actions">
            <button className="auth-submit" onClick={() => attemptJoin()}>
              Try Again
            </button>
            <button className="back-lobby-btn" onClick={() => navigate('/')}>
              <ArrowLeft size={16} /> Back to Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 022: never render raw RPC/network text (PGRST203, Failed to fetch…).
  // Known backend messages pass through; everything else becomes generic.
  const mapJoinError = (raw: string | undefined | null): string => {
    const msg = (raw || '').trim();
    if (!msg) return 'Could not join room.';
    if (/invalid code or password/i.test(msg)) return msg;
    if (/currently full|maximum 5/i.test(msg)) return msg;
    if (/display name must be/i.test(msg)) return msg;
    if (/expired/i.test(msg)) return msg;
    if (/schema cache|PGRST|relation .* does not exist|function .* does not exist/i.test(msg)) {
      return 'Room service is updating. Please try again in a moment.';
    }
    if (/network|fetch|timeout|failed|load failed/i.test(msg)) {
      return 'Network hiccup. Please check your connection and try again.';
    }
    return msg.length <= 120 ? msg : 'Could not join room.';
  };

  if (joinError) {
    return (
      <div className="room-barrier-container">
        <div className="room-barrier-card glass-panel">
          <AlertCircle size={40} color="#f87171" />
          <h1>Unable to Join</h1>
          <p>{mapJoinError(joinError)}</p>
          <div className="room-barrier-actions">
            <button className="auth-submit" onClick={() => attemptJoin()}>
              Try Again
            </button>
            <button className="back-lobby-btn" onClick={() => navigate('/')}>
              <ArrowLeft size={16} /> Back to Lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Password Challenge Modal */}
      {needsPassword && (
        <PasswordPromptModal
          roomName={roomData?.name || roomCode || 'Room'}
          roomCode={roomCode || ''}
          onClose={() => navigate('/')}
          onSubmit={(pwd) => attemptJoin(pwd)}
        />
      )}

      {/* Request Song Modal */}
      {showRequestModal && (
        <RequestSongModal
          onClose={() => setShowRequestModal(false)}
          onSubmit={async (urlOrId) => {
            const err = await requestSong(urlOrId, safeStoredDisplayName(getStoredDisplayName()));
            if (!err) {
              showToast('Song added to queue!');
            }
            return err;
          }}
        />
      )}

      {/* MAIN PLAYER AREA */}
      <main className="main-content">
        <RoomHeader
          roomName={roomData?.name || 'Live Room'}
          roomCode={roomData?.code || roomCode || ''}
          isPrivate={!!roomData?.is_private}
          isHost={isHost}
          activeMembers={activeMembers}
          userDisplayName={getStoredDisplayName()}
          userEmail={auth.user?.email}
          expiresAt={roomData?.expires_at}
          onLeave={handleLeaveRoom}
          onSignOut={auth.signOut}
          showToast={showToast}
        />

        <section id="now-playing-panel" className={`player-section glass-panel${nowPlayingOpen ? ' player-open' : ''}`} style={npDragY > 0 ? { transform: `translateY(${npDragY}px)` } : undefined} aria-label="Now playing">
          {/* Mobile overlay head: drag handle + title + dismiss (tray rule) */}
          <div className="np-head" onTouchStart={onNpTouchStart} onTouchMove={onNpTouchMove} onTouchEnd={onNpTouchEnd}>
            <div className="np-handle" aria-hidden="true" />
            <div className="np-title-row">
              <span className="np-title">Now Playing</span>
              <button type="button" className="np-close" onClick={() => setNowPlayingOpen(false)} aria-label="Collapse player">
                <ChevronDown size={18} aria-hidden="true" />
              </button>
            </div>
          </div>
          {playbackError && (
            <div className="error-banner" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={18} />
              <span>{playbackError}</span>
            </div>
          )}

          <div className="album-art-container">
            <YouTubePlayer playerProps={playerProps} showVideo={showVideo} />

            {!showVideo && (
              <img
                src={currentTrack.albumArt || getYouTubeThumbnail(currentTrack.id)}
                alt={currentTrack.title}
                onError={(e) => {
                  (e.target as HTMLImageElement).src =
                    'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?q=80&w=800&auto=format&fit=crop';
                }}
              />
            )}

            <button
              className="video-toggle-btn"
              onClick={() => setShowVideo(!showVideo)}
              title={showVideo ? 'Switch to Album Art' : 'Show YouTube Video'}
              aria-label={showVideo ? 'Switch to album art' : 'Show YouTube video'}
            >
              {showVideo ? <ImageIcon size={14} /> : <Video size={14} />}
              {showVideo ? 'Cover Art' : 'Video Mode'}
            </button>
          </div>

          <div className="track-info">
            <h1 className="track-title" title={currentTrack.title}>
              {currentTrack.title}
            </h1>
            <h2 className="track-artist">{currentTrack.artist}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <div className="track-provider-tag">
                <YouTubeIcon size={12} /> YouTube
              </div>
              {!isHost && syncStatus && (
                <div
                  className={`sync-status-pill sync-${syncStatus.state}`}
                  title={`Host drift: ${syncStatus.driftMs}ms`}
                >
                  <span className="sync-status-dot" />
                  <span>
                    {syncStatus.state === 'synced' && `Synced (${Math.abs(syncStatus.driftMs)}ms)`}
                    {syncStatus.state === 'adjusting' && `Catching up (${syncStatus.rate}x)`}
                    {syncStatus.state === 'seeking' && 'Seeking to host...'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Guest DJ hint: who runs playback (A-slim role clarity) */}
          {!isHost && (
            <div
              className="guest-dj-hint"
              title="Only the host controls playback — your power is requests and votes"
            >
              <span role="img" aria-label="Headphones">🎧</span>
              <span>
                {activeMembers.find((m) => m.role === 'host')?.display_name || 'The host'} is
                DJ — request songs and upvote to shape the vibe.
              </span>
            </div>
          )}

          {/* Progress Bar */}
          <div className="progress-container">
            <span className="time">{timeElapsed}</span>
            <div
              className="progress-bar"
              ref={progressBarRef}
              role={isHost ? 'slider' : undefined}
              aria-label={isHost ? 'Seek position' : 'Playback position'}
              aria-valuemin={isHost ? 0 : undefined}
              aria-valuemax={isHost ? 100 : undefined}
              aria-valuenow={isHost ? Math.round(progress) : undefined}
              aria-valuetext={isHost ? `${timeElapsed} of ${timeTotal}` : undefined}
              tabIndex={isHost ? 0 : -1}
              onClick={handleProgressBarClick}
              onKeyDown={(e) => {
                if (!isHost) return;
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  seekByPercentage(Math.min(100, progress + 5));
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  seekByPercentage(Math.max(0, progress - 5));
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  seekByPercentage(0);
                } else if (e.key === 'End') {
                  e.preventDefault();
                  seekByPercentage(100);
                }
              }}
              title={isHost ? 'Click or use arrow keys to seek' : ''}
              style={{ cursor: isHost ? 'pointer' : 'default' }}
            >
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <span className="time">{timeTotal}</span>
          </div>

          {/* Host Playback Controls */}
          {isHost && (
            <div className="controls-row">
              <button className="control-btn" onClick={prevTrack} title="Previous Track" aria-label="Previous track">
                <SkipBack size={26} />
              </button>

              <button className="control-btn play-btn" onClick={togglePlay} title={isPlaying ? 'Pause' : 'Play'} aria-label={isPlaying ? 'Pause' : 'Play'}>
                {isPlaying ? <Pause size={28} fill="currentColor" /> : <Play size={28} fill="currentColor" style={{ marginLeft: '4px' }} />}
              </button>

              <button className="control-btn" onClick={nextTrack} title="Next Track" aria-label="Next track">
                <SkipForward size={26} />
              </button>
            </div>
          )}

          {/* Local Volume */}
          <div className="volume-control">
            <button className="control-btn" onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'} aria-label={isMuted ? 'Unmute' : 'Mute'}>
              {isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={isMuted ? 0 : volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="volume-slider"
              aria-label="Volume"
            />
            {isBuffering && (
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-color)', marginLeft: '8px' }}>
                Buffering...
              </span>
            )}
          </div>

          {/* Host Presets Bar */}
          {isHost && (
            <div className="preset-tracks-bar">
              {tracks.map((track, idx) => (
                <button
                  key={`${track.id}-${idx}`}
                  className={`preset-chip ${idx === currentTrackIndex ? 'active' : ''}`}
                  onClick={() => loadTrack(track)}
                  title={track.title}
                >
                  <Music size={12} />
                  <span style={{ maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {track.artist || track.title}
                  </span>
                </button>
              ))}

              <button
                className="preset-chip"
                onClick={() => setShowCustomInput(!showCustomInput)}
                style={{ background: 'hsla(var(--hue), 10%, 30%, 0.3)' }}
              >
                <Plus size={12} />
                Add URL
              </button>
            </div>
          )}

          {isHost && showCustomInput && (
            <form onSubmit={handleAddCustomTrack} className="custom-track-form">
              <input
                type="text"
                className="chat-input"
                aria-label="YouTube video URL or ID"
                placeholder="Paste YouTube Video URL or ID..."
                value={customUrlInput}
                onChange={(e) => setCustomUrlInput(e.target.value)}
                autoFocus
              />
              <button type="submit" className="auth-submit" style={{ padding: '0 16px', margin: 0 }}>
                Play
              </button>
            </form>
          )}

          {/* Mobile-only shortcut into the queue sheet (see P4) */}
          <button type="button" className="queue-sheet-trigger" onClick={openQueue} aria-haspopup="dialog">
            <ListMusic size={16} aria-hidden="true" />
            <span className="queue-trigger-label">
              {queue.length > 0 ? `Up next: ${queue[0].title}` : 'Queue is empty — request a song'}
            </span>
            {queue.length > 0 && <span className="tab-count-pill">{queue.length}</span>}
          </button>
        </section>
      </main>

      {/* SIDEBAR: TABBED CHAT & QUEUE */}
      <aside className="sidebar glass-panel" aria-label="Chat and queue">
        <div className="sidebar-tab-header">
          <button
            className={`sidebar-tab-btn ${sidebarTab === 'chat' ? 'active' : ''}`}
            onClick={() => setSidebarTab('chat')}
          >
            <MessageSquare size={16} />
            <span>Chat</span>
          </button>

          <button
            className={`sidebar-tab-btn ${sidebarTab === 'queue' ? 'active' : ''}`}
            onClick={openQueue}
          >
            <ListMusic size={16} />
            <span>Queue</span>
            {queue.length > 0 && <span className="tab-count-pill">{queue.length}</span>}
          </button>

          <div
            className="sidebar-live-status"
            style={{
              color: isConnected ? 'var(--success-color)' : '#eab308',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                background: isConnected ? 'var(--success-color)' : '#eab308',
                borderRadius: '50%',
              }}
            />
            {isConnected ? 'Live' : 'Connecting'}
            {chatError && (
              <button
                className="recent-chip"
                style={{ marginLeft: '8px' }}
                title={chatError}
                onClick={() => window.location.reload()}
              >
                Retry
              </button>
            )}
          </div>
        </div>

        {/* TAB 1: LIVE CHAT */}
        {sidebarTab === 'chat' && (
          <>
            <div className="chat-messages">
              {chatMessages.length === 0 && (
                <div className="chat-empty-state" role="status">
                  <MessageSquare size={28} aria-hidden="true" />
                  <p>No messages yet</p>
                  <span>Say hi below — or paste a YouTube link to share a song.</span>
                </div>
              )}
              {chatMessages.map((msg) => {
                const detectedYtId = extractYouTubeId(msg.text);
                return (
                  <div key={msg.id} className="message">
                    <div className="message-header">
                      <span className="message-user" style={{ color: msg.user === 'Host' ? 'var(--accent-color)' : 'var(--text-secondary)' }}>
                        {msg.user}
                      </span>
                      <span className="message-time">{msg.time}</span>
                    </div>
                    <div className="message-content">
                      <div>{msg.text}</div>
                      {detectedYtId && (
                        <div className="chat-quick-actions">
                          <button
                            className="chat-quick-play"
                            onClick={() => {
                              requestSong(detectedYtId, safeStoredDisplayName(getStoredDisplayName()));
                              showToast('Song added to room queue!');
                            }}
                          >
                            <Plus size={12} /> Add to Queue
                          </button>
                          {isHost && (
                            <button
                              className="chat-quick-play"
                              style={{ background: 'transparent', border: '1px solid hsla(var(--hue), 10%, 40%, 0.5)', color: 'var(--text-secondary)' }}
                              onClick={() =>
                                loadTrack({
                                  id: detectedYtId,
                                  title: `Requested Video (${detectedYtId})`,
                                  artist: msg.user,
                                  albumArt: getYouTubeThumbnail(detectedYtId),
                                  provider: 'youtube',
                                  url: `https://www.youtube.com/watch?v=${detectedYtId}`,
                                })
                              }
                            >
                              <Play size={12} fill="currentColor" /> Play Now
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>

            <form className="chat-input-container" onSubmit={handleSendMessage}>
              <input
                type="text"
                className="chat-input"
                aria-label="Chat message"
                placeholder="Type message or paste YouTube link..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={500}
              />
              <button type="submit" className="send-button" title="Send" aria-label="Send message">
                <Send size={18} />
              </button>
            </form>
          </>
        )}

        {/* TAB 2: COLLABORATIVE SONG QUEUE */}
        {sidebarTab === 'queue' && (
          <SongQueuePanel
            queue={queue}
            isHost={isHost}
            sessionId={sessionId}
            myQueuedCount={myQueuedCount}
            onOpenRequestModal={() => setShowRequestModal(true)}
            onToggleUpvote={toggleUpvote}
            onPlayQueuedSong={handlePlayQueuedTrack}
            onDismissSong={(id) => updateStatus(id, 'rejected')}
          />
        )}
      </aside>

      {/* MOBILE NOW-PLAYING MINI-BAR (phones only — the doorway to the overlay) */}
      <button type="button" className="player-mini-bar" onClick={() => setNowPlayingOpen(true)} aria-expanded={nowPlayingOpen} aria-controls="now-playing-panel" aria-label={`Open now playing: ${currentTrack.title}`}>
        <img src={currentTrack.albumArt || getYouTubeThumbnail(currentTrack.id)} alt="" aria-hidden="true" className="mini-art" />
        <span className="mini-meta" aria-hidden="true">
          <span className="mini-title">{currentTrack.title}</span>
          <span className="mini-artist">{currentTrack.artist}</span>
        </span>
        <span className="mini-progress" aria-hidden="true">
          <span className="mini-progress-fill" style={{ width: `${progress}%` }} />
        </span>
        <ChevronUp size={18} aria-hidden="true" className="mini-chevron" />
      </button>

      {/* MOBILE QUEUE BOTTOM SHEET (phones only — hidden on desktop via CSS) */}
      {queueSheetOpen && (
        <div className="sheet-root">
          <div className="sheet-scrim" onClick={() => setQueueSheetOpen(false)} aria-hidden="true" />
          <div className="sheet-panel glass-panel" role="dialog" aria-modal="true" aria-label="Song queue">
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-head">
              <h3>Up next</h3>
              <button
                type="button"
                className="sheet-close"
                onClick={() => setQueueSheetOpen(false)}
                aria-label="Close queue"
                autoFocus
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <SongQueuePanel
              queue={queue}
              isHost={isHost}
              sessionId={sessionId}
              myQueuedCount={myQueuedCount}
              onOpenRequestModal={() => setShowRequestModal(true)}
              onToggleUpvote={toggleUpvote}
              onPlayQueuedSong={(track, id) => {
                handlePlayQueuedTrack(track, id);
                setQueueSheetOpen(false);
              }}
              onDismissSong={(id) => updateStatus(id, 'rejected')}
            />
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toast && (
        <div className="toast glass-panel">
          <CheckCircle2 size={16} color="var(--accent-color)" />
          {toast}
        </div>
      )}
    </div>
  );
};
