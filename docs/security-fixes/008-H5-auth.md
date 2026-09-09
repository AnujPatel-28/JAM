# 008 — H5 Fail-Closed Realtime Auth + OTP/Enumeration

## Problem
- `realtime.ts` JWT handshake failure silently reconnected with the anon key (`useApiKeyFallback`), so host sync publishes went out anonymous and were RLS-rejected without surfacing — masking expired sessions.
- `refreshAuth()` was never called on sign-in/out → socket kept the old credential (stale-JWT reuse after logout, missing host rights after login).
- Backend auth errors rendered verbatim (`user not found` vs `wrong password` → account enumeration); OTP 6-digit had client-only 60s resend cooldown, unlimited guesses.

## Decision
- **Fail-closed sync:** new `publishSync()` throws when `isDegraded`; `fastBroadcast`/`broadcastSync` catch it and set `Your session expired — sign in again to keep broadcasting.` Chat/queue keep anonymous-capable `publish()` (their RLS allows anon).
- **Socket re-auth:** `useAuth` calls `realtime.refreshAuth()` on sign-in/sign-up/verify/sign-out.
- **Generic errors:** `mapAuthError()` collapses credential failures to `Invalid email or password.`, verification to `Invalid or expired verification code.`, conflicts/rate-limits to fixed strings.
- **OTP limit:** 5 bad codes in `AuthModal` forces fresh-code resend + 60s cooldown (client UX; server lockout remains the boundary — flagged for backend follow-up).

## Why
Silent downgrade is worse than failure: the host sees "broadcasting" while listeners hear nothing. Failing loud restores the feedback loop. Generic errors remove the enumeration oracle at near-zero UX cost (legit users retry the same way). Socket reconnect on auth change is the documented Socket.IO pattern (disconnect + reconnect with fresh token).

## What changed
- `src/lib/realtime.ts` (`isDegraded`, `publishSync`), `src/hooks/useYouTubeMusic.ts` (2 call sites), `src/hooks/useAuth.ts` (mapper + 4 `refreshAuth` calls), `src/components/AuthModal.tsx` (OTP counter)

## Verify
- Static: `publishSync` used only for `:sync`; `refreshAuth` in all 4 auth paths; no raw `error.message` return in `useAuth`
- Manual: expire JWT mid-session → host sees session-expired error (not silent); logout → socket drops host rights; wrong email vs wrong password → identical message

## Rollback
Revert to `publish()` at the 2 call sites; remove `refreshAuth` calls (socket re-handshakes on natural reconnect).
