// Verify a Cloudflare Turnstile token server-side (docs/security-fixes/012, 022).
// 022 changes:
//   - Returns a SINGLE-USE ticket { ticket } that create_room_secure consumes
//     (tickets table, migration 042). Booleans can't be enforced in SQL.
//   - Per-IP rate limit (was missing → siteverify cost oracle).
//   - Generic failure when secret unconfigured (was distinct 500 'Server not
//     configured' → told attackers protection is off). Dev note: with no
//     secret we still mint a ticket but log loudly (fail-open dev, strict prod).
//   - Sends remoteip + asserts hostname ∈ APP_ORIGIN (staging tokens can't
//     replay to prod when secrets are shared).
// Env: TURNSTILE_SECRET_KEY (server-only), APP_ORIGIN (comma-separated allowlist).

interface VerifyBody {
  token?: string;
  action?: string;
}

const ALLOWED_ACTIONS = new Set(['create_room', 'request_song']);

// Spin contract: token must be a plausible cf-turnstile-response before any
// siteverify call (length guard), and the returned action/hostname must match.
function badToken(token: unknown): boolean {
  return typeof token !== 'string' || token.length === 0 || token.length > 2048;
}

function corsFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get('APP_ORIGIN') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin');
  return {
    ...(origin && configured.includes(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// 10 verifications/min/IP (mirrors cleanup-chat; platform limits are outer).
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

function noStore(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'Cache-Control': 'no-store' };
}

async function mintTicket(action: string): Promise<string | null> {
  const { createClient } = await import('npm:@insforge/sdk');
  const client = createClient({
    baseUrl: Deno.env.get('INSFORGE_BASE_URL'),
    anonKey: Deno.env.get('INSFORGE_SERVICE_KEY') || Deno.env.get('ADMIN_API_KEY') || '',
  });
  const { data, error } = await client.database
    .from('turnstile_tickets')
    .insert([{ action }])
    .select('id');
  // Server-side only: error text never leaves the edge (client gets generic).
  if (error) console.error('[turnstile] ticket mint failed:', error.message || error);
  if (error || !data) return null;
  const row = Array.isArray(data) ? data[0] : (data as any);
  return typeof row?.id === 'string' ? row.id : null;
}

export default async function (req: Request): Promise<Response> {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  }

  const ip =
    req.headers.get('cf-connecting-ip')?.split(',')[0]?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ ok: false, error: 'Too many requests' }), {
      status: 429,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  }

  let token = '';
  let action = 'create_room';
  try {
    const body = (await req.json()) as VerifyBody;
    token = typeof body.token === 'string' ? body.token : '';
    if (typeof body.action === 'string' && ALLOWED_ACTIONS.has(body.action)) {
      action = body.action;
    }
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
      status: 400,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  }
  if (badToken(token)) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing token' }), {
      status: 400,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  }

  const secret = Deno.env.get('TURNSTILE_SECRET_KEY') || '';
  if (!secret) {
    // No secret = dev/unconfigured. Mint WITHOUT verification so local dev
    // never locks out — but scream about it server-side. NOTE: the RPC still
    // requires a ticket; only this edge path is lenient, and only here.
    console.error('[turnstile] TURNSTILE_SECRET_KEY unset — minting UNVERIFIED dev ticket. Set the secret in prod.');
    const ticket = await mintTicket(action);
    if (!ticket) {
      return new Response(JSON.stringify({ ok: false, error: 'Verification failed' }), {
        status: 403,
        headers: { ...noStore(cors), 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, ticket, dev: true }), {
      status: 200,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  }

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: 'Verification service unavailable' }), {
        status: 502,
        headers: { ...noStore(cors), 'Content-Type': 'application/json' },
      });
    }
    const out = (await res.json()) as { success?: boolean; hostname?: string; action?: string; 'error-codes'?: string[] };
    if (!out.success) {
      console.warn('[turnstile] siteverify failed:', JSON.stringify(out['error-codes'] || []));
      return new Response(JSON.stringify({ ok: false, error: 'Verification failed' }), {
        status: 403,
        headers: { ...noStore(cors), 'Content-Type': 'application/json' },
      });
    }
    // Spin: the token must have been minted for THIS surface's action.
    if (!out.action || out.action !== action) {
      console.warn('[turnstile] action mismatch:', out.action, 'expected:', action);
      return new Response(JSON.stringify({ ok: false, error: 'Verification failed' }), {
        status: 403,
        headers: { ...noStore(cors), 'Content-Type': 'application/json' },
      });
    }
    // Hostname binding: a token minted for staging must not work on prod.
    const configured = (Deno.env.get('APP_ORIGIN') || '').split(',').map((s) => {
      try {
        return new URL(s.trim()).hostname;
      } catch {
        return '';
      }
    }).filter(Boolean);
    if (configured.length > 0 && (!out.hostname || !configured.includes(out.hostname))) {
      console.warn('[turnstile] hostname mismatch:', out.hostname);
      return new Response(JSON.stringify({ ok: false, error: 'Verification failed' }), {
        status: 403,
        headers: { ...noStore(cors), 'Content-Type': 'application/json' },
      });
    }
    const ticket = await mintTicket(action);
    if (!ticket) {
      return new Response(JSON.stringify({ ok: false, error: 'Verification service unavailable' }), {
        status: 502,
        headers: { ...noStore(cors), 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, ticket }), {
      status: 200,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Verification failed' }), {
      status: 502,
      headers: { ...noStore(cors), 'Content-Type': 'application/json' },
    });
  }
}
