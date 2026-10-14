import { useState, useEffect, useRef, useCallback } from 'react';
import type { YouTubePlayer, YouTubeProps } from 'react-youtube';
import type { MusicTrack } from '../lib/providers/types';
import { formatTime } from '../lib/providers/types';
import { DEFAULT_YOUTUBE_TRACKS, getYouTubeThumbnail } from '../lib/providers/youtube';
import { insforge } from '../lib/insforge';
import { realtime } from '../lib/realtime';
import { calibrateClock, getServerNow } from '../lib/clockSync';
import { isMadeForKids } from '../lib/madeForKids';

export interface SyncStatus {
  state: 'synced' | 'adjusting' | 'seeking';
  driftMs: number;
  rate?: number;
}

export interface UseYouTubeMusicOptions {
  initialTracks?: MusicTrack[];
  initialTrackIndex?: number;
  autoPlay?: boolean;
  isHost?: boolean;
  hostId?: string;
  roomId?: string;
  /** Host-only: fired when an unplayable track is auto-skipped. */
  onTrackSkipped?: (message: string) => void;
}

// --- YouTube RMF / Developer Policy gates (Phase 0 compliance) --------------
// RMF: an embedded player must show a viewport >= 200x200, and automatic
// playback must not start until the player is visible with MORE THAN HALF of
// it on the page/screen. III.I.9 additionally bans "background players"
// (not displayed on the screen the user is viewing). Every programmatic
// playVideo() below funnels through playWhenVisible().

const PLAYER_MIN_PX = 200;

function isPlayerMostlyVisible(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.querySelector('.youtube-embed-wrapper');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  // RMF minimum viewport — a collapsed/half-styled player never qualifies.
  if (r.width < PLAYER_MIN_PX || r.height < PLAYER_MIN_PX) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  const visibleArea = visW * visH;
  return visibleArea >= r.width * r.height * 0.5;
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Plays only once more than half the player is on-screen, retrying briefly so
 * layout animations (mobile now-playing tray) can finish first. Returns false
 * when the player never became eligible — callers arm pendingAutoplay instead
 * of forcing a background start.
 */
async function playWhenVisible(player: YouTubePlayer, tries = 12): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (isPlayerMostlyVisible()) {
      try {
        await player.playVideo();
        return true;
      } catch {
        return false;
      }
    }
    await sleep(250);
  }
  return false;
}

