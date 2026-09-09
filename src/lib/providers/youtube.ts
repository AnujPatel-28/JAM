import type { MusicTrack } from './types';

export const DEFAULT_YOUTUBE_TRACKS: MusicTrack[] = [
  {
    id: 'jfKfPfyJRdk',
    title: 'lofi hip hop radio - beats to relax/study to',
    artist: 'Lofi Girl',
    albumArt: 'https://img.youtube.com/vi/jfKfPfyJRdk/maxresdefault.jpg',
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk'
  },
  {
    id: '5qap5aO4i9A',
    title: 'lofi hip hop radio - beats to sleep/chill to',
    artist: 'Lofi Girl',
    albumArt: 'https://img.youtube.com/vi/5qap5aO4i9A/maxresdefault.jpg',
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=5qap5aO4i9A'
  },
  {
    id: '4xDzrJKXOOY',
    title: 'Synthwave Radio - Chill Synth / Retro Beats',
    artist: 'Lofi Girl Synthwave',
    albumArt: 'https://img.youtube.com/vi/4xDzrJKXOOY/maxresdefault.jpg',
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=4xDzrJKXOOY'
  },
  {
    id: 'dQw4w9WgXcQ',
    title: 'Never Gonna Give You Up',
    artist: 'Rick Astley',
    albumArt: 'https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
    provider: 'youtube',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  }
];

/**
 * Extracts an 11-character YouTube video ID from various URL formats or raw ID.
 * Supports watch, youtu.be, embed, shorts, live, and music.youtube.com URLs.
 */
export function extractYouTubeId(urlOrId: string): string | null {
  if (!urlOrId) return null;
  const trimmed = urlOrId.trim();

  // If already 11 chars without slashes or question marks
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // Handle standard URL patterns
  const match = trimmed.match(
    /(?:youtu\.be\/|youtube(?:-nocookie|music)?\.com\/(?:embed\/|shorts\/|live\/|v\/|watch\?(?:.*&)?v=))([\w-]{11})/
  );
  return match ? match[1] : null;
}

/**
 * Returns the best thumbnail URL for a given YouTube video ID
 */
export function getYouTubeThumbnail(videoId: string): string {
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
}
