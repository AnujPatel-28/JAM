# Security Fixes — Decision Log (Criticals C1–C3)

Scope agreed: fix `SECURITY-AUDIT.md` Criticals C1–C3 first. Code + SQL files, **no `insforge db` apply**.

Research backing (web + Stack Overflow, Sep 2026):
- Supabase Realtime Authorization docs: separate `SELECT` vs `INSERT` on `realtime.messages`, match `realtime.topic()` + `auth.uid()` + `extension`, `private:true` channels, disable public access.
- Supabase RLS docs: `USING(true)` to `anon` = public; use ownership `EXISTS (… user_id = (select auth.uid()))`; `SECURITY DEFINER` must have pinned `search_path` (`SET search_path = public, pg_temp`) + `REVOKE EXECUTE FROM PUBLIC`.
- IDOR in Supabase (vibeappscanner 2026): frontend `.eq()` filtering is not security; enforce in RLS + RPC ownership checks.
- Stack Overflow authenticated Socket.IO rooms pattern: validate a per-member token on every emit, never trust client `session_id` alone.

## Status

| ID | Doc | Code/SQL | Status |
|----|-----|----------|--------|
| Blockers | `004-plan-blockers.md` | migration `20260903300000_security-hardening.sql` §§0–1 | done, not applied to DB |
| C1 sync spoof | `001-C1-sync-lockdown.md` | same migration §2 + `realtime.ts` + `useYouTubeMusic.ts` | done, not applied |
| C2 IDOR | `002-C2-private-idor.md` | same migration §3 + `LobbyPage.tsx` | done, not applied |
| C3 kick | `003-C3-kick-protection.md` | same migration §4 + `session.ts` + `RoomPage.tsx` | done, not applied |
| H1 secrets | `005-H1-secrets.md` | 5 scripts env-only + `.env.example` | done |
| H3 passwords | `006-H3-passwords.md` | migration `20260903400000_password-hardening.sql` + 2 modals | done, not applied |
| H4 cleanup | `007-H4-cleanup.md` | `functions/cleanup-chat.ts` | done (set `APP_ORIGIN`/`CLEANUP_TOKEN` env) |
| H5 auth | `008-H5-auth.md` | `realtime.ts`, `useYouTubeMusic.ts`, `useAuth.ts`, `AuthModal.tsx` | done |
| M residual | `009-M-residual.md` | migration `20260903500000_medium-hardening.sql` + lobby throttle | done, not applied |
| Staging prep | `010-staging-apply.md` | runbook only — NO DB touched, needs staging project id | prep done, awaiting confirmation |
| Membership RPCs | `011-membership-rpcs.md` | migration `20260903600000_membership-rpcs.sql` + `useRoomQueue.ts` | done, not applied |
| Turnstile | `012-turnstile-abuse.md` | widget + `verify-turnstile` fn + 2 modals (flagged off when unconfigured) | done (needs keys + route confirm) |
| Hygiene | `013-hygiene-sweep.md` | `_headers`, oEmbed debounce, `20260903700000_legacy-cleanup.sql`, names | done, migration not applied to prod (applied staging) |
| Staging exec | `010-staging-apply.md` + `014-live-matrix-overloads.md` | staging branch created, backup saved, **6 migrations applied to staging**, 11/11 live checks | done 2026-09-03; prod NOT touched |
| Key rotation | `015-key-rotation.md` | old key deactivates ~24h; rotation verified, split was still open | split CLOSED by `016` (anon_ in bundle) |
| Key split A | `016-key-split-anon.md` | `.env` → prod `anon_` key; staging anon matrix 6/6; fixture cleaned | done 2026-09-03; rebuild+redeploy to ship; old-ik 401 retest pending |
| Functions live | (in `016`) | `APP_ORIGIN` set prod+staging; both functions deployed to staging and live-tested (405/401/generic-fail) | done staging; prod function deploy + `TURNSTILE_SECRET_KEY` pending user |
| Auth UX | `018-auth-ux.md` | Eye toggles ×3 modals; signup inbox notice (verification already enforced) | done (44/44 static, build green; lint warnings all from parallel UI WIP) |
| Guest realtime | `020-guest-realtime-auth.md` | anon key sent as `token` (gateway rejects `apiKey`); `authed`-gated sync publish | done (45/45 static, build green) — NEEDS rebuild+redeploy to reach users |
| Prod apply | `021-prod-apply-queue-error.md` | **6 migrations applied to PROD** (backup taken); queue error explained + friendly mapper | done 2026-09-03 (46/46 static, build green) — user retest: Add to Queue on mobile |
| Email vacancy | `019-email-vacancy.md` | CLI metadata check prod+staging: SMTP off + verification on = codes never arrive | BLOCKED on dashboard email flip; CLI cannot change it |

## Verification (no DB)
- `node scripts/test-security-hardening.mjs` → **40 passed, 0 failed**
- `npm run lint` → 0 warnings, 0 errors
- `node scripts/test-security-live.mjs` (staging only) → **11 passed, 0 failed**
- Staging branch holds `20260903300000`–`20260903800000`. **Prod NOT touched.** Open prod gates: dashboard restricted-key split + rotation (see `014`), then re-run live C2 reads with the restricted key, then apply to prod in a window with `010` preflight.

## Master env-key table (11 keys total)

| # | Key | Where to set | Required? | Notes |
|---|-----|--------------|-----------|-------|
| 1 | `VITE_INSFORGE_URL` | `.env` + Cloudflare Pages env | Yes | Public backend host |
| 2 | `VITE_INSFORGE_ANON_KEY` | `.env` + Cloudflare Pages env | Yes | Must be `anon_…` (RLS-enforced). NEVER `ik_…` |
| 3 | `VITE_TURNSTILE_SITE_KEY` | Cloudflare Pages env | Optional | Unset = bot gates off |
| 4 | `VITE_FUNCTIONS_URL` | Cloudflare Pages env | Optional | Defaults to `<URL>/functions`; confirm route |
| 5 | `APP_ORIGIN` | InsForge function env | Yes (functions) | Your Cloudflare site origin(s), comma-separated |
| 6 | `CLEANUP_TOKEN` | InsForge function env | Yes (cleanup) | Long random string |
| 7 | `INSFORGE_BASE_URL` | InsForge function env | Yes (functions) | Reserved secret, already present |
| 8 | `ADMIN_API_KEY` | InsForge function env | Yes (cleanup) | Must be service/`ik_` key, never the anon key |
| 9 | `TURNSTILE_SECRET_KEY` | InsForge function env | When Turnstile on | From Cloudflare dashboard |
| — | `VITE_INSFORGE_API_KEY` | NOWHERE — must not exist | Banned | No code reads it; as `VITE_` it would rebundle the master key into the site |
| 10 | `INSFORGE_SERVICE_KEY` | Local shell only, never committed | Tests only | For `relay-test.mjs` |
| 11 | `TEST_ROOM_ID` | Local shell only, never committed | Tests only | Staging room UUID |
