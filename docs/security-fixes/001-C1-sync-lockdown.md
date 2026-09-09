# 001 — C1 Realtime Sync Host Lockdown

## Problem
`migrations/20260903000001_multiroom-realtime-rls.sql:26-32` allows any `authenticated` user to `INSERT` to `room:%:sync` (plus legacy `player_sync`). Fast path (`src/hooks/useYouTubeMusic.ts:118-154`) publishes over WS, bypassing DB RLS. Client host check (`:424-430`) is admitted spoofable. `src/lib/realtime.ts:73-85` dispatches by event name only, so forged cross-room payloads render after a weak `room_id` filter (`useChatMessages.ts:81`).

## Decision
1. **DB (migration §2):** replace sync policy with strict regex + host ownership:
   `channel_name ~ '^room:[0-9a-f-]{36}:sync$' AND EXISTS (rooms.id = split_part(channel,':',2)::uuid AND host_id = auth.uid())`. Disable legacy `player_sync`/`chat_messages` channels. Guard the `::uuid` cast so malformed channels fail closed instead of erroring (planner may evaluate `EXISTS` before the regex).
2. **Client defense-in-depth:** channel-aware dispatch (`realtime.onChannel`) + strict `track.id` validation in `applyPlaybackState` (11-char `^[A-Za-z0-9_-]{11}$`, `albumArt` allowlist `img.youtube.com`/`i.ytimg.com`). Host UI gate stays UX-only; server is the enforcer.
3. **Kept:** `seq` monotonic logic as-is (see 004-B4); host-takeover re-baseline preserved.

## Why
Matches Supabase Realtime Authorization pattern (separate INSERT policy, topic + `auth.uid()` match; Stack Overflow `security definer` pinning for helper logic). Regex alone is insufficient (any authed user passes it); host `EXISTS` is the actual authorization. Cast guard avoids error-oracle/DoS on malformed channel names. Client validation limits iframe-embed injection even if a forged payload reaches the browser.

## What changed
- `migrations/20260903300000_security-hardening.sql` §2
- `src/lib/realtime.ts` — added `onChannel`/`offChannel`, kept `on` for compat
- `src/hooks/useYouTubeMusic.ts` — `isValidSyncTrackId` + album-art allowlist gate in `applyPlaybackState`
- Hooks updated to use `onChannel` (`useChatMessages.ts`, `useRoomQueue.ts`, `useYouTubeMusic.ts` subscribe path)

## Verify (no DB)
- `npm run build`, `npm run lint`
- Grep: no `player_sync` publish left in trigger path except disabled channel row; `~ '^room:` present in migration
- DB (staging, not run here): non-host `realtime.publish('room:<victim>:sync')` rejected; host publish accepted; forged `track.id` ignored client-side

## Rollback
Re-enable legacy channels (`UPDATE realtime.channels SET enabled=true …`), restore prior policy file. Client changes are backward-compatible (old `on` still works).
