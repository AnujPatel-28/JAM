// oEmbed proxy — Developer Policies III.I.14 forbids retrieving API Data via
// any technology other than YouTube API Services; third-party scrapers (e.g.
// noembed.com) don't qualify. This function fetches YouTube's OFFICIAL
// oEmbed endpoint server-side (also sidesteps browser CORS) and passes the
// JSON through with a day-long shared cache.

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

// 30 req/min/IP in-memory (single-isolate best-effort; matches sibling fns).
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 30;
}

function validateTarget(raw: string | null): string | null {
  if (!raw || raw.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  // SSRF guard: only YouTube watch/youtu.be URLs ever leave this function.
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  return parsed.toString();
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-ip') || 'unknown';
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const target = validateTarget(new URL(req.url).searchParams.get('url'));
  if (!target) {
    return new Response(JSON.stringify({ error: 'invalid_url' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const upstream = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(target)}&format=json`,
      { signal: AbortSignal.timeout(4000) }
    );
    // Cap the body so a hostile upstream can't balloon our isolate's memory.
    const text = (await upstream.text()).slice(0, 64 * 1024);
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('json')) {
      return new Response(JSON.stringify({ error: 'upstream_error' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        // Successes are immutable enough for a session; errors stay uncached.
        'Cache-Control': upstream.ok ? 'public, max-age=86400' : 'no-store',
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'upstream_unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
