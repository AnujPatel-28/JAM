# 003 — C3 Member-Token Kick Protection

## Problem
`ping_room_presence(p_room_id, p_session_id)` / `leave_room(p_room_id, p_session_id)` (`20260903000000:193-209`) act on bare `session_id`. `session_id` is `localStorage` UUID (`src/lib/session.ts:10-27`), leaked via world-readable `room_members` (C2) and lobby counts (`LobbyPage.tsx:53-56`). Anyone can keep ghosts alive or kick anyone (`test-multiroom-rpc.mjs:183-186` shows anon `leave_room` works).

## Decision
- **DB (migration §4):** `room_members.member_token VARCHAR(64)` (`gen_random_bytes(24)` hex, pgcrypto already enabled). `join_room_secure()` mints fresh token per join/rejoin, returns it once. `ping`/`leave` signature `(p_room_id, p_session_id, p_member_token TEXT DEFAULT NULL)` requires `member_token = p_member_token OR (user_id IS NOT NULL AND user_id = auth.uid())`. `DEFAULT NULL` keeps old 2-arg calls compiling but fail-closed (NULL matches nothing unless owner bypass applies). `get_active_room_members()` unchanged shape (no token column) — token never listed.
- **Client:** token kept in **memory only** (`src/lib/session.ts` module-scoped store, never `localStorage`/`sessionStorage`), captured from `join_room_secure` response in `RoomPage`, passed to `ping`/`leave`/cleanup. Room password also moved from `sessionStorage wj_pwd_*` (`LobbyPage.tsx:125`, `RoomPage.tsx:92,130`) to memory (`location.state` → `useRef`, cleared on leave). Rotation on rejoin invalidates other tabs — accepted tradeoff, documented in UI? No — silent rejoin works because current tab holds the fresh token.
- **Why memory, not storage:** matches Stack Overflow authenticated-room pattern (per-emit secret, never client-enumerable); XSS-readable storage would reintroduce the leak. `localStorage session_id` stays (capacity rejoin needs persistence) but is no longer sufficient for side effects.

## What changed
- `migrations/20260903300000_security-hardening.sql` §4 (+ `search_path` pinning)
- `src/lib/session.ts` — `set/get/clearMemberToken(roomId)` memory store
- `src/pages/LobbyPage.tsx` — no `sessionStorage` password write; router-state only
- `src/pages/RoomPage.tsx` — memory password ref, token capture, token on ping/leave/cleanup

## Verify (no DB)
- Grep: no `wj_pwd_` in `src/`; `p_member_token` in migration + RoomPage calls; `member_token` absent from `get_active_room_members` return + lobby selects
- Build/lint pass. Staging DB (not run): `leave_room` with valid `session_id` + wrong token → 0 rows deleted; with correct token → deleted; owner `user_id` bypass works for signed-in owner

## Rollback
Old 2-arg `ping`/`leave` calls still resolve (defaults) but deny — to fully restore old behavior, redeploy prior function definitions. Token column is additive and safe to keep.
