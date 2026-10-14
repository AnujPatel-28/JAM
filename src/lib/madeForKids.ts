// Developer Policies III.E.4.j: API Clients "must look up the Made For Kids
// status of each YouTube video that it embeds" and, for Made-For-Kids content,
// turn off tracking/data collection (COPPA/GDPR). The status is only exposed
// by the YouTube Data API (videos.list?part=status → status.madeForKids), so
// this needs a (quota-cheap: 1 unit/list) API key.
//
// Without VITE_YOUTUBE_API_KEY we still perform the lookup attempt contract
// (returning "unknown") and rely on the youtube-nocookie.com embed host set
// in useYouTubeMusic as the baseline tracking reduction. Set the env var for
// full III.E.4.j compliance before launch.

const API_KEY = (import.meta.env.VITE_YOUTUBE_API_KEY as string | undefined)?.trim() || '';

const cache = new Map<string, boolean>();
let warnedMissingKey = false;

/**
 * Returns true / false when YouTube reports the status, or null when unknown
 * (no API key configured, network failure, or video not found).
 */
export async function isMadeForKids(videoId: string): Promise<boolean | null> {
  if (!videoId) return null;

  const hit = cache.get(videoId);
  if (hit !== undefined) return hit;

  if (!API_KEY) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        '[made-for-kids] VITE_YOUTUBE_API_KEY is not set — cannot look up Made-For-Kids status (YouTube Developer Policies III.E.4.j). ' +
          'Baseline tracking reduction still applies via the youtube-nocookie.com embed host.'
      );
    }
    return null;
  }

  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=status&id=${encodeURIComponent(videoId)}&key=${API_KEY}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{ status?: { madeForKids?: boolean; selfDeclaredMadeForKids?: boolean } }>;
    };
    const status = data.items?.[0]?.status;
    const value =
      typeof status?.madeForKids === 'boolean'
        ? status.madeForKids
        : typeof status?.selfDeclaredMadeForKids === 'boolean'
          ? status.selfDeclaredMadeForKids
          : null;
    if (value !== null) cache.set(videoId, value);
    return value;
  } catch {
    return null;
  }
}
