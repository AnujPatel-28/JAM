# 014 — Live Matrix on Staging: Overload Bug + Service-Key Discovery

## Status
Executed on staging branch `staging` (project `27fb3723-…`, host `<appkey>-xwm`), PG 15.18. Prod untouched. Backup: `prehardening-schema.sql` (temp dir, schema+functions, pre-apply).

## Finding 1 (blocking, FIXED): legacy RPC overloads survived
- **Cause:** `p_member_token TEXT DEFAULT NULL` via `CREATE OR REPLACE` creates a SECOND overload; Postgres keeps the old signature. Old `leave_room(uuid,uuid)`, `ping(uuid,uuid)`, `request_song(7 args)`, `toggle(uuid,uuid)` stayed callable, and PostgREST returned `PGRST203` (ambiguous) for token-less calls.
- **Evidence (staging, pre-fix):** `pg_proc` listed both signatures; `request_song` without token → `PGRST203`; forged-kick test inconclusive (victim row had been stale-pruned by a later join, >45s gap — methodology flaw, not a vuln proof).
- **Fix:** `migrations/20260903800000_drop-legacy-overloads.sql` (`DROP FUNCTION` × 4 exact signatures). Post-fix `pg_proc` shows only `…(uuid,uuid,text)` / 8-arg forms. Lesson for future RPC changes: same-signature `OR REPLACE` or explicit `DROP` — never rely on defaults to replace.
- **Why this matters:** without the drop, C3 was NOT closed (old 2-arg kick path live).

## Finding 2 (critical, OPEN — dashboard action): project API key is service-level
- **Evidence:** key-only REST read `chat_messages WHERE room_id=<private>` → 1 row; `room_queue`, `room_members` → 1 row; `room_secrets SELECT *` → 1 row **despite `REVOKE ALL … FROM anon, authenticated` and zero policies**. No-key → 401. Conclusion: the key bypasses RLS + grants (service role). Same value sits in `.env`, `VITE_` bundle, all scripts (pre-`005`), and `.insforge/project.json`.
- **Consequence:** anyone holding the shipped JS bundle holds full DB access TODAY, independent of every RLS policy in this repo. Rotation alone is insufficient if the replacement is equally privileged.
- **Required (InsForge dashboard, cannot do from CLI):**
  1. Create a restricted publishable/anon key (anon + authenticated roles only, RLS-enforced).
  2. Point `VITE_INSFORGE_URL`/`VITE_INSFORGE_ANON_KEY` (`.env`, hosting env) at the restricted key.
  3. Reserve the service key for server-side only (`INSFORGE_SERVICE_KEY`, functions env).
  4. Rotate the current leaked key, then re-run: old key must 401, restricted key must get 0 rows on the C2 reads.
- Until then: C2 read-isolation is verified at **policy-definition level** (`db policies` exact-match: `NOT r.is_private OR host = auth.uid()`, no `USING(true)`), NOT behaviorally.

## Live results (2026-09-03, staging, `scripts/test-security-live.mjs`)
11/11 PASS: token issuance on join; forged kick denied + presence kept; heartbeat accepted; wrong-pwd rejected; 2 bad joins 2.1s+ (`pg_sleep`); private request/vote denied without token, accepted with token; bogus status rejected (`Invalid queue status`); signin errors backend-identical (`008` maps to generic client-side).
Also live-verified: `chk_queue_status` = `queued|playing|played|rejected`; `search_path=public, pg_temp` on `join_request/get_server_time`; sync/chat realtime policies exact-match with cast-guarded regex; `player_sync`+`chat_messages` channels disabled; `song_requests` zero policies.
- **Stale-prone tests:** `get_active_room_members` excludes `last_seen` > 45s — keep test gaps < 45s (first run's victim row was legitimately stale-pruned, not kicked).
- **Email-gated:** staging enforces signup email verification, so no throwaway authed users; matrix is anon-RPC-shaped by design. OTP server lockout still unverified live.

## Context warning (do not "fix" by switching)
Local CLI context is intentionally left on the **staging** branch (safer default than prod for future `up`). `.env` still points at **prod**. Never `insforge db migrations up` expecting prod while context says staging and vice versa — always run `insforge current` first.
