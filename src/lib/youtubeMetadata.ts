import { extractYouTubeId, getYouTubeThumbnail } from './providers/youtube';

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  url: string;
}

function functionsBase(): string {
  const explicit = import.meta.env.VITE_FUNCTIONS_URL as string | undefined;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, '');
  const insforge = import.meta.env.VITE_INSFORGE_URL as string | undefined;
  if (insforge && insforge.trim()) return `${insforge.trim().replace(/\/$/, '')}/functions`;
  return '';
}

/**
 * Resolves YouTube video title and author via YouTube's official oEmbed
 * endpoint, fetched through our `/oembed` edge function (Developer Policies
 * III.I.14: API Data may only be retrieved through YouTube API Services —
 * third-party proxies like noembed.com don't qualify). Zero Data API quota.
 */
export async function resolveYouTubeTrack(urlOrId: string): Promise<YouTubeMetadata | null> {
  const videoId = extractYouTubeId(urlOrId);
  if (!videoId) return null;

  const standardUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const defaultThumbnail = getYouTubeThumbnail(videoId);

  try {
    const base = functionsBase();
    // Same-origin edge function in dev/deploy; direct official endpoint as a
    // last resort when no functions base is configured (some browsers CORS-
    // block the direct call — the fallback below covers that).
    const endpoints = base
      ? [`${base}/oembed?url=${encodeURIComponent(standardUrl)}`]
      : [`https://www.youtube.com/oembed?url=${encodeURIComponent(standardUrl)}&format=json`];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) continue;
        const data = await response.json();
        if (data && data.title) {
          return {
            videoId,
            title: data.title,
            artist: data.author_name || 'YouTube Music',
            thumbnail: data.thumbnail_url || defaultThumbnail,
            url: standardUrl,
          };
        }
      } catch {
        // Try the next endpoint / fall through to the default below.
      }
    }
  } catch {
    // Network timeout or blocked: fallback to direct thumbnail & video id
  }

  return {
    videoId,
    title: `YouTube Video (${videoId})`,
    artist: 'YouTube Request',
    thumbnail: defaultThumbnail,
    url: standardUrl,
  };
}
