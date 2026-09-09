# 013 — Hygiene Sweep (headers, oEmbed, legacy table, names, repo)

## Problem
Leftovers too small for their own migration but each a real gap: no hosting headers (meta CSP only), oEmbed fired per keystroke with race-overwrite + ID leak, dead `song_requests` anon-writable, `Host/Admin` variants (`H0st`, spaced) renderable, Desktop-root monorepo one `git add -A` from leaking.

## Decision
- **Headers:** `public/_headers` (CSP mirroring meta + `challenges.cloudflare.com` for Turnstile, `nosniff`, `DENY`, strict referrer, HSTS, `Permissions-Policy` kill camera/mic/geo). Meta stays as fallback; **tighten `connect-src` to the exact InsForge host in production** (wildcard kept for preview/staging).
- **oEmbed:** 400ms debounce + monotonic seq guard in `RequestSongModal` — stale responses dropped, fewer third-party leaks. Full privacy fix (proxy via function) deferred; noted.
- **Legacy table:** `20260903700000_legacy-cleanup.sql` revokes `anon,authenticated` on `song_requests` and drops all four public policies. Table kept (no DROP — unknown consumers), `service_role` untouched. Zero `src/` references confirmed.
- **Names:** `src/lib/displayName.ts` (NFKC + zero-width collapse + 24 cap + leet-fold reservation `host|admin|moderator|…`); enforced at lobby join paths (toast + block), send-time fallback to `Guest`, canonical storage in `setStoredDisplayName`. DB trigger remains the backstop.
- **Repo:** NO root `.gitignore` created — writing outside `wifi-jokey/` risks the user's Desktop monorepo. Rule instead: never `git add -A` from `Desktop/`; move `wifi-jokey/` to its own repo when possible; `.env`/`dist/`/`.insforge/` verified ignored, scripts now env-only (`005`).

## Why
Each item is a one-line-exploit class: headers (XSS blast radius), debounce (DoS-by-typing + tracking), dead writable table (spam store), names (impersonation → false host commands). Bundled because individually they're 10-line diffs; separately they'd be four review rounds for no reason.

## What changed
- `public/_headers`, `index.html` (Turnstile CSP), `src/components/RequestSongModal.tsx` (debounce), `src/lib/displayName.ts` (new), `LobbyPage.tsx`/`RoomPage.tsx`/`session.ts` (checks), `migrations/20260903700000_legacy-cleanup.sql`

## Verify
- Static: `_headers` has no `*` ACAO; debounce `400` + `resolveSeq`; `song_requests` revoke present; `isReservedDisplayName('H0st')===true` (add to checks)
- Manual: type fast in request box → 1 network call; join as ` Admin ` → blocked toast; private lobby shows no host controls to non-host

## Rollback
Delete `_headers` (meta still applies); revert modal debounce (old behavior returns); re-apply `song_requests` policies from `20260821000000`; remove name checks (trigger still guards exact variants).
