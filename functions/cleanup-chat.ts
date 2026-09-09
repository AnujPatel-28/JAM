import { createClient } from 'npm:@insforge/sdk';

// H4 lockdown (docs/security-fixes/007-H4-cleanup.md): allowlisted origin,
// POST-only, constant-time token compare, per-IP rate limit. No `*` CORS.

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function getAllowedOrigin(req: Request): string | null {
  const configured = (Deno.env.get('APP_ORIGIN') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (configured.length === 0) return null;
  const origin = req.headers.get('origin');
  if (origin && configured.includes(origin)) return origin;
  return null;
}

function corsFor(req: Request): Record<string, string> {
  const origin = getAllowedOrigin(req);
  return {
    // No wildcard: browser calls only from the configured app origin.
    // Non-browser (curl/cron) callers get no ACAO header — still authorized via token.
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-cleanup-token',
  };
}

// 10 req/min/IP in-memory (single-isolate best-effort; edge concurrency may
// shard it — platform rate limits remain the outer boundary).
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

export default async function(req: Request): Promise<Response> {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const token = req.headers.get('x-cleanup-token') || '';
  const expected = Deno.env.get('CLEANUP_TOKEN') || '';
  if (!expected || !constantTimeEqual(token, expected)) {
    // Same body for missing/invalid — no oracle on which part failed.
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // 022: the SDK field is named anonKey but this MUST be the service key
  // (ik_… bypasses RLS by design). INSFORGE_SERVICE_KEY is the honest name;
  // ADMIN_API_KEY is accepted as a legacy fallback. Fail closed if misconfigured.
  const serviceKey = Deno.env.get('INSFORGE_SERVICE_KEY') || Deno.env.get('ADMIN_API_KEY') || '';
  if (!serviceKey || !serviceKey.startsWith('ik_')) {
    console.error('[cleanup-chat] INSFORGE_SERVICE_KEY missing or not a service key — refusing to run.');
    return new Response(JSON.stringify({ error: 'Cleanup failed' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const client = createClient({
    baseUrl: Deno.env.get('INSFORGE_BASE_URL'),
    anonKey: serviceKey,
  });

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error } = await client.database
    .from('chat_messages')
    .delete()
    .lt('created_at', cutoff);

  if (error) {
    return new Response(JSON.stringify({ error: 'Cleanup failed' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // No row dump: previous version returned deleted rows (oracle + leak).
  return new Response(JSON.stringify({ ok: true, cutoff }), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
