# 010 — Staging Apply Prep + Live Runbook (NO DB TOUCHED YET)

## Status
EXECUTED 2026-09-03 on a purpose-created staging branch (no pre-existing staging
existed — `branch list` was empty, single prod project). Full results: `014-live-matrix-overloads.md`. TL;DR: 6 migrations applied clean, 11/11 live RPC checks pass, 1 blocking bug found+fixed (legacy overloads), 1 critical open item (service-level API key → dashboard action).

## Why staging-first (difficulties this system faces)
Researched (Stack Overflow + Supabase/Postgres docs, Sep 2026):
- **Realtime auth is cached per connection** until JWT refresh/reconnect. Policy changes do NOT affect live sockets; verify with fresh connects + `refreshAuth()` after login, or results mislead.
- **Broadcast private flag must match DB + client.** A public DB send never reaches a private channel subscriber and vice versa — a "fix that doesn't work" is often this mismatch, not RLS.
- **Per-subscriber RLS cost grows with fans** (Supabase WALRUS: ~11ms at 1 sub → ~300ms at 10k per record). Our rooms are ≤5 members so per-row `EXISTS` is fine; do NOT copy this shape to a global feed without the STABLE helper + index pattern.
- **DDL locks queue behind one slow query.** `ALTER TABLE … ADD COLUMN` with volatile default (`gen_random_bytes`) rewrites rows; our `room_members`/`room_queue` are tiny/ephemeral so this is acceptable — but set `lock_timeout` and apply off-peak anyway. Use `(select auth.uid())` form in policies (planner caches per-query; bare `auth.uid()` re-evaluates per row).
- **YouTube IFrame quirks that look like sync bugs:** post-2026-redesign `seekTo()` flashes full chrome even with `controls:0` (SO 79936448) — our 3-tier drift model (rate-adjust, seek only >800ms) already avoids this; pause vs seek both report state `2` (SO 18138031) so use the 1s re-check pattern already in `applyPlaybackState`; errors 101/150 (embed blocked) and 153 (missing Referer) need the autoplay-tap fallback already built; background tabs throttle timers (visibility reconcile already built).
- **Turnstile invisible mode can retry-loop** (SO 78351582); tokens are single-use, 300s expiry — always verify server-side via `siteverify`, never trust the widget alone (Phase C).

## Preflight checklist (run before apply)
- [ ] Staging project id/URL confirmed: `________________`
- [ ] Env set: `VITE_INSFORGE_URL`, `VITE_INSFORGE_ANON_KEY`, `INSFORGE_SERVICE_KEY`, `TEST_ROOM_ID`, `APP_ORIGIN`, `CLEANUP_TOKEN`
- [ ] `pgcrypto` extension present (`SELECT * FROM pg_extension WHERE extname='pgcrypto'`)
- [ ] Current migration head recorded; full DB export/snapshot taken
- [ ] `lock_timeout = '5s'` set for the apply session; off-peak window chosen
- [ ] Rollback notes ready: prior definitions in `20260903000001`, `20260903100000`, `20260903000000`, `20260824120000`, `20260903200000`, `20260821120000`; legacy channels re-enable statement in `20260903300000` header

## Apply order (staging only, when confirmed)
```bash
insforge -y db migrations up --all
node scripts/test-security-hardening.mjs
# then, with staging env exported:
# node scripts/test-multiroom-rpc.mjs
# node scripts/test-phase3-queue.mjs
# node scripts/test-phase4-sync.mjs
```

## Live matrix (record pass/fail + timings in this doc's appendix when run)
1. Non-host `realtime.publish(room:<victim>:sync)` → rejected; host → accepted (fresh sockets!)
2. Anon `SELECT chat/queue/members WHERE room_id=<private>` → 0 rows; host reads own
3. `leave/ping` wrong token → 0 rows; right token → ok; owner `user_id` bypass ok
4. Create private room 7-char → rejected; 8+ → `$2a$12$` hash; 5 bad joins take ≥5s
5. Cleanup: `GET`→405, 11th req/min→429, bad token→401, valid cron→`{ok,cutoff}`
6. Expired JWT mid-session → visible "session expired" error (not silent); logout → host rights dropped
7. OTP 5-guess → resend gate; wrong email vs wrong password → identical message

## Key rotation decision (pending)
Exposed anon key (`005`): rotate in dashboard if repo/zip shared → re-run matrix with old key (must fail) and new key. Record decision + date below when done.

## Rollback
Re-apply prior migration files; `UPDATE realtime.channels SET enabled=true WHERE pattern IN ('player_sync','chat_messages')`; redeploy prior frontend (3-arg ping/leave defaults keep old clients compiling but denying — deploy BE+FE together).
