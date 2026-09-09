# 000 — Plan Snapshot

## Goal
Fix `SECURITY-AUDIT.md` Criticals C1 (sync spoof), C2 (private-room IDOR), C3 (kick via `session_id` replay). Document each decision in this folder. Produce SQL migration files but do not apply to the database.

## Why this order
1. **Blockers first** — `security_hardening_plan.md` as written would fail to apply (`dismissed` vs `rejected`, missing `updated_at`) and would leave C2 world-readable. Fixing these first prevents a broken migration.
2. **C1** — active hijack primitive (any authed user → victim playback). Highest blast radius.
3. **C2** — passive leak (anon enumeration). Scoped to fail-closed for private rooms without breaking public lobby.
4. **C3** — ownership token. Depends on C2 reasoning (session identity cannot be proven by anon RLS alone, so RPC-level token is used).

## Non-goals (this pass)
H1–H5, M/L (cleanup-chat CORS, CSP hardening beyond baseline meta, OTP, key rotation, purge throttle). They follow the same `00X` doc pattern next.

## References
- Supabase docs: Realtime Authorization (separate SELECT/INSERT, `realtime.topic()` + `auth.uid()`), RLS (ownership `EXISTS`, pinned `search_path`, revoke EXECUTE).
- Stack Overflow: `security definer search_path` must be pinned in-function (role-level SET is bypassable); authenticated Socket.IO rooms validate a token per emit.
- Local evidence: `migrations/20260903000001_multiroom-realtime-rls.sql:26-32`, `20260903100000_ephemeral-and-queue.sql:14-46`, `20260903000000_multiroom-core.sql:52-54,193-209`, `src/lib/realtime.ts:73-85`, `src/hooks/useYouTubeMusic.ts:81-84,424-443`, `src/pages/LobbyPage.tsx:40-56,125`.
