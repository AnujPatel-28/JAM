import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radio, Plus, ArrowRight, RefreshCw, LogIn, LogOut, CheckCircle2, AlertCircle, AudioWaveform, MessagesSquare, ListMusic, Lock, History } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { insforge } from '../lib/insforge';
import { getOrCreateSessionId, getStoredDisplayName, setStoredDisplayName, setRoomPasswordMemory } from '../lib/session';
import { isReservedDisplayName } from '../lib/displayName';
import { CreateRoomModal } from '../components/CreateRoomModal';
import { PasswordPromptModal } from '../components/PasswordPromptModal';
import { RoomCard, type RoomListItem } from '../components/RoomCard';
import { AuthModal } from '../components/AuthModal';

export const LobbyPage: React.FC = () => {
  const navigate = useNavigate();
  const auth = useAuth();

  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [displayName, setDisplayName] = useState(getStoredDisplayName());
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [targetPrivateRoom, setTargetPrivateRoom] = useState<RoomListItem | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'success' | 'error' } | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [recentRooms, setRecentRooms] = useState<Array<{ code: string; name?: string; at: number }>>(() => {
    try {
      const raw = localStorage.getItem('wj_recent_rooms');
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      // 022: validate shape + drop entries older than 24h (rooms are ephemeral).
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return parsed
        .filter(
          (r: any) =>
            r && typeof r.code === 'string' && /^[A-Z0-9]{3,8}$/.test(r.code) &&
            typeof r.at === 'number' && r.at > cutoff &&
            (r.name === undefined || typeof r.name === 'string')
        )
        .map((r: any) => ({ code: r.code, name: r.name?.slice(0, 60), at: r.at }))
        .slice(0, 5);
    } catch {
      return [];
    }
  });
  const [authModal, setAuthModal] = useState<'signin' | 'signup' | null>(null);
  // New-user journey: logged-out Create → signup → verify → straight into
  // the Create Room modal (no dead-end retap). Set on entry, consumed once
  // the user object appears.
  const createAfterAuthRef = React.useRef(false);

  React.useEffect(() => {
    if (auth.user && createAfterAuthRef.current) {
      createAfterAuthRef.current = false;
      setAuthModal(null);
      setShowCreateModal(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.user]);

  const showToast = (msg: string, kind: 'success' | 'error' = 'success') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), kind === 'error' ? 5000 : 3000);
  };

  const extractRoomCode = (value: string): string => {
    // Accept pasted invite links (…/room/JAM402) as well as bare codes.
    const linkMatch = value.match(/room\/([A-Za-z0-9]{3,8})/i);
    const source = linkMatch ? linkMatch[1] : value;
    return source.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  };

  const pushRecent = (code: string, name?: string) => {
    setRecentRooms((prev) => {
      const next = [{ code, name, at: Date.now() }, ...prev.filter((r) => r.code !== code)].slice(0, 5);
      try {
        localStorage.setItem('wj_recent_rooms', JSON.stringify(next));
      } catch {
        // Private mode — recents simply don't persist.
      }
      return next;
    });
  };

  // M: purge_expired_rooms() is anon-callable and lobby auto-refreshes every
  // 15s — throttle the RPC to at most once per 60s per tab to avoid DB-wide
  // delete pressure. Server cron remains the real janitor.
  const lastPurgeRef = React.useRef(0);

  const fetchRooms = useCallback(async (isBackground = false) => {
    setLoadingRooms(true);
    try {
      // Lazy purge of expired rooms (throttled)
      const now = Date.now();
      if (now - lastPurgeRef.current > 60_000) {
        lastPurgeRef.current = now;
        try {
          await insforge.database.rpc('purge_expired_rooms');
        } catch {
          // Non-fatal: directory still loads; next tick retries after cooldown.
        }
      }

      // 1. Fetch active, non-expired PUBLIC rooms only (C2: private rooms must
      // not leak id/code/host via the directory; join private via code + RPC).
      // Explicit columns: never select('*') — host_id/playback_state stay server-side.
      const nowIso = new Date().toISOString();
      const { data: roomRows, error: roomErr } = await insforge.database
        .from('rooms')
        .select('id,code,name,description,is_private,max_members,created_at')
        .eq('is_active', true)
        .eq('is_private', false)
        .gt('expires_at', nowIso)
        .order('created_at', { ascending: false })
        .limit(20);

      if (roomErr || !roomRows) {
        // Error is a state, not an empty room: never wipe a good list on a
        // failed background poll — name it and keep the stale rooms visible.
        if (!isBackground) {
          setRooms([]);
        }
        setRoomsError('Could not load rooms. Check your connection and try again.');
        return;
      }

      // 2. Fetch member counts scoped to listed rooms only (C2: avoid full-table
      // presence dump; M2). If the scoped query fails (RLS), fall back to zero.
      const thirtySecsAgo = new Date(Date.now() - 45 * 1000).toISOString();
      const listedIds = (roomRows as any[]).map((r) => r.id).filter(Boolean);
      let memberRows: Array<{ room_id: string }> | null = null;
      if (listedIds.length > 0) {
        const { data } = await insforge.database
          .from('room_members')
          .select('room_id')
          .in('room_id', listedIds)
          .gte('last_seen', thirtySecsAgo);
        memberRows = (data as Array<{ room_id: string }>) ?? null;
      }

      const countMap: Record<string, number> = {};
      if (memberRows && Array.isArray(memberRows)) {
        for (const m of memberRows) {
          countMap[m.room_id] = (countMap[m.room_id] || 0) + 1;
        }
      }

      const formatted: RoomListItem[] = roomRows.map((r: any) => ({
        id: r.id,
        name: r.name,
        code: r.code || 'MAIN01',
        is_private: !!r.is_private,
        max_members: r.max_members || 5,
        description: r.description,
        active_count: countMap[r.id] || 0,
        created_at: r.created_at,
      }));

      setRooms(formatted);
      setRoomsError(null);
      setLastUpdatedAt(Date.now());
    } catch {
      if (!isBackground) {
        setRooms([]);
      }
      setRoomsError('Could not load rooms. Check your connection and try again.');
    } finally {
      setLoadingRooms(false);
    }
  }, []);

  useEffect(() => {
    fetchRooms();
    const interval = setInterval(() => fetchRooms(true), 15000);
    return () => clearInterval(interval);
  }, [fetchRooms]);

  // Heartbeat so "Updated Xs ago" stays honest between 15s directory polls.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // Solidify the floating glass nav once content scrolls beneath it —
  // translucent + sticky otherwise ghosts form fields through the bar.
  const [navScrolled, setNavScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleJoinByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = extractRoomCode(roomCodeInput);
    const cleanName = displayName.trim();
    if (cleanCode.length < 3) {
      setFieldError('Enter the 3–8 character code from the invite. A full invite link works too.');
      showToast('Enter the 3–8 character code from the invite.', 'error');
      return;
    }
    if (cleanName.length < 2) {
      setFieldError('Choose a display name with at least 2 characters.');
      showToast('Choose a display name with at least 2 characters.', 'error');
      return;
    }
    // Phase D (docs/013): block reserved/impersonating names before join.
    if (isReservedDisplayName(cleanName)) {
      setFieldError('That name is reserved. Choose another display name.');
      showToast('That name is reserved. Choose another display name.', 'error');
      return;
    }

    setFieldError(null);
    setStoredDisplayName(cleanName);
    pushRecent(cleanCode);
    navigate(`/room/${cleanCode}`);
  };

  const handleRoomCardClick = (room: RoomListItem) => {
    const cleanName = displayName.trim();
    if (cleanName.length < 2) {
      setFieldError('Choose a display name with at least 2 characters.');
      showToast('Choose a display name with at least 2 characters.', 'error');
      return;
    }
    if (isReservedDisplayName(cleanName)) {
      setFieldError('That name is reserved. Choose another display name.');
      showToast('That name is reserved. Choose another display name.', 'error');
      return;
    }
    setFieldError(null);
    setStoredDisplayName(cleanName);
    pushRecent(room.code, room.name);
    if (room.is_private) {
      setTargetPrivateRoom(room);
    } else {
      navigate(`/room/${room.code}`);
    }
  };

  const handlePrivatePasswordSubmit = async (password: string): Promise<string | null> => {
    if (!targetPrivateRoom) return 'No room selected';
    const sessionId = getOrCreateSessionId();
    const cleanName = displayName.trim() || getStoredDisplayName();

    try {
      const { data, error } = await insforge.database.rpc('join_room_secure', {
        p_code: targetPrivateRoom.code,
        p_session_id: sessionId,
        p_display_name: cleanName,
        p_password: password,
      });

      if (error) return error.message;
      if (data?.success) {
        // C3/H4: memory-only password (never sessionStorage — XSS-readable).
        // Kept for the session lifecycle so RoomPage can rejoin on refresh.
        setRoomPasswordMemory(targetPrivateRoom.code, password);
        pushRecent(targetPrivateRoom.code, targetPrivateRoom.name);
        navigate(`/room/${targetPrivateRoom.code}`, { state: { password } });
        return null;
      }
      return data?.error || 'Could not verify password.';
    } catch (err: any) {
      return err?.message || 'Error joining room.';
    }
  };

  return (
    <div className="lobby-container">
      {/* Lobby Navigation Header */}
      <header className={`lobby-nav glass-panel${navScrolled ? ' nav-scrolled' : ''}`}>
        <div className="logo">
          <span className="logo-mark" aria-hidden="true">
            <Radio size={20} color="#fff" strokeWidth={2.5} />
          </span>
          <span>JAM</span>
        </div>

        <div className="lobby-nav-right">
          {auth.loading ? (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }} role="status">Loading...</span>
          ) : auth.user ? (
            <div className="lobby-auth-pill">
              <span className="lobby-user-name">{auth.user.name || auth.user.email}</span>
              <button className="lobby-icon-btn" onClick={auth.signOut} title="Sign Out" aria-label="Sign out">
                <LogOut size={16} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button className="lobby-login-btn" onClick={() => setAuthModal('signin')}>
              <LogIn size={15} aria-hidden="true" />
              <span>Sign In to Host</span>
            </button>
          )}
        </div>
      </header>

      {/* Hero Section */}
      <section className="lobby-hero" aria-labelledby="lobby-title">
        <div className="lobby-hero-badge">
          <span className="pulse-dot" aria-hidden="true" />
          <span>Live social listening rooms</span>
        </div>

        <h1 id="lobby-title" className="lobby-hero-title">
          Listen Together in <span className="hero-gradient-text">Real-Time</span>.
        </h1>

        <p className="lobby-hero-subtitle">
          Join with a room code or invite link — free for listeners, no app needed. Hosts run the music, everyone shapes the queue.
        </p>

        {/* Join by Code & Action Area */}
        <div className="lobby-actions-card glass-panel">
          <form className="join-code-form" onSubmit={handleJoinByCode} autoComplete="off" noValidate={false}>
            <div className="input-with-label">
              <label className="input-micro-label" htmlFor="room-code">Room code</label>
              <input
                id="room-code"
                type="text"
                className="code-input"
                placeholder="JAM402"
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(extractRoomCode(e.target.value))}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData('text');
                  if (pasted && /room\//i.test(pasted)) {
                    e.preventDefault();
                    setRoomCodeInput(extractRoomCode(pasted));
                  }
                }}
                maxLength={8}
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="room-code-hint"
                aria-invalid={!!fieldError}
              />
            </div>

            <div className="input-with-label" style={{ flex: 1 }}>
              <label className="input-micro-label" htmlFor="display-name">Your name</label>
              <input
                id="display-name"
                type="text"
                className="name-input"
                placeholder="e.g. Anuj"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  if (fieldError) setFieldError(null);
                }}
                maxLength={24}
                autoComplete="nickname"
                aria-describedby="room-code-hint"
                aria-invalid={!!fieldError}
              />
            </div>

            <button type="submit" className="hero-join-btn">
              <span>Join Room</span>
              <ArrowRight size={16} strokeWidth={2.5} aria-hidden="true" />
            </button>
          </form>

          <p id="room-code-hint" className="form-hint" style={{ marginTop: '10px' }}>
            Got an invite link? Paste it in the code field. Letters A–Z and 0–9 only.
          </p>
          {fieldError && (
            <p className="field-error" role="alert">{fieldError}</p>
          )}

          {recentRooms.length > 0 && (
            <div className="recent-rooms">
              <span className="recent-label"><History size={13} aria-hidden="true" /> Recent rooms</span>
              <div className="recent-chips">
                {recentRooms.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    className="recent-chip"
                    onClick={() => {
                      // 022: recent chips bypass the join form — enforce the
                      // same display-name rules here (length + reservation).
                      const cleanName = displayName.trim() || getStoredDisplayName();
                      if (cleanName.length < 2) {
                        setFieldError('Choose a display name with at least 2 characters.');
                        showToast('Choose a display name with at least 2 characters.', 'error');
                        return;
                      }
                      if (isReservedDisplayName(cleanName)) {
                        setFieldError('That name is reserved. Choose another display name.');
                        showToast('That name is reserved. Choose another display name.', 'error');
                        return;
                      }
                      setFieldError(null);
                      setRoomCodeInput(r.code);
                      setStoredDisplayName(cleanName);
                      pushRecent(r.code, r.name);
                      navigate(`/room/${r.code}`);
                    }}
                    title={r.name ? `${r.name} (${r.code})` : r.code}
                  >
                    {r.code}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="lobby-divider">
            <span>or</span>
          </div>

          <button
            className="hero-create-btn"
            onClick={() => {
              if (!auth.user) {
                // Newcomers most likely need an account — open signup mode;
                // the modal links back to sign in. After auth, continue here.
                createAfterAuthRef.current = true;
                setAuthModal('signup');
              } else {
                setShowCreateModal(true);
              }
            }}
          >
            {!auth.user && <Lock size={16} strokeWidth={2.5} aria-hidden="true" />}
            {auth.user && <Plus size={18} strokeWidth={2.5} aria-hidden="true" />}
            <span>Create New Room</span>
          </button>
          <p className="host-hint">
            {!auth.user ? 'Sign in to host · Listening is always free' : 'Public or private · up to 5 listeners · auto-expires in 24h'}
          </p>
        </div>

        <div className="lobby-features">
          <div className="feature-mini">
            <span className="feature-mini-icon" aria-hidden="true"><AudioWaveform size={16} /></span>
            <div><b>In-sync playback</b><span>Everyone hears the same moment</span></div>
          </div>
          <div className="feature-mini">
            <span className="feature-mini-icon" aria-hidden="true"><MessagesSquare size={16} /></span>
            <div><b>Live chat</b><span>Messages and YouTube links</span></div>
          </div>
          <div className="feature-mini">
            <span className="feature-mini-icon" aria-hidden="true"><ListMusic size={16} /></span>
            <div><b>Shared queue</b><span>Request songs and upvote</span></div>
          </div>
        </div>
      </section>

      {/* Public Rooms Directory */}
      <section className="lobby-rooms-section" aria-labelledby="rooms-heading">
        <div className="rooms-section-header">
          <div>
            <h2 id="rooms-heading">
              Active listening rooms
              {rooms.length > 0 && (
                <span className="live-count"><span className="live-dot" aria-hidden="true" />{rooms.length} live</span>
              )}
            </h2>
            <p className="section-subtitle">
              Open broadcasts you can join instantly
              {lastUpdatedAt && !loadingRooms && (
                <> · Updated {Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000))}s ago</>
              )}
            </p>
          </div>

          <button className="refresh-rooms-btn" onClick={() => fetchRooms()} disabled={loadingRooms} title="Refresh rooms" aria-label="Refresh rooms">
            <RefreshCw size={15} className={loadingRooms ? 'spinning' : ''} aria-hidden="true" />
            <span>Refresh</span>
          </button>
        </div>

        {loadingRooms && rooms.length === 0 && !roomsError ? (
          <>
            <span className="sr-only" role="status">Discovering live rooms…</span>
            <div className="rooms-grid" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="room-card room-skeleton">
                  <div className="sk-line sk-title" />
                  <div className="sk-line sk-tag" />
                  <div className="sk-line sk-desc" />
                  <div className="sk-footer">
                    <div className="sk-line sk-pill" />
                    <div className="sk-line sk-btn" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : roomsError && rooms.length === 0 ? (
          <div className="rooms-error-state glass-panel" role="alert">
            <div className="empty-icon-wrap" aria-hidden="true">
              <AlertCircle size={28} />
            </div>
            <h3>Couldn't load rooms</h3>
            <p>Check your connection — your code and name above are safe.</p>
            <button
              className="hero-create-btn"
              style={{ marginTop: '16px', maxWidth: '260px' }}
              onClick={() => fetchRooms()}
            >
              <RefreshCw size={16} strokeWidth={2.5} aria-hidden="true" /> Try Again
            </button>
          </div>
        ) : rooms.length === 0 ? (
          <div className="rooms-empty-state glass-panel">
            <div className="empty-icon-wrap" aria-hidden="true">
              <Radio size={28} />
            </div>
            <h3>No live rooms right now</h3>
            <p>Quiet for the moment — start a room and share the link so friends can join.</p>
            <button
              className="hero-create-btn"
              style={{ marginTop: '16px', maxWidth: '260px' }}
              onClick={() => {
                if (!auth.user) {
                  createAfterAuthRef.current = true;
                  setAuthModal('signup');
                } else setShowCreateModal(true);
              }}
            >
              <Plus size={16} strokeWidth={2.5} aria-hidden="true" /> Create New Room
            </button>
            {!auth.user && (
              <p className="host-hint">Hosting needs a free sign-in. Joining is always free.</p>
            )}
          </div>
        ) : (
          <>
            {roomsError && (
              <div className="rooms-stale-banner" role="alert">
                <AlertCircle size={14} aria-hidden="true" />
                <span>Couldn't refresh — showing last known rooms.</span>
                <button type="button" className="stale-retry" onClick={() => fetchRooms()}>
                  Retry
                </button>
              </div>
            )}
            <div className="rooms-grid">
              {rooms.map((room) => (
                <RoomCard key={room.id} room={room} onJoin={handleRoomCardClick} />
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="lobby-footer">
        <div className="lobby-footer-brand">
          <Radio size={15} aria-hidden="true" />
          <span>JAM</span>
        </div>
        <span>Free for listeners · No app needed · You join muted, host runs the music</span>
      </footer>

      {/* Create Room Modal */}
      {showCreateModal && (
        <CreateRoomModal
          onClose={() => setShowCreateModal(false)}
          onSuccess={(code) => {
            setShowCreateModal(false);
            setStoredDisplayName(displayName.trim() || getStoredDisplayName());
            pushRecent(code);
            navigate(`/room/${code}`);
          }}
        />
      )}

      {/* Private Room Password Challenge */}
      {targetPrivateRoom && (
        <PasswordPromptModal
          roomName={targetPrivateRoom.name}
          roomCode={targetPrivateRoom.code}
          onClose={() => setTargetPrivateRoom(null)}
          onSubmit={handlePrivatePasswordSubmit}
        />
      )}

      {/* Host Auth Modal */}
      {authModal && (
        <AuthModal
          mode={authModal}
          onClose={() => { setAuthModal(null); createAfterAuthRef.current = false; }}
          onSignIn={auth.signIn}
          onSignUp={auth.signUp}
          onVerify={auth.verifyEmail}
          onResend={auth.resendVerification}
          onRequestReset={auth.requestPasswordReset}
          onVerifyReset={auth.verifyResetCode}
          onConfirmReset={auth.confirmPasswordReset}
          onSwitchMode={() => setAuthModal((m) => (m === 'signin' ? 'signup' : 'signin'))}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div className={`toast glass-panel toast-${toast.kind}`} role="status" aria-live="polite">
          {toast.kind === 'error' ? (
            <AlertCircle size={16} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={16} aria-hidden="true" />
          )}
          {toast.msg}
        </div>
      )}
    </div>
  );
};
