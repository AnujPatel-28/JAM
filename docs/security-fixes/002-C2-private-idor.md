# 002 — C2 Private-Room IDOR Scoping

## Problem
`chat_messages` / `room_queue` / `queue_votes` / `room_members` `SELECT USING(true)` to `anon,authenticated` + `rooms SELECT USING(true)` + `LobbyPage.tsx:40 select('*')` leaks private `id,code,host_id,playback_state`. Knowing `room_id` suffices for `request_song`/`toggle`/`chat INSERT`/`get_active_room_members` — none check membership/password.

## Decision (fail-closed interim)
- **Rooms directory:** lobby queries public only (`eq('is_private', false)`) with explicit column list (no `select('*')`, no `host_id`/`playback_state` in list items).
- **RLS (migration §3):**
  - `rooms` SELECT: public rows, or host-owned (`host_id = auth.uid()`). Private non-host reads denied.
  - `chat_messages` / `room_queue` / `queue_votes` SELECT: parent room must be public, or host-owned. (Same fail-closed reasoning as 004-B3: anon cannot prove membership in pure RLS.)
  - `room_members` SELECT: parent room public, or caller is host, or caller is the member row owner (`user_id = auth.uid()`).
  - Private content path stays `join_room_secure()` (password-enforced) + room-scoped fetches by id after join.
- **Not done here (flagged):** RPC-level membership-token checks for `request_song`/`toggle_upvote`/`chat INSERT` — needs the C3 token plumbed through those RPCs (H-scope follow-up). `request_song` hardening that *is* included: 11-char video-id regex, title/artist/album_art truncation, 50-queued cap (DoS barrier), preserved 3-per-session limit.

## Why
Supabase/IDOR guidance: `USING(true)` = public; ownership via `EXISTS (… user_id = (select auth.uid()))`. A predicate that passes on "any active member exists" is not authorization (004-B3). Denying anon private reads at RLS while keeping the password-gated RPC path preserves functionality and closes enumeration. Explicit lobby columns stop `host_id`/`playback_state` leakage even for public rooms.

## What changed
- `migrations/20260903300000_security-hardening.sql` §1 (updated_at), §3 (policies, status CHECK with `rejected`, `request_song`/`update_queue_status`/`toggle_upvote` hardening + `search_path`)
- `src/pages/LobbyPage.tsx` — public-only + explicit columns + scoped member counts
- `src/hooks/useChatMessages.ts` — explicit columns instead of `select('*')`

## Verify (no DB)
- Grep: no `select('*')` on `rooms` in lobby; `eq('is_private', false)` present; migration has no `USING (true)` for the five tables
- Staging DB (not run): anon `SELECT chat WHERE room_id=<private>` → 0 rows; host reads own private rows; public lobby loads

## Rollback
Restore prior `USING(true)` policies (migration down-script in file header comments). Lobby change is backward-compatible (fewer columns/rows, same `RoomListItem` shape).