export function useYouTubeMusic({
  initialTracks = DEFAULT_YOUTUBE_TRACKS,
  initialTrackIndex = 0,
  autoPlay = false,
  isHost = false,
  hostId,
  roomId,
  onTrackSkipped,
}: UseYouTubeMusicOptions = {}) {
  const HOST_LOST_MESSAGE = 'Host connection lost — pausing until the host is back.';

  const [tracks, setTracks] = useState<MusicTrack[]>(initialTracks);
  const [currentTrackIndex, setCurrentTrackIndex] = useState<number>(initialTrackIndex);
  const [isPlaying, setIsPlaying] = useState<boolean>(autoPlay);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [progress, setProgress] = useState<number>(0);
  const [volume, setVolumeState] = useState<number>(80);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isReady, setIsReady] = useState<boolean>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  const playerRef = useRef<YouTubePlayer | null>(null);
  const currentTrack = tracks[currentTrackIndex] || DEFAULT_YOUTUBE_TRACKS[0];
  const tracksRef = useRef(tracks);
  const currentIndexRef = useRef(currentTrackIndex);
  const isPlayingRef = useRef(isPlaying);
  const isHostRef = useRef(isHost);
  const hostIdRef = useRef<string | undefined>(hostId);
  const roomIdRef = useRef<string | undefined>(roomId);
  const pendingAutoplayRef = useRef(false);
  // Per-user explicit listen consent (Developer Policies III.C.2 — YouTube
  // actions must be clearly initiated by THIS user). Host Play button and the
  // listener "Start listening" CTA grant it; sync never starts audio before it.
  const consentGrantedRef = useRef(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  // III.E.4.j: Made-For-Kids status of the current video (null = unknown).
  const madeForKidsRef = useRef<boolean | null>(null);
  const lastSyncAtRef = useRef(0);
  const lastHostPlayingRef = useRef(false);
  const volumeRef = useRef(volume);
  const currentRateRef = useRef<number>(1);
  const supportsCustomRatesRef = useRef<boolean>(true);
  // Whether the user ever picked a volume themselves — until then the 80
  // default wins even if it's currently 0 (e.g. muted by an edge-case reset).
  const volumeTouchedRef = useRef(false);
  // Host: consecutive auto-skips without a successful play — guards against
  // skip loops when every track in the queue is unavailable.
  const skipCountRef = useRef(0);
  const onTrackSkippedRef = useRef(onTrackSkipped);

  // Calibrate client clock against PostgreSQL on mount
  useEffect(() => {
    void calibrateClock();
  }, []);

  // Monotonic ordering for host broadcasts (seeded from the clock so it stays
  // increasing across host page refreshes, and immune to clock steps
  // backwards mid-session). Listeners drop anything older.
  const seqRef = useRef(Date.now());
  const nextSeq = () => {
    seqRef.current = Math.max(Date.now(), seqRef.current + 1);
    return seqRef.current;
  };
  const lastAppliedSeqRef = useRef(0);
  const lastAppliedHostIdRef = useRef<string | null>(null);
  // Pending delayed broadcast from loadTrack/nextTrack/prevTrack — cancelled
  // when a newer action (e.g. pause) supersedes it.
  const broadcastTimerRef = useRef<number | null>(null);

  // Keep refs up to date for closures
  useEffect(() => { tracksRef.current = tracks; }, [tracks]);
  useEffect(() => { currentIndexRef.current = currentTrackIndex; }, [currentTrackIndex]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { hostIdRef.current = hostId; }, [hostId]);
  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { volumeRef.current = volume; }, [volume]);
  useEffect(() => { onTrackSkippedRef.current = onTrackSkipped; }, [onTrackSkipped]);

  const clearPendingBroadcast = useCallback(() => {
    if (broadcastTimerRef.current !== null) {
      window.clearTimeout(broadcastTimerRef.current);
      broadcastTimerRef.current = null;
    }
  }, []);

  function isAuthError(err: any): boolean {
    if (!err) return false;
    const status = err.status ?? err.statusCode ?? err.code;
    if (status === 401 || status === '401') return true;
    return /unauthorized|jwt|token|expired|forbidden/i.test(String(err.message ?? err));
  }

  // Fast Path: direct WebSocket push (sub-60ms delivery, zero DB overhead).
  // Used for 3-second periodic position ticks while playing.
  const fastBroadcast = useCallback(async () => {
    if (!isHostRef.current || !playerRef.current || !roomIdRef.current) return;
    try {
      const time = await playerRef.current.getCurrentTime();
      const payload = {
        track: tracksRef.current[currentIndexRef.current],
        isPlaying: isPlayingRef.current,
        currentTime: time,
        hostId: hostIdRef.current,
        serverTime: getServerNow(),
        at: new Date().toISOString(),
        seq: nextSeq(),
      };
      realtime.publishSync(`room:${roomIdRef.current}:sync`, 'sync', payload);
    } catch (err) {
      // H5: fail loud on degraded auth so the host re-authenticates instead
      // of silently ticking as anonymous (server rejects those anyway).
      if (err instanceof Error && /degraded/i.test(err.message)) {
        setError('Your session expired — sign in again to keep broadcasting.');
      }
    }
  }, []);

  // Host Broadcast Helper: writes playback state to the rooms row (durable path)
  // AND emits immediately over WebSocket for instant delivery without DB lag.
  const broadcastSync = useCallback(async (forceIsPlaying?: boolean) => {
    if (!isHostRef.current || !playerRef.current || !roomIdRef.current) return;
    try {
      const time = await playerRef.current.getCurrentTime();
      const playbackState = {
        track: tracksRef.current[currentIndexRef.current],
        isPlaying: forceIsPlaying !== undefined ? forceIsPlaying : isPlayingRef.current,
        currentTime: time,
        hostId: hostIdRef.current,
        serverTime: getServerNow(),
        at: new Date().toISOString(),
        seq: nextSeq(),
      };

      // Fast Path: emit over WebSocket instantly so listeners react in 30ms
      try {
        realtime.publishSync(`room:${roomIdRef.current}:sync`, 'sync', playbackState);
      } catch (err) {
        if (err instanceof Error && /degraded/i.test(err.message)) {
          setError('Your session expired — sign in again to keep broadcasting.');
        }
      }

      // Durable Path: persist to rooms table for new joiners and reconnects
      const payload = {
        playback_state: playbackState,
        host_last_seen: new Date().toISOString(),
      };

      let res = await insforge.database
        .from('rooms')
        .update(payload)
        .eq('id', roomIdRef.current);

      // A rejected write usually means the JWT expired mid-session — force a
      // token refresh and retry once before giving up loudly.
      if (res?.error && isAuthError(res.error)) {
        console.warn('Playback sync rejected — refreshing session token…');
        try {
          await insforge.getHttpClient().refreshAccessToken();
        } catch {}
        res = await insforge.database
          .from('rooms')
          .update(payload)
          .eq('id', roomIdRef.current);
        if (res?.error) {
          setError('Your session has expired — sign in again to keep hosting.');
        }
        return;
      }
    } catch (err) {
      console.warn('Sync broadcast failed:', err);
    }
  }, []);

  // Sync volume with player
  const setVolume = useCallback(async (newVolume: number) => {
    const clamped = Math.max(0, Math.min(100, newVolume));
    volumeTouchedRef.current = true;
    setVolumeState(clamped);
    if (playerRef.current) {
      try {
        await playerRef.current.setVolume(clamped);
        if (clamped > 0 && isMuted) {
          await playerRef.current.unMute();
          setIsMuted(false);
        }
      } catch (err) {
        console.warn('Error setting volume:', err);
      }
    }
  }, [isMuted]);

  // Toggle mute
  const toggleMute = useCallback(async () => {
    if (!playerRef.current) return;
    try {
      if (isMuted) {
        await playerRef.current.unMute();
        setIsMuted(false);
      } else {
        await playerRef.current.mute();
        setIsMuted(true);
      }
    } catch (err) {
      console.warn('Error toggling mute:', err);
    }
  }, [isMuted]);

  // Play — invoked from the host's own control button, so this click IS the
  // user's explicit, clearly-initiated action (III.C.2): grant consent here.
  const play = useCallback(async () => {
    if (!playerRef.current) return;
    try {
      consentGrantedRef.current = true;
      setNeedsConsent(false);
      pendingAutoplayRef.current = false;
      // Update the ref before awaiting so in-flight interval ticks broadcast
      // the correct state even if they resolve after this call.
      isPlayingRef.current = true;
      clearPendingBroadcast();
      if (!isPlayerMostlyVisible()) {
        // Never start a background player (III.I.9) — arm a retry instead;
        // the visibility-retry effect + user gestures pick it up on-screen.
        pendingAutoplayRef.current = true;
        setIsPlaying(true);
        setError(null);
        if (isHostRef.current) await broadcastSync(true);
        return;
      }
      await playerRef.current.playVideo();
      setIsPlaying(true);
      setError(null);
      if (isHostRef.current) await broadcastSync(true);
    } catch (err) {
      console.warn('Error playing video:', err);
    }
  }, [broadcastSync, clearPendingBroadcast]);

  // Pause
  const pause = useCallback(async () => {
    if (!playerRef.current) return;
    try {
      // See play(): ref first, and cancel any scheduled "playing" broadcast
      // (e.g. from a track load) that would otherwise land after our pause.
      isPlayingRef.current = false;
      clearPendingBroadcast();
      await playerRef.current.pauseVideo();
      setIsPlaying(false);
      if (isHostRef.current) await broadcastSync(false);
    } catch (err) {
      console.warn('Error pausing video:', err);
    }
  }, [broadcastSync, clearPendingBroadcast]);

  // Toggle play/pause
  const togglePlay = useCallback(async () => {
    if (isPlaying) {
      await pause();
    } else {
      await play();
    }
  }, [isPlaying, pause, play]);

  // Seek by seconds
  const seekTo = useCallback(async (seconds: number) => {
    if (!playerRef.current) return;
    try {
      await playerRef.current.seekTo(seconds, true);
      setCurrentTime(seconds);
      if (duration > 0) {
        setProgress((seconds / duration) * 100);
      }
      if (isHostRef.current) await broadcastSync();
    } catch (err) {
      console.warn('Error seeking:', err);
    }
  }, [duration, broadcastSync]);

  // Seek by percentage (0 - 100)
  const seekByPercentage = useCallback(async (pct: number) => {
    const targetPercentage = Math.max(0, Math.min(100, pct));
    if (duration > 0) {
      const targetSeconds = (targetPercentage / 100) * duration;
      await seekTo(targetSeconds);
    }
  }, [duration, seekTo]);

  // Schedule a delayed broadcast, replacing any previously scheduled one so
  // rapid actions (load → next → pause) never emit stale states out of order.
  const scheduleBroadcast = useCallback(() => {
    clearPendingBroadcast();
    broadcastTimerRef.current = window.setTimeout(() => {
      broadcastTimerRef.current = null;
      broadcastSync(true);
    }, 500);
  }, [broadcastSync, clearPendingBroadcast]);

  // Load a new track immediately (adds to queue if not present)
  const loadTrack = useCallback((track: MusicTrack) => {
    const prev = tracksRef.current;
    const next = prev.some((t) => t.id === track.id) ? prev : [...prev, track];
    const idx = Math.max(0, next.findIndex((t) => t.id === track.id));

    tracksRef.current = next;
    currentIndexRef.current = idx;
    setTracks(next);
    setCurrentTrackIndex(idx);
    setCurrentTime(0);
    setProgress(0);
    setError(null);

    if (isHostRef.current) scheduleBroadcast();
  }, [scheduleBroadcast]);

  // Queue a track to be played later
  const queueTrack = useCallback((track: MusicTrack) => {
    setTracks((prev) => {
      if (prev.some((t) => t.id === track.id)) return prev;
      const next = [...prev, track];
      tracksRef.current = next;
      return next;
    });
  }, []);

  // Next Track
  const nextTrack = useCallback(() => {
    const count = tracksRef.current.length;
    if (count === 0) return;
    const nextIdx = (currentIndexRef.current + 1) % count;

    currentIndexRef.current = nextIdx;
    setCurrentTrackIndex(nextIdx);
    setCurrentTime(0);
    setProgress(0);
    setError(null);

    if (isHostRef.current) scheduleBroadcast();
  }, [scheduleBroadcast]);

  // Previous Track
  const prevTrack = useCallback(() => {
    const count = tracksRef.current.length;
    if (count === 0) return;
    const nextIdx = (currentIndexRef.current - 1 + count) % count;

    currentIndexRef.current = nextIdx;
    setCurrentTrackIndex(nextIdx);
    setCurrentTime(0);
    setProgress(0);
    setError(null);

    if (isHostRef.current) scheduleBroadcast();
  }, [scheduleBroadcast]);

  // HOST: Periodic sync broadcast (every 3 seconds) & Progress update timer (300ms)
  useEffect(() => {
    if (!isPlaying || !playerRef.current) return;

    let syncCounter = 0;

    const interval = setInterval(async () => {
      if (!playerRef.current) return;
      try {
        const [currTime, totalDuration] = await Promise.all([
          playerRef.current.getCurrentTime(),
          playerRef.current.getDuration(),
        ]);

        if (typeof currTime === 'number' && !isNaN(currTime)) {
          setCurrentTime(currTime);
        }

        if (typeof totalDuration === 'number' && !isNaN(totalDuration) && totalDuration > 0) {
          setDuration(totalDuration);
          if (typeof currTime === 'number' && !isNaN(currTime)) {
            const calculatedProgress = Math.min(100, Math.max(0, (currTime / totalDuration) * 100));
            setProgress(calculatedProgress);
          }
        }

        // Host broadcasts position every 3 seconds via fast WebSocket path (zero DB writes).
        // Uses the live ref so a tick racing a pause can never resurrect "playing".
        if (isHostRef.current) {
          syncCounter++;
          if (syncCounter >= 10) { // 10 * 300ms = 3000ms
            syncCounter = 0;
            fastBroadcast();
          }
        }
      } catch {
        // Player might be re-initializing or unmounted
      }
    }, 300);

    return () => clearInterval(interval);
  }, [isPlaying, fastBroadcast]);

  // BOTH: Subscribe to player_sync channel (Host must join to broadcast)

  // Fetch the authoritative playback_state straight from the rooms row.
  const fetchPlaybackState = useCallback(async () => {
    if (!roomIdRef.current) return null;
    try {
      const { data, error } = await insforge.database
        .from('rooms')
        .select('playback_state')
        .eq('id', roomIdRef.current)
        .limit(1);
      if (error) return null;
      const row = Array.isArray(data) ? data[0] : (data as any);
      return row?.playback_state ?? null;
    } catch {
      return null;
    }
  }, []);

  // Apply an authoritative playback state (from realtime OR a DB fetch).
  // Returns false when the state was rejected/stale.
  const applyPlaybackState = useCallback(async (rawState: any) => {
    const state = rawState?.data || rawState?.payload || rawState;
    if (!state || !state.track) return false;
    if (isHostRef.current) return false; // Host dictates, doesn't react

    // C1: validate inbound track before it reaches the iframe embed.
    // Server RLS is the enforcer; this is defense-in-depth against forged
    // sync payloads (arbitrary videoId / thumbnail tracker URLs).
    const incomingId = typeof state.track?.id === 'string' ? state.track.id : '';
    if (!/^[a-zA-Z0-9_-]{11}$/.test(incomingId)) return false;
    const incomingArt = typeof state.track?.albumArt === 'string' ? state.track.albumArt : null;
    if (
      incomingArt &&
      !(
        incomingArt.startsWith('https://img.youtube.com/') ||
        incomingArt.startsWith('https://i.ytimg.com/')
      )
    ) {
      return false;
    }

    // Ignore sync events that don't come from the room's actual host.
    // Once we know the room's host id, events MUST carry a matching one.
    // (Best-effort: the host id is publicly readable, so a determined
    // attacker can still spoof it — real enforcement must be server-side.)
    if (hostIdRef.current && state.hostId !== hostIdRef.current) {
      return false;
    }

    // Drop out-of-order or duplicate deliveries (network reorder, reconnect
    // overlaps) so an old "playing" can never overwrite a newer "paused".
    // Exception: when a DIFFERENT host takes over the room, its seq counter
    // is independent — accept it and re-baseline.
    const hostChanged =
      typeof state.hostId === 'string' &&
      lastAppliedHostIdRef.current !== null &&
      state.hostId !== lastAppliedHostIdRef.current;
    if (typeof state.seq === 'number') {
      // 022: seq window — a forged far-future seq (with a spoofed hostId)
      // would otherwise pin lastAppliedSeq forever and drop every legitimate
      // tick until reload. seq is Date.now-based; anything >10min ahead of us
      // or >24h behind is anomalous → drop and reconcile from the DB.
      const now = Date.now();
      if (!hostChanged && (state.seq - now > 10 * 60 * 1000 || now - state.seq > 24 * 60 * 60 * 1000)) {
        void fetchPlaybackState().then((fresh) => {
          if (fresh) void applyPlaybackState(fresh);
        });
        return false;
      }
      if (!hostChanged && state.seq <= lastAppliedSeqRef.current) return false;
      lastAppliedSeqRef.current = state.seq;
    }
    if (typeof state.hostId === 'string') {
      lastAppliedHostIdRef.current = state.hostId;
    }

    // 022: clamp sync numerics/strings — forged currentTime (seek-DoS) or
    // absurd serverTime (transit-math blowup) must not reach the player.
    if (typeof state.currentTime === 'number') {
      if (!Number.isFinite(state.currentTime) || state.currentTime < 0 || state.currentTime > 8 * 3600) {
        return false;
      }
    }
    if (typeof state.serverTime === 'number') {
      if (!Number.isFinite(state.serverTime) || Math.abs(Date.now() - state.serverTime) > 5 * 60 * 1000) {
        return false;
      }
    }
    if (typeof state.track?.title === 'string' && state.track.title.length > 200) return false;
    if (typeof state.track?.artist === 'string' && state.track.artist.length > 200) return false;

    lastSyncAtRef.current = Date.now();
    lastHostPlayingRef.current = !!state.isPlaying;
    setError((prev) => (prev === HOST_LOST_MESSAGE ? null : prev));

    // Sync Track & Index (compute outside the state updater)
    const prev = tracksRef.current;
    const next = prev.some((t) => t.id === state.track.id) ? prev : [...prev, state.track];
    const idx = next.findIndex((t) => t.id === state.track.id);
    if (idx !== -1 && idx !== currentIndexRef.current) {
      tracksRef.current = next;
      currentIndexRef.current = idx;
      setTracks(next);
      setCurrentTrackIndex(idx);
    } else if (next !== prev) {
      tracksRef.current = next;
      setTracks(next);
    }

    // Sync Play/Pause — programmatic starts require THIS user's explicit
    // consent (III.C.2) and a >half-visible player (RMF autoplay rule).
    if (state.isPlaying && !isPlayingRef.current && playerRef.current) {
      if (!consentGrantedRef.current) {
        // Do not start, do not claim isPlaying: show the consent CTA instead.
        pendingAutoplayRef.current = true;
        setNeedsConsent(true);
      } else {
        let started = false;
        let blocked = false;
        try {
          // Await to avoid .catch() on void returns which throws TypeErrors
          started = await playWhenVisible(playerRef.current, 8);
          if (started) {
            // Chrome/Android may silently ignore playVideo() (player stuck
            // unstarted) or start muted under its autoplay policy. Give it a
            // moment, then check the real player state.
            await sleep(1200);
            const player = playerRef.current as unknown as {
              getPlayerState?: () => Promise<number>;
              isMuted?: () => Promise<boolean>;
            };
            const playerState = await player.getPlayerState?.().catch(() => undefined);
            const playing = playerState === 1 || playerState === 3;
            const muted = (await player.isMuted?.().catch(() => false)) === true;
            blocked = !playing || muted;
            if (blocked) started = false;
          }
        } catch {
          blocked = true;
        }
        if (!started) {
          // Consent exists — arm the gesture/visibility retries rather than
          // forcing playback from a hidden or autoplay-blocked player.
          pendingAutoplayRef.current = true;
          if (!isPlayerMostlyVisible()) {
            setError('Open the player to start listening.');
          } else {
            console.warn('Listener playback needs user interaction to be audible.');
            setError('Select anywhere on the page to start the music.');
          }
        } else {
          pendingAutoplayRef.current = false;
          setError(null);
        }
        // Claim playing either way so the mobile tray can auto-open and make
        // the player visible (playing must never coexist with a hidden player).
        setIsPlaying(true);
      }
    } else if (!state.isPlaying && isPlayingRef.current && playerRef.current) {
      try {
        await playerRef.current.pauseVideo();
      } catch {}
      setIsPlaying(false);
    }

    // Precision Drift Compensation (3-Tier Adaptive Model)
    if (playerRef.current && typeof state.currentTime === 'number') {
      try {
        const localTime = await playerRef.current.getCurrentTime();
        if (state.isPlaying) {
          // Compensate for network transit time using synchronized clocks
          const elapsedSinceBroadcast =
            typeof state.serverTime === 'number'
              ? Math.max(0, (getServerNow() - state.serverTime) / 1000)
              : 0;
          const expectedTime = state.currentTime + elapsedSinceBroadcast;
          const drift = localTime - expectedTime; // positive = local ahead, negative = local behind
          const absDrift = Math.abs(drift);

          if (absDrift < 0.15) {
            // TIER 1: In Sync (< 150ms) — normal playback speed
            if (currentRateRef.current !== 1) {
              await playerRef.current.setPlaybackRate(1);
              currentRateRef.current = 1;
            }
            setSyncStatus({ state: 'synced', driftMs: Math.round(drift * 1000) });
          } else if (absDrift <= 0.8 && supportsCustomRatesRef.current) {
            // TIER 2: Smooth Micro-Rate Adjustment (150ms – 800ms)
            // Pitch is preserved via YouTube IFrame's built-in WSOLA time stretching
            const rate = drift < 0 ? 1.05 : 0.95;
            if (currentRateRef.current !== rate) {
              await playerRef.current.setPlaybackRate(rate);
              currentRateRef.current = rate;
            }
            setSyncStatus({ state: 'adjusting', driftMs: Math.round(drift * 1000), rate });
          } else {
            // TIER 3: Hard Seek (> 800ms or device unsupported)
            await playerRef.current.seekTo(expectedTime, true);
            if (currentRateRef.current !== 1) {
              await playerRef.current.setPlaybackRate(1);
              currentRateRef.current = 1;
            }
            setSyncStatus({ state: 'seeking', driftMs: Math.round(drift * 1000) });
          }
        } else {
          // Host is paused: align position if drifted > 300ms
          const absDrift = Math.abs(localTime - state.currentTime);
          if (absDrift > 0.3) {
            await playerRef.current.seekTo(state.currentTime, true);
          }
          if (currentRateRef.current !== 1) {
            await playerRef.current.setPlaybackRate(1);
            currentRateRef.current = 1;
          }
          setSyncStatus({ state: 'synced', driftMs: Math.round((localTime - state.currentTime) * 1000) });
        }
      } catch {}
    }

    return true;
  }, [fetchPlaybackState]);

  // Explicit listener consent ("Start listening" CTA). Opens the audio path
  // inside the user's gesture and starts playback only when the host is live
  // AND the player is (or shortly becomes) >half visible.
  const grantConsent = useCallback(async () => {
    consentGrantedRef.current = true;
    setNeedsConsent(false);
    const player = playerRef.current;
    if (!player) return;

    try {
      await player.unMute();
      const target =
        volumeTouchedRef.current || volumeRef.current > 0 ? volumeRef.current : 80;
      await player.setVolume(target);
    } catch {}

    // Trusting a possibly stale sync flag is how we used to start silent
    // audio — if recent syncs are missing, fetch the authoritative state and
    // let applyPlaybackState reconcile (consent is already granted, so its
    // play path runs under the normal visibility gate).
    const syncAge = lastSyncAtRef.current > 0 ? Date.now() - lastSyncAtRef.current : Infinity;
    if (syncAge > 8000) {
      const state = await fetchPlaybackState();
      if (state) void applyPlaybackState(state);
      return;
    }

    if (!lastHostPlayingRef.current && !isPlayingRef.current) {
      setError(null);
      return;
    }

    const started = await playWhenVisible(player);
    if (started) {
      pendingAutoplayRef.current = false;
      isPlayingRef.current = true;
      setIsPlaying(true);
      setError(null);
    } else {
      pendingAutoplayRef.current = true;
      setError('Bring the player on screen to start listening.');
    }
  }, [applyPlaybackState, fetchPlaybackState]);

  // Room-Scoped Realtime Subscription
  useEffect(() => {
    // Don't touch realtime until the room UUID is known. The legacy
    // 'player_sync' fallback is disabled server-side — subscribing to it
    // while roomData loads always rejects and leaves a sticky banner.
    if (!roomId) return;
    const channelName = `room:${roomId}:sync`;
    let isSubscribed = true;
    let offChannel: (() => void) | null = null;

    const handleSync = (payload: any) => {
      if (!isSubscribed) return;
      void applyPlaybackState(payload);
    };

    // Reconcile against the DB: on mount (covers opening the page while the
    // host is paused — no periodic broadcasts happen then) and on every
    // realtime (re)connect (heals events missed during network blips).
    const reconcile = async () => {
      if (!isSubscribed) return;
      const state = await fetchPlaybackState();
      if (state && isSubscribed) void applyPlaybackState(state);
    };

    async function initSync() {
      try {
        await realtime.connect();
        if (!isSubscribed) return;
        const sub = await realtime.subscribe(channelName);
        if (!isSubscribed) return;
        if (sub && !sub.ok) {
          console.warn(`Realtime subscribe rejected for "${channelName}":`, sub.error);
          setError('Live sync is unavailable (channel subscription rejected).');
        } else {
          // Clear a stale rejection from a previous mount (e.g. the
          // pre-join render) now that the room-scoped channel is live.
          // Only clears this exact banner — never other playback errors.
          setError((prev) =>
            prev === 'Live sync is unavailable (channel subscription rejected).' ? null : prev,
          );
        }
        // C1: channel-aware dispatch drops forged cross-room sync events.
        offChannel = realtime.onChannel(channelName, 'sync', handleSync);
      } catch (err) {
        console.warn('Listener sync subscription failed:', err);
      }
    }

    initSync();
    void reconcile();
    realtime.onConnect(reconcile);

    return () => {
      isSubscribed = false;
      try {
        offChannel?.();
        realtime.offConnect(reconcile);
        realtime.unsubscribe(channelName);
      } catch {}
    };
  }, [roomId, applyPlaybackState, fetchPlaybackState]);

  // Background Tab Recovery: When user switches back to this tab,
  // immediately reconcile playback state to recover from browser throttling.
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !isHostRef.current) {
        void fetchPlaybackState().then((state) => {
          if (state) void applyPlaybackState(state);
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleVisibility);
    };
  }, [fetchPlaybackState, applyPlaybackState]);

  // HOST heartbeat: keep rooms.host_last_seen fresh even while paused (no
  // playback syncs happen then) so nobody can claim the room out from under
  // an active host. Only touches host_last_seen — deliberately NOT
  // playback_state, so the DB broadcast trigger stays silent.
  useEffect(() => {
    if (!isHost || !roomId) return;
    const beat = async () => {
      try {
        await insforge.database
          .from('rooms')
          .update({ host_last_seen: new Date().toISOString() })
          .eq('id', roomIdRef.current!);
      } catch {}
    };
    void beat();
    const interval = setInterval(beat, 30000);
    return () => clearInterval(interval);
  }, [isHost, roomId]);

  // Listener: if syncs stop while we think we're playing, the host is gone —
  // pause locally and say so. Playback resumes automatically on next sync.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (isHostRef.current || !isPlayingRef.current || !playerRef.current) return;
      const staleFor = Date.now() - lastSyncAtRef.current;
      if (lastSyncAtRef.current > 0 && staleFor > 15000) {
        try {
          await playerRef.current.pauseVideo();
        } catch {}
        setIsPlaying(false);
        setError(HOST_LOST_MESSAGE);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // After consent, browsers may still block the first programmatic start —
  // retry on the user's next gesture. NEVER starts playback without consent
  // (III.C.2: playback must be clearly initiated by this user) and never
  // without a >half-visible player (RMF / III.I.9).
  useEffect(() => {
    const retry = async () => {
      if (!pendingAutoplayRef.current || !consentGrantedRef.current || !playerRef.current) return;
      if (!lastHostPlayingRef.current && !isPlayingRef.current) {
        pendingAutoplayRef.current = false;
        return;
      }
      if (!isPlayerMostlyVisible()) return;
      const player = playerRef.current;
      try {
        await player.unMute();
        const target =
          volumeTouchedRef.current || volumeRef.current > 0 ? volumeRef.current : 80;
        await player.setVolume(target);
        await player.playVideo();
        pendingAutoplayRef.current = false;
        isPlayingRef.current = true;
        setIsPlaying(true);
        setError(null);
      } catch {
        // Still blocked — keep the flag set so the next interaction retries.
      }
    };

    window.addEventListener('pointerdown', retry);
    window.addEventListener('touchstart', retry, { passive: true });
    window.addEventListener('keydown', retry);
    return () => {
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('touchstart', retry);
      window.removeEventListener('keydown', retry);
    };
  }, []);

  // Visibility retry: consent exists but the player was off-screen (e.g. the
  // mobile tray was collapsed when the host resumed). Polls until the player
  // is >half visible, then starts — so "playing" never coexists with a
  // hidden/background player for longer than the tray-open animation.
  useEffect(() => {
    if (!consentGrantedRef.current || !pendingAutoplayRef.current) return;
    const interval = window.setInterval(async () => {
      if (!pendingAutoplayRef.current || !consentGrantedRef.current || !playerRef.current) return;
      if (!lastHostPlayingRef.current && !isPlayingRef.current) return;
      if (!isPlayerMostlyVisible()) return;
      try {
        await playerRef.current.playVideo();
        pendingAutoplayRef.current = false;
        isPlayingRef.current = true;
        setIsPlaying(true);
        setError(null);
      } catch {
        // Keep pending — gesture retry remains as the backstop.
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [isPlaying, needsConsent]);

  // III.E.4.j: look up Made-For-Kids status for every embedded video.
  useEffect(() => {
    madeForKidsRef.current = null;
    const id = currentTrack.id;
    if (!id) return;
    let cancelled = false;
    void isMadeForKids(id).then((value) => {
      if (!cancelled) madeForKidsRef.current = value;
    });
    return () => {
      cancelled = true;
    };
  }, [currentTrack.id]);

  // YouTube Component event handlers
  const onPlayerReady: NonNullable<YouTubeProps['onReady']> = useCallback(
    async (event) => {
      playerRef.current = event.target;
      setIsReady(true);
      setError(null);

      try {
        await event.target.setVolume(volume);

        // Probe available playback rates for pitch-safe micro-adjustments
        try {
          const rates = await (event.target as any).getAvailablePlaybackRates?.();
          if (Array.isArray(rates)) {
            supportsCustomRatesRef.current = rates.includes(1.05) || rates.includes(1.25);
          }
        } catch {}

        const totalDuration = await event.target.getDuration();
        if (typeof totalDuration === 'number' && !isNaN(totalDuration) && totalDuration > 0) {
          setDuration(totalDuration);
        }

        // Fetch video title/author if available to update current track
        try {
          const videoData = (await (event.target as any).getVideoData?.()) || null;
          if (videoData && videoData.title) {
            setTracks((prev) =>
              prev.map((t, idx) =>
                idx === currentIndexRef.current
                  ? {
                      ...t,
                      title: videoData.title || t.title,
                      artist: videoData.author || t.artist,
                      albumArt: t.albumArt || getYouTubeThumbnail(t.id),
                    }
                  : t
              )
            );
          }
        } catch {
          // getVideoData optional
        }

        // Automatic start requires this user's consent AND a >half-visible
        // player (RMF autoplay rule) — never fire playVideo() blindly here.
        if (autoPlay || isPlayingRef.current || lastHostPlayingRef.current) {
          if (!consentGrantedRef.current) {
            if (autoPlay || lastHostPlayingRef.current) setNeedsConsent(true);
          } else {
            const started = await playWhenVisible(event.target, 4);
            if (started) {
              pendingAutoplayRef.current = false;
              setIsPlaying(true);
            } else {
              pendingAutoplayRef.current = true;
            }
          }
        }
      } catch (err) {
        console.warn('Error on YouTube player ready:', err);
      }
    },
    [autoPlay, volume]
  );

  const onPlayerStateChange: NonNullable<YouTubeProps['onStateChange']> = useCallback(
    async (event) => {
      const state = event.data;
      if (state === 1) { // Playing
        skipCountRef.current = 0;
        setIsPlaying(true);
        setIsBuffering(false);
        setError(null);
        // Host: surface native iframe play/pause to the room (listeners' own
        // transport is disabled, but the standard player controls stay live
        // per RMF — when the HOST uses them, sync must follow).
        if (isHostRef.current) {
          isPlayingRef.current = true;
          clearPendingBroadcast();
          void broadcastSync(true);
        }
        try {
          const d = await event.target.getDuration();
          if (typeof d === 'number' && !isNaN(d) && d > 0) {
            setDuration(d);
          }
        } catch {}
      } else if (state === 2) { // Paused
        setIsPlaying(false);
        setIsBuffering(false);
        if (isHostRef.current) {
          isPlayingRef.current = false;
          clearPendingBroadcast();
          void broadcastSync(false);
        }
      } else if (state === 3) { // Buffering
        setIsBuffering(true);
      } else if (state === 0) { // Ended
        setIsBuffering(false);
        if (isHostRef.current) {
          if (tracksRef.current.length > 1) {
            // Auto-advance KEEPS the playing claim (do not setIsPlaying(false)):
            // the track change recreates the embed, and the dynamic autoplay
            // playerVar + onPlayerReady resume need isPlayingRef true to load
            // the next video playing — otherwise the room would pause blip
            // after every song. Single-track queues fall through to paused.
            nextTrack();
          } else {
            setIsPlaying(false);
            nextTrack();
          }
        } else {
          // Listeners don't advance (host drives the queue); drop the local
          // playing claim and wait for the host's next sync.
          setIsPlaying(false);
        }
      }
    },
    [nextTrack, broadcastSync, clearPendingBroadcast]
  );

  const onPlayerError: NonNullable<YouTubeProps['onError']> = useCallback(
    (event) => {
      console.error('YouTube Player Error:', event.data);
      let errorMsg = 'Failed to load YouTube track.';
      if (event.data === 101 || event.data === 150) {
        errorMsg = 'This video cannot be played in embedded players.';
      } else if (event.data === 100) {
        errorMsg = 'Video not found or removed.';
      } else if (event.data === 2) {
        errorMsg = 'Invalid video ID parameter.';
      }

      // Host: don't let one bad video stall the party — skip ahead. The
      // replacement video autoplays via loadVideoById, and listeners follow
      // the scheduled sync. Guarded against loops when EVERY track is bad.
      if (isHostRef.current && tracksRef.current.length > 1) {
        skipCountRef.current += 1;
        if (skipCountRef.current >= tracksRef.current.length) {
          setError('No playable tracks in the queue — add a different video.');
          setIsPlaying(false);
          setIsBuffering(false);
          return;
        }
        onTrackSkippedRef.current?.(`${errorMsg} Skipped to the next track.`);
        nextTrack();
        return;
      }

      setError(errorMsg);
      setIsPlaying(false);
      setIsBuffering(false);
    },
    [nextTrack]
  );

  return {
    // State
    tracks,
    currentTrack,
    currentTrackIndex,
    isPlaying,
    currentTime,
    duration,
    progress,
    volume,
    isMuted,
    isReady,
    isBuffering,
    error,
    syncStatus,
    // Consent gate (RMF/III.C.2): true while sync wants to play but this
    // user hasn't explicitly started listening yet.
    needsConsent,
    grantConsent,
    timeElapsed: formatTime(currentTime),
    timeTotal: formatTime(duration),

    // Actions
    play,
    pause,
    togglePlay,
    seekTo,
    seekByPercentage,
    setVolume,
    toggleMute,
    loadTrack,
    queueTrack,
    nextTrack,
    prevTrack,

    // YouTube Event Props
    playerProps: {
      videoId: currentTrack.id,
      opts: {
        height: '100%',
        width: '100%',
        playerVars: {
          // nocookie domain = reduced pre-interaction tracking; baseline
          // control for Made-For-Kids embeds (III.E.4.j).
          host: 'https://www.youtube-nocookie.com',
          // react-youtube RECREATES the embed on every videoId change and
          // picks loadVideoById (plays) vs cueVideoById (stays paused) from
          // this flag — so it must track "should continue playing" for track
          // advances. It is still 0 on mount / whenever consent or visibility
          // is missing, so no start can ever bypass the consent + playWhenVisible
          // gates; the onPlayerReady path resumes those cases once eligible.
          autoplay:
            isPlaying && consentGrantedRef.current && isPlayerMostlyVisible() ? 1 : 0,
          // Standard player controls/features must remain available (RMF:
          // blocking them violates the Developer Policies).
          controls: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          origin: typeof window !== 'undefined' ? window.location.origin : '',
        },
      },
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  };
}
