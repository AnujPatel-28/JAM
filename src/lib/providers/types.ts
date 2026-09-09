export type ProviderType = 'youtube' | 'spotify' | 'soundcloud' | 'custom';

export type PlaybackStatus = 'unstarted' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';

export interface MusicTrack {
  id: string; // Unique track ID (e.g. YouTube Video ID or Spotify URI)
  title: string;
  artist: string;
  albumArt: string;
  duration?: number; // Duration in seconds (if known in advance)
  provider: ProviderType;
  url?: string;
}

export interface PlaybackState {
  status: PlaybackStatus;
  isPlaying: boolean;
  currentTime: number; // In seconds
  duration: number; // In seconds
  progress: number; // 0 to 100 percentage
  volume: number; // 0 to 100
  isMuted: boolean;
  currentTrack: MusicTrack | null;
  isReady: boolean;
  error?: string | null;
}

export interface MusicProvider {
  readonly id: string;
  readonly name: string;
  readonly type: ProviderType;
  readonly isReady: boolean;
  
  play(track?: MusicTrack | string): Promise<void>;
  pause(): Promise<void>;
  togglePlay(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  setVolume(volume: number): Promise<void>;
  mute(): Promise<void>;
  unMute(): Promise<void>;
  getCurrentState(): PlaybackState;
  onStateChange(listener: (state: PlaybackState) => void): () => void;
  destroy?(): void;
}

/**
 * Format seconds into mm:ss format (or hh:mm:ss if > 1 hour)
 */
export function formatTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00';
  const totalSeconds = Math.floor(seconds);
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  const paddedSecs = secs.toString().padStart(2, '0');
  if (hrs > 0) {
    const paddedMins = mins.toString().padStart(2, '0');
    return `${hrs}:${paddedMins}:${paddedSecs}`;
  }
  return `${mins}:${paddedSecs}`;
}
