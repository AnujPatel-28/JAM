// Turnstile client helper (docs/security-fixes/012, 022).
// Flow: widget → token → POST verify function → { ticket } → RPC.
// The TICKET (not the boolean) is the proof: create_room_secure consumes it
// server-side, so bots calling the RPC directly can't skip the human check.
// Fail-open ONLY when no site key is configured (feature-flag off).

export function getTurnstileSiteKey(): string | null {
  const key = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  return key && key.trim() ? key.trim() : null;
}

function functionsBase(): string {
  const explicit = import.meta.env.VITE_FUNCTIONS_URL as string | undefined;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/$/, '');
  const insforge = import.meta.env.VITE_INSFORGE_URL as string | undefined;
  if (insforge && insforge.trim()) return `${insforge.trim().replace(/\/$/, '')}/functions`;
  return '';
}

export interface TurnstileVerification {
  ok: boolean;
  /** Single-use ticket for the RPC. Present only when ok === true. */
  ticket?: string;
}

/** @deprecated Use verifyTurnstileTicket() — booleans can't be enforced server-side. */
export async function verifyTurnstileToken(token: string, action = 'request_song'): Promise<boolean> {
  const out = await verifyTurnstileTicket(token, action);
  return out.ok;
}

export async function verifyTurnstileTicket(token: string, action: string): Promise<TurnstileVerification> {
  try {
    const base = functionsBase();
    if (!base) return { ok: false };
    const res = await fetch(`${base}/verify-turnstile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action }),
    });
    if (!res.ok) return { ok: false };
    const out = (await res.json()) as { ok?: boolean; ticket?: string };
    if (out.ok !== true || typeof out.ticket !== 'string' || !out.ticket) {
      return { ok: false };
    }
    return { ok: true, ticket: out.ticket };
  } catch {
    return { ok: false };
  }
}
