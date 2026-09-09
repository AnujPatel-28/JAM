# 004 — Plan Blockers Fixed Before C1–C3

## B1. Status enum: `dismissed` → `rejected`
- **Problem:** `security_hardening_plan.md` used `CHECK (status IN ('queued','playing','played','dismissed'))`. Live code uses `'rejected'`: `src/hooks/useRoomQueue.ts:17` type union, `:171` `updateStatus(queueId, status: 'playing'|'played'|'rejected')`, `src/pages/RoomPage.tsx:688` `updateStatus(id,'rejected')`. Table comment in `20260903100000:24` also says `'rejected'`. Applying `dismissed` would reject every dismiss.
- **Decision:** use `('queued','playing','played','rejected')`.
- **Why:** match code + existing comment; no frontend change needed.

## B2. Missing `updated_at` column
- **Problem:** plan SQL does `UPDATE room_queue SET status=…, updated_at=now()` in `update_queue_status` and `toggle_upvote_song`. `room_queue` DDL (`20260903100000:14-26`) has `created_at` only — migration would fail with `column updated_at does not exist`.
- **Decision:** `ALTER TABLE room_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` in §1 of the new migration, then use it.
- **Why:** preserves plan intent (recount + timestamp) with a schema-safe additive change. Alternative (drop `updated_at`) was rejected to keep audit trail.

## B3. C2 chat predicate was still world-readable
- **Problem:** plan §3 `USING (EXISTS (… rooms … AND (NOT is_private OR host=auth.uid() OR EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=r.id AND last_seen>…))))` — inner `EXISTS` checks *any* active member, not the requester. Any private room with ≥1 occupant becomes readable by the whole internet.
- **Decision:** fail-closed predicate (see `002-C2-private-idor.md`): public rooms readable; private rooms readable only by host (`auth.uid()`) via RLS. Anon private reads denied at RLS; private content is delivered only through `join_room_secure()` (which already enforces the password). Documented as interim because anon cannot prove membership in pure RLS (no `auth.uid()`); full per-member private RLS needs a JWT `session_id` claim or app-level token check, which is follow-up work.
- **Why:** closes the leak without inventing an unenforceable membership test. Matches Supabase guidance: never `USING(true)` for non-public data.
- **Also fixed:** `room_queue` / `queue_votes` / `room_members` / `rooms` SELECT scoping was missing from the plan — added in §3 (public-or-host / public-directory-only). `request_song`/`toggle` still deliberately require follow-up membership-token checks (noted in 002).

## B4. Rejected: `seq` jump > 1000 drop
- **Problem:** plan suggested dropping sync `seq` jumps > 1000 as DoS protection. `src/hooks/useYouTubeMusic.ts:81-84` uses `seq = Date.now()`-based (`Math.max(Date.now(), seq+1)`), ticks every ~3s → normal jumps are ~3000. A >1000 cutoff would drop legitimate ticks.
- **Decision:** rejected. Kept existing monotonic check (`state.seq <= lastAppliedSeq` + host-change re-baseline, `:440-443`), which already prevents replay/old-state overwrite.
- **Why:** evidence over speculation; avoids breaking sync.

## B5. Password cost left at 8
- **Problem:** plan comment said "cost 12 compatible" but kept `gen_salt('bf', 8)`.
- **Decision:** left at 8 in this pass (out of C1–C3 scope), flagged for H-scope pass with rate-limit + min-length-8 + generic errors. Changing cost now would slow joins without the accompanying throttle/lockout design.
