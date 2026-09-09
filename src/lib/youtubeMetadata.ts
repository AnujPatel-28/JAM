import { extractYouTubeId, getYouTubeThumbnail } from './providers/youtube';

export interface YouTubeMetadata {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  url: string;
}

/**
 * Resolves YouTube video title and author using public zero-quota oEmbed.
 * Never consumes YouTube Data API v3 quota.
 */
export async function resolveYouTubeTrack(urlOrId: string): Promise<YouTubeMetadata | null> {
  const videoId = extractYouTubeId(urlOrId);
  if (!videoId) return null;

  const standardUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const defaultThumbnail = getYouTubeThumbnail(videoId);

  try {
    // YouTube's official public oEmbed endpoint
    const response = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent(standardUrl)}`,
      { signal: AbortSignal.timeout(4000) }
    );

    if (response.ok) {
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
