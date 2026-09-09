# 021 — Prod apply + schema-cache error explained + friendly queue errors

## The user's screenshot, explained simply
Red text: `Could not find the function public.request_song(…8 params…) in the schema cache`.
- **Use case that hit it:** guest tapped "Add to Queue" after pasting a YouTube link (oEmbed preview rendered fine — that part needs no backend).
- **What it means:** the app asked the database for `request_song` with 8 arguments (including the new `p_member_token`), but **prod only knew the old 7-argument version** — our 6 migrations lived on staging only. PostgREST looks up functions by exact signature ("schema cache") and found no match.
- **Why chat + play worked in the same session:** those paths need no queue RPC (chat = realtime WS, play = host broadcast). Only "Add to Queue" touched the missing function. This also confirms `020` is live and working on mobile.

## Fix executed (2026-09-03, prod)
1. Backup: prod schema+functions export to temp (`prod-prehardening-schema.sql`).
2. `insforge -y db migrations up --all` on prod → all 6 applied (`03300000`–`03800000`, incl. the overload-drop).
3. Verified live on prod: only secure overloads remain (`request_song` 8-arg, `toggle` 3-arg, `ping`/`leave` 3-arg, single `join`), `chk_queue_status` present.
4. Proof the exact error is gone: 8-arg `request_song` against prod now returns a proper logic error (`room expired/inactive`) instead of schema-cache.
5. CLI note: `branch switch --parent` errors when already on parent ("No parent backup found") — check `insforge current` instead; context is prod (`p4rcgqh8`). Staging reachable via `branch switch staging`.

## Friendly errors (frontend)
`useRoomQueue.requestSong` used to render raw `error.message` (the red schema-cache text). New `mapQueueError`: known backend messages pass through; infra gibberish (`schema cache`, `PGRST*`, missing relation/function) → `Song service is updating. Please try again in a moment.`; network failures → `Network hiccup…`; anything >120 chars → generic. Backend stays the enforcer; this is display-layer only.

## What changed
- Prod DB: 6 migrations applied (first prod write of this program; backup taken)
- `src/hooks/useRoomQueue.ts` (`mapQueueError`)

## Verify
- Static suite + lint + build; user retest on mobile: paste link → Add to Queue → song appears (no red text)
- If red text ever returns with "schema cache", it means frontend/backend drifted again — compare `pg_proc` signatures vs the RPC call args

## Rollback
DB: re-apply prior definitions (headers in each migration file) + restore backup if needed. Frontend mapper is display-only, safe to keep.
