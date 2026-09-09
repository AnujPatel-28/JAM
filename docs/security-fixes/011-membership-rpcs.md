# 011 — Membership-Token Queue RPCs (C2 follow-up)

## Problem
`002` scoped READS, but `request_song` / `toggle_upvote_song` accepted any `room_id` + self-minted `session_id` with no presence proof — knowing a private `room.id` was enough to stuff its queue and votes without the password (C2 write half).

## Decision
- New migration `20260903600000_membership-rpcs.sql`: both RPCs take `p_member_token TEXT DEFAULT NULL`. **Public rooms stay open** (lobby visitors can request/vote — product behavior preserved). **Private rooms** require `member_token` match on an active membership row (`last_seen` < 45s) OR host `auth.uid()`. Old callers compile (defaults) but fail closed on private rooms.
- Chat `INSERT` deliberately unchanged: anon private members (`user_id NULL`, password-joined) cannot prove membership in pure RLS; reads already denied, payloads capped, rows ephemeral. Full fix (token column on `chat_messages`) deferred and stated here, not silently skipped.
- Frontend `useRoomQueue` passes `getMemberToken(roomId)` on both calls.

## Why
Presence proof belongs at the RPC layer (SO authenticated-rooms pattern: validate a per-member secret per emit, never trust `session_id`). Splitting public-open vs private-gated avoids breaking the lobby-to-queue funnel while closing the private leak. `DEFAULT NULL` keeps deploys atomic (old frontend vs new DB fails closed, not crashing).

## What changed
- `migrations/20260903600000_membership-rpcs.sql` (new, not applied)
- `src/hooks/useRoomQueue.ts` (token on request + vote)

## Verify
- Static: `p_member_token` in migration + hook; public-branch (`NOT private → open`) present
- Staging (not run): private request/vote with room-id only → `Join the room…`; with joined token → success; public anon → success; old 2-arg call on private → denied

## Rollback
Re-apply prior function definitions from `20260903300000`/`20260903400000`. Frontend token args are ignored by old functions — safe to keep.
