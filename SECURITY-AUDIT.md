# WiFi Jokey — Security Audit & Remediation Guide

> **Date:** 2026-09-03
> **Scope:** `wifi-jokey/` — React 19 + Vite frontend (`src/`), InsForge Postgres + PostgREST + Realtime (`migrations/*.sql`), `functions/cleanup-chat.ts`, `scripts/*.mjs`, supply-chain (`package.json`, `vite.config.ts`, `index.html`)
> **Method:** Read-only static audit + targeted verification. No exploits executed against prod. Secrets redacted as `ik_***` / `<appkey>`.
> **Status:** Findings open — see remediation checklist below.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Severity Overview](#2-severity-overview)
3. [Critical Findings](#3-critical-findings)
4. [High Findings](#4-high-findings)
5. [Medium Findings](#5-medium-findings)
6. [Low / Hygiene Findings](#6-low--hygiene-findings)
7. [Supply-Chain & Headers](#7-supply-chain--headers)
8. [Remediation Plan](#8-remediation-plan)
9. [Verification Checklist](#9-verification-checklist)
10. [Appendix — Files Audited](#10-appendix--files-audited)

---

## 1. Executive Summary

WiFi Jokey is a synchronized ephemeral audio lounge: React frontend, InsForge (Postgres 16 + PostgREST + Socket.IO realtime), YouTube IFrame + oEmbed.

Architecture strengths verified:

- `room_secrets` isolated with `REVOKE ALL` from `anon,authenticated` — hash never sent to client.
- `join_room_secure()` uses `FOR UPDATE` row lock + stale purge + idempotent rejoin — race-safe for capacity.
- Frontend uses `import.meta.env.VITE_*` only in `src/lib/insforge.ts`, `src/lib/realtime.ts` — no hardcoded keys in `src/`.

Load-bearing gaps:

1. **Realtime sync publish lost its host check** — any authenticated user can publish to `room:<victim>:sync`.
2. **World-readable tables (`USING(true)`)** — private room chat/queue/members/playback enumerable by anon.
3. **`leave/ping` with no ownership** — anyone with leaked `session_id` can kick / keep-alive others.
4. **All `SECURITY DEFINER` RPCs lack `search_path` + open `EXECUTE TO PUBLIC`**, weak bcrypt cost 8, 3-char passwords, CORS `*`, no CSP.

Fix in the order in Section 8. C1–C3 first.

---

## 2. Severity Overview

| ID | Title | Severity | Location |
|----|-------|----------|----------|
| C1 | Realtime sync publish — host check dropped, cross-room injection | Critical | `migrations/20260903000001_multiroom-realtime-rls.sql:26-32`, `src/hooks/useYouTubeMusic.ts`, `src/lib/realtime.ts` |
| C2 | World-readable rooms/chat/queue/members — private-room IDOR | Critical | `migrations/20260903000001_multiroom-realtime-rls.sql:36-38`, `20260903100000_ephemeral-and-queue.sql:42-46`, `20260903000000_multiroom-core.sql:52-54`, `src/pages/LobbyPage.tsx:38-44` |
| C3 | `leave_room` / `ping_room_presence` no ownership — kick anyone | Critical | `migrations/20260903000000_multiroom-core.sql:193-209` |
| H1 | Live key fallbacks in `scripts/` + `dist/` bundle + fragile Desktop-root git | High | `scripts/*test.mjs`, `dist/assets/*.js`, `.insforge/project.json` |
| H2 | `SECURITY DEFINER` without `search_path`, open EXECUTE, unwhitelisted `p_status` | High | all RPCs, `20260903100000_ephemeral-and-queue.sql:139-167` |
| H3 | Weak private passwords (bcrypt 8, min 3), unlimited spray, host-handover steal | High | `20260903000000_multiroom-core.sql:83-149`, `20260824120000_host-handover.sql` |
| H4 | `cleanup-chat` CORS `*`, unsafe token compare, global delete | High | `functions/cleanup-chat.ts:1-44` |
| H5 | Realtime anon downgrade + stale JWT, OTP brute-force, user enumeration | High | `src/lib/realtime.ts:148-157`, `src/components/AuthModal.tsx` |
| M1-M6 | Sybil sessions, client-only host gates, passwords in storage, no CSP, unsanitized strings, sync track injection | Medium | see §5 |
| L1-L4 | Legacy table, purge abuse, LIKE bypass, healthy deps | Low | see §6 |

---

## 3. Critical Findings

### C1: Any authenticated user can publish forged playback sync

**Evidence:**

`migrations/20260903000001_multiroom-realtime-rls.sql:26-32`:

```sql
CREATE POLICY "room host can publish room sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name LIKE 'room:%:sync'
    OR channel_name LIKE 'realtime:room:%:sync'
    OR channel_name IN ('player_sync', 'realtime:player_sync')
  );
```

No `EXISTS (SELECT 1 FROM rooms WHERE host_id = auth.uid())`. Prior lockdown `migrations/20260822130000_publish-lockdown.sql:21-30` had the host check — this is a regression.

Fast path bypasses DB entirely:

`src/hooks/useYouTubeMusic.ts:118-154` — `fastBroadcast` / `broadcastSync` via `realtime.publish('room:${roomId}:sync','sync',payload)` over WS.

Code itself warns `src/hooks/useYouTubeMusic.ts:424-430`:

```ts
// (Best-effort: the host id is publicly readable, so a determined
// attacker can still spoof it — real enforcement must be server-side.)
if (hostIdRef.current && state.hostId !== hostIdRef.current) return false;
```

Global dispatch `src/lib/realtime.ts:73-85` routes by event name (`sync`, `message`, `queue_update`) not channel — forged `{room_id: victim}` from another room renders after client filter `useChatMessages.ts:81`.

**Impact:** track hijack, forced seek/pause, loud content, phishing thumbnails for all listeners in victim room.

**How to handle:**

1. Restore host check + strict channel match. Drop legacy channels:
```sql
DROP POLICY IF EXISTS "room host can publish room sync" ON realtime.messages;
CREATE POLICY "room host can publish room sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-f-]{36}:sync$'
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = split_part(channel_name, ':', 2)::uuid
        AND r.host_id = auth.uid()
    )
  );
-- Disable legacy:
-- UPDATE realtime.channels SET enabled=false WHERE pattern IN ('player_sync','chat_messages');
```
2. Remove dual-publish to `player_sync` in `broadcast_playback_state()` (`20260903000001:48-59`).
3. Client: keep `isHost` UI gate but treat as UX only; add server fetch reconciliation on `sync` (already have `visibilitychange` pattern — reuse).
4. Frontend `realtime.ts`: dispatch by `(channel, event)` tuple, drop `onAny` by event alone.

### C2: Private-room data enumerable by anon (IDOR)

**Evidence:**

```sql
-- 20260903000001:36-38
CREATE POLICY "select chat_messages by room" ... FOR SELECT TO anon,authenticated USING(true);
-- 20260903100000:42-46
CREATE POLICY "anyone can view room_queue" ... USING(true);
CREATE POLICY "anyone can view queue_votes" ... USING(true);
-- 20260903000000:52-54
CREATE POLICY "members can view room occupants" ON room_members ... USING(true);
-- 20260821000000: rooms SELECT USING(true) never revoked
```

`src/pages/LobbyPage.tsx:38-44`:

```ts
.from('rooms').select('*').eq('is_active',true)...limit(20)
```

Fetches `id,code,host_id,is_private,playback_state` for private rooms too. `src/pages/LobbyPage.tsx:53-56` dumps all `room_members(room_id)`. Then anon can:

- `SELECT chat/queue/votes/members WHERE room_id=<victim>`
- `request_song(p_room_id,...)` — checks only `expires_at/is_active`, never membership/password (`20260903100000:48-102`)
- `toggle_upvote_song`, `chat INSERT (room_id IS NOT NULL...)`, `get_active_room_members(p_room_id)` with no check
- `select playback_state` (`useYouTubeMusic.ts:404-408`) leaks now-playing

**Impact:** private chat/queue eavesdrop, spam without joining, presence enumeration.

**How to handle:**

1. Replace `USING(true)` with membership or public-only:
```sql
-- Example: rooms directory only public
DROP POLICY IF EXISTS "rooms select" ON public.rooms;
CREATE POLICY "rooms select public or member" ON public.rooms
  FOR SELECT TO anon,authenticated
  USING (
    NOT is_private
    OR host_id = auth.uid()
    OR EXISTS (SELECT 1 FROM room_members m WHERE m.room_id = rooms.id AND m.session_id = nullif(current_setting('request.jwt.claims',true)::jsonb->>'session_id','')::uuid)
  );
-- Same pattern for chat_messages / room_queue / room_members:
-- USING (EXISTS (SELECT 1 FROM room_members ... ) OR host check)
```
Simpler interim: lobby uses a `rooms_public` view (`id,code,name,description,active_count`) with `WHERE NOT is_private`; detail fetch requires `join_room_secure` proof.
2. Add membership check inside `request_song`, `toggle_upvote_song`, chat `INSERT` policy.
3. Change lobby `select('*')` → explicit column list excluding `host_id,playback_state`.

### C3: Kick / ghost via `ping` / `leave` replay

**Evidence:**

`migrations/20260903000000_multiroom-core.sql:193-209`:

```sql
CREATE FUNCTION ping_room_presence(p_room_id UUID, p_session_id UUID) ... UPDATE ... WHERE room_id=p_room_id AND session_id=p_session_id;
CREATE FUNCTION leave_room(p_room_id UUID, p_session_id UUID) ... DELETE ... WHERE room_id=p_room_id AND session_id=p_session_id;
```

No ownership. `session_id` leaks via C2. `scripts/test-multiroom-rpc.mjs:183-186` shows anon `leave_room` succeeds.

**How to handle:**

- Bind authed sessions: `WHERE ... AND (user_id = auth.uid() OR (auth.uid() IS NULL AND session_id = p_session_id AND <proof>))`.
- For anon, require a per-join secret (return `member_token` from `join_room_secure`, store HttpOnly-ish in memory, require on `ping/leave`), rotate on rejoin.
- Rate-limit `ping` (20s heartbeat already — enforce server `last_seen > now()-10s → no-op`).

---

## 4. High Findings

### H1: Secrets in trackable files + bundle + fragile git root

- `src/lib/insforge.ts:3-4`, `src/lib/realtime.ts:18-19` — clean (`import.meta.env` only). Good.
- Bad: `scripts/handshake-test.mjs:3`, `relay-test.mjs:5` (`ADMIN='ik_***'` mislabeled, same as anon), `test-multiroom-rpc.mjs:3-4`, `test-phase3-queue.mjs:3-4`, `test-phase4-sync.mjs:3-4` use `process.env.X || 'https://<appkey>...'` / `|| 'ik_***'` fallback. `git check-ignore` confirms NOT ignored — will leak on first `git add`.
- `.insforge/project.json` duplicates URL + `ik_***` + `project_id/org_id/appkey` — ignored today but fragile.
- `dist/assets/*.js` contains baked `VITE_*` by design — do not zip/share `dist/`.
- Git root is `Desktop/` with no root `.gitignore`; `wifi-jokey/` is untracked (`git status` shows `??`). A root `git add -A` stages the scripts.

**How to handle:**

1. Replace all fallbacks with strict env-only:
```js
const URL = process.env.VITE_INSFORGE_URL; if(!URL) throw new Error('missing env');
```
2. Add root `.gitignore` + `wifi-jokey/scripts/.gitignore` for `*-test.mjs` or strip keys before commit.
3. Use dedicated repo, not Desktop root.
4. Rotate anon key in InsForge dashboard if repo ever pushed/shared. Keep `npm ci` (lockfile `integrity` present), run `npm audit` in CI.

### H2: `SECURITY DEFINER` hardening missing

All of `generate_unique_room_code, create_room_secure, join_room_secure, ping, leave, get_active_room_members, request_song, toggle_upvote, update_queue_status, purge_expired_rooms, get_server_time, broadcast_playback_state, protect_chat_display_name` lack `SET search_path` and `REVOKE EXECUTE`.

`update_queue_status(p_status TEXT)` (`20260903100000:139-167`) does `UPDATE room_queue SET status=p_status` with no whitelist; DDL is `VARCHAR(20) DEFAULT 'queued'` only.

`realtime.messages` `LIKE 'room:%:chat'` matches `room:evil:chat:extra`.

**How to handle:**

```sql
ALTER FUNCTION public.join_room_secure(...) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.join_room_secure(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.join_room_secure(...) TO anon, authenticated;
-- repeat per RPC; purge_* only to authenticated or service role
ALTER TABLE room_queue ADD CONSTRAINT chk_status CHECK (status IN ('queued','playing','played','rejected'));
-- realtime policy: use regex ^room:[uuid]:(sync|chat|queue)$ instead of LIKE
```

### H3: Weak passwords + spray + handover steal

- `crypt(trim(p_password), gen_salt('bf',8))` cost 8 → use 12.
- Min 3 chars (`create_room_secure`, `CreateRoomModal.tsx:23`) → min 8 + strength hint.
- `join_room_secure` unlimited guesses, `!=` compare, oracle `Room not found` vs `Incorrect password`.
- Host bypass `host_id IS DISTINCT FROM auth.uid()` + public `host_id` + `20260824120000_host-handover.sql:25-35` (`claim when host_last_seen IS NULL OR <now()-2min`) → any authed user steals private host after laptop sleep (heartbeat `useYouTubeMusic.ts:627-640` every 30s).

**How to handle:** cost 12, min length 8 server + client, per-IP/code rate-limit (e.g. 5/min, lockout), constant-time compare, generic `Invalid code or password`, require membership + password even for handover, shorten heartbeat to 20s (matches doc) + extend steal window to 5m.

### H4: `functions/cleanup-chat.ts` — CORS `*` + global wipe

`functions/cleanup-chat.ts:3-7` `Allow-Origin:*`, allows `GET`, `token !== Deno.env CLEANUP_TOKEN` (timing-unsafe), no rate-limit, `createClient({anonKey: ADMIN_API_KEY})` confusion, `delete().lt(created_at,cutoff)` globally, returns `deleted:data` oracle.

**How to handle:**

```ts
const ALLOWED = new Set([Deno.env.get('APP_ORIGIN')!]);
const origin = req.headers.get('origin');
const cors = { 'Access-Control-Allow-Origin': ALLOWED.has(origin)?origin:'null', 'Access-Control-Allow-Methods':'POST, OPTIONS', ... };
// POST only, timingSafeEqual for token, rate-limit by IP, scope delete by room or use service role with audit log
```

### H5: Auth downgrade + OTP + enumeration

- `src/lib/realtime.ts:148-157` JWT failure → `useApiKeyFallback=true` reconnect as anon — “publishes will simply be anonymous”. Masks errors, defeats host-only policies.
- `refreshAuth()` never called from `useAuth` signIn/out.
- `AuthModal.tsx:39-54` resend cooldown 60s client-only, 6-digit OTP no lockout, `70-73` fragile `/^[verif]/` mode switch, `75 setError(err)` verbatim → user enumeration.
- `useYouTubeMusic.ts:169-181` 401 → `refreshAccessToken()` once, no forced signOut.

**How to handle:** fail-closed for sync (no anon fallback), call `refreshAuth()` on auth change, server OTP rate-limit + lockout, generic auth errors, force signOut + socket reconnect on 401.

---

## 5. Medium Findings

### M1: Sybil sessions — infinite UUIDs

`src/lib/session.ts:7-27` `localStorage wj_session_id = crypto.randomUUID() else Math.random()` (predictable fallback), sole auth for anon chat/vote/presence (`useRoomQueue.ts:26,51,122,163`, `RoomPage.tsx:74`). Mint infinite UUIDs → fill 5/5 DoS, bypass 3-song limit, inflate votes. No rotation on sign-out. `optimisticId=temp-${Date.now()}` predictable.

**Fix:** bind `session_id` to `auth.uid()` when signed in, per-IP throttling for anon joins, captcha/turnstile on create/join, rotate session on sign-out, server UUIDv4 validate.

### M2: Host is UI-only

`src/pages/RoomPage.tsx:211` `isHost = auth.user && roomData.host_id===auth.user.id` gates `265-271,486,523,550,637`, `SongQueuePanel.tsx:72`. `updateStatus`, `loadTrack/play/pause/seek`, `update({playback_state,host_last_seen})` (`useYouTubeMusic.ts:162-177,628-640`) have no in-body host assert — flip in DevTools or call RPC/WS directly. `create host UPDATE ... WITH CHECK(host_id=auth.uid())` allows `max_members=1000` or `is_private=false`.

**Fix:** enforce host server-side (C1/H2), constrain host `UPDATE` column list + `max_members<=5` check.

### M3: Room passwords in browser storage

`src/pages/LobbyPage.tsx:125-126` `sessionStorage.setItem('wj_pwd_<CODE>',password)`, `RoomPage.tsx:89-92,129-131` + `navigate(state:{password})`. Plaintext, per-tab, predictable key, XSS-readable.

**Fix:** keep in memory only, clear on leave/unmount, warn against reuse, never log.

### M4: No CSP / security headers

`vite.config.ts:1-7`, `index.html`, `dist/index.html` — no `CSP, HSTS, X-Frame-Options, Referrer-Policy`, no SRI (`crossorigin` only). With YouTube IFrame, `noembed.com`, `img.youtube.com`, `images.unsplash.com`, `*.insforge.app` WSS, XSS can exfil `localStorage` UUID, `sessionStorage` pwd, SDK JWT.

**Fix (hosting `_headers` / `vercel.json` + meta fallback):**

```
Content-Security-Policy: default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; img-src 'self' https://img.youtube.com https://images.unsplash.com data:; connect-src 'self' https://<appkey>.<region>.insforge.app wss://<appkey>.<region>.insforge.app https://noembed.com https://www.youtube.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### M5: Unsanitized stored strings (impersonation / phishing)

React escapes `<script>` (`RoomPage.tsx:625`, `SongQueuePanel.tsx:52`), but no sanitize/length server-side for chat `message/user_name` (`useChatMessages.ts:165-193` 500 client-only), `displayName` (`session.ts:29-39` trim only — set `Host/Admin`), queue `title/artist/album_art` (`request_song` trim only, `video_id VARCHAR(20)` accepts `"><script>`), room `name/description` (client `maxLength 60/50` only), `youtubeMetadata.ts:30-38` trusts `noembed.com` verbatim, `thumbnail_url` → `<img src>` tracker.

`protect_chat_display_name()` only blocks exact `ILIKE 'host'` — bypass `Host␣`, `H0st`, homoglyphs.

**Fix:** server `length()` checks + strip control chars, allowlist `video_id ^[A-Za-z0-9_-]{11}$`, sanitize `thumbnail_url` (allow `https://img.youtube.com/` + `https://i.ytimg.com/` only), uniqueness-reserve `Host`, linkify safely or not at all.

### M6: Sync track injection bypasses YouTube validator

`lib/providers/youtube.ts:42-55` whitelist good, but `useYouTubeMusic.ts:419-464 applyPlaybackState()` never calls `extractYouTubeId` — pushes `state.track` directly to `videoId: currentTrack.id` (`874`) → `https://www.youtube.com/embed/${videoId}`. Attacker `publish(room:ID:sync, forged track{id:'"><img...'})` attempts iframe src injection / arbitrary embed. `YouTubePlayer.tsx:26-31` no `sandbox/referrerPolicy/allow` restriction.

**Fix:** validate `track.id` regex server + client, validate `albumArt` URL allowlist, add `referrerPolicy`, minimal `allow="autoplay; encrypted-media"`.

---

## 6. Low / Hygiene Findings

- **Legacy `song_requests` still anon-writable** (`WITH CHECK(true)`) — drop table or revoke.
- **`purge_expired_rooms()` anon-spammable** (`LobbyPage.tsx:34` every visit) — restrict to authenticated + throttle, or cron only.
- **Channel LIKE bypass** — `%` matches `:` — use `~ '^room:...$'` + UUID cast.
- **Open redirect:** none — `navigate('/')`, `navigate('/room/${cleanCode}')` internal only. Keep `roomCode` charset `^[A-Z0-9]{4,8}$` server-side to avoid `//evil` in `RoomHeader.tsx:66 inviteUrl`.
- **CSRF:** low (Bearer JWT, not cookies, no `credentials` strings) — but anon `sessionId` actions + `*` CORS make cross-site spam trivial if backend allows. Tighten CORS (H4) + require membership (C2).
- **Deps healthy today:** `react 19.2.8` (RSC CVE-2025-55182 N/A, DoS fixed), `vite 8.2.1` (>8.0.16 Windows ADS fix — never `vite --host` on untrusted net), `socket.io-client 4.8.3/ws 8.21.3` patched, `react-router 7.18.2` patched, `npm audit --omit=dev` 0. Verify `framer-motion@13.1.0` legitimacy via `npm view`, pin + `npm ci`.

---

## 7. Supply-Chain & Headers

| Area | State |
|------|-------|
| `package-lock.json` | Present, v3, `resolved` + `integrity` — good. No `file:/git+ssh/http:` deps sampled. |
| `vite.config.ts` | Minimal — small surface but zero `server.headers` / CSP plugin. |
| `tsconfig` | `strict`, `noUnusedLocals` — good; `skipLibCheck:true` normal but hides dep type errors. |
| `index.html` / `dist/index.html` | No CSP meta, no SRI (`crossorigin` only). |
| `public/` | Clean (`favicon.svg`, `icons.svg`). |
| `.env.example` | Placeholders only — safe. |
| `.gitignore` | Correct for `.env/dist/.insforge` but only nested; root `Desktop/` has no `.gitignore` — fragile. |
| `oEmbed` | `https://noembed.com/embed?url=` 4s timeout, silent fallback — leaks video IDs to third party, fires per keystroke (`RequestSongModal.tsx:17-29` no debounce). Add debounce/abort + privacy note. |

---

## 8. Remediation Plan

Execute in order. Each step: migrate → re-test script → manual re-test.

### Phase 0 — Stop the bleed (today)

- [ ] Rotate anon key if repo/zip/`dist/` ever shared. Update `.env` + `.insforge/project.json` locally only.
- [ ] `gitignore` scripts with keys or strip fallbacks; never `git add -A` from `Desktop/`.
- [ ] Disable legacy realtime channels (`player_sync`, `chat_messages`) if unused.
- [ ] Restrict `cleanup-chat` to known origin + `POST` only.

### Phase 1 — Backend RLS + RPC (C1–C3, H2–H3)

- [ ] Rewrite `realtime.messages` sync policy with host check + regex (C1 snippet).
- [ ] Scope `rooms/chat/queue/votes/members SELECT` to member/host/public as appropriate; lobby view explicit columns (C2 snippet).
- [ ] Add membership check to `request_song`, `toggle_upvote_song`, chat `INSERT`.
- [ ] Ownership token for `ping/leave`; bind `session_id` to `auth.uid()` where present.
- [ ] `SET search_path`, `REVOKE/GRANT EXECUTE`, `CHECK(status)`, bcrypt cost 12, min pwd 8, rate-limit join, generic errors, handover requires membership.

Example hardening template per function:

```sql
-- after CREATE OR REPLACE FUNCTION public.<fn>(...) ... SECURITY DEFINER;
ALTER FUNCTION public.<fn>(...) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public.<fn>(...) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.<fn>(...) TO anon, authenticated;
-- purge_* : TO authenticated only (or service_role)
```

### Phase 2 — Frontend auth + validation (H5, M1–M3, M5–M6)

- [ ] Fail-closed realtime: no anon fallback for `sync`; `refreshAuth()` on signIn/signOut; forced signOut on 401.
- [ ] Memory-only room password, clear on leave; generic auth errors; server OTP limit.
- [ ] Validate `track.id` + `albumArt` allowlist on every `applyPlaybackState`; `referrerPolicy` + minimal `allow`.
- [ ] Server length/format checks for displayName/chat/title/artist/room name/description; reserve `Host`.

### Phase 3 — Platform hardening (H4, M4, H1)

- [ ] `cleanup-chat`: origin allowlist, `POST,OPTIONS` only, `timingSafeEqual`, rate-limit, scoped role.
- [ ] CSP + `nosniff` + `frame-ancestors` + `Referrer-Policy` + `HSTS` via host config + meta fallback; SRI for bundle.
- [ ] Root `.gitignore`, dedicated repo, `npm ci` + `npm audit` + Dependabot.

---

## 9. Verification Checklist

```bash
# from wifi-jokey/
npm ci
npm audit --omit=dev --audit-level=moderate
npm run build

# backend (needs env, no hardcoded fallbacks after fix)
node scripts/test-multiroom-rpc.mjs
node scripts/test-phase3-queue.mjs
node scripts/test-phase4-sync.mjs
```

Manual:

- [ ] Anon `SELECT chat/queue/members WHERE room_id=<private>` denied.
- [ ] Authed non-host `publish(room:ID:sync)` rejected.
- [ ] `leave_room` with чужой `session_id` rejected.
- [ ] Lobby `select` shows public only, no `host_id/playback_state`.
- [ ] Wrong password ×6 → throttled, generic error.
- [ ] `update_queue_status(p_status='hacked')` rejected.
- [ ] `cleanup-chat` from random origin → blocked without token; with token rate-limited.
- [ ] CSP blocks inline exfil test; YT + InsForge WSS still work.

---

## 10. Appendix — Files Audited

`src/lib/insforge.ts`, `src/lib/realtime.ts`, `src/lib/session.ts`, `src/lib/clockSync.ts`, `src/lib/youtubeMetadata.ts`, `src/lib/providers/youtube.ts`, `src/hooks/useAuth.ts`, `src/hooks/useChatMessages.ts`, `src/hooks/useRoomQueue.ts`, `src/hooks/useYouTubeMusic.ts`, `src/pages/LobbyPage.tsx`, `src/pages/RoomPage.tsx`, `src/components/*`, `src/main.tsx`, `migrations/*.sql` (12), `functions/cleanup-chat.ts`, `scripts/*.mjs`, `package.json`, `package-lock.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `public/`, `dist/` (presence + baked-key check), `.env.example`, `.gitignore`, `.insforge/project.json`.

> Do not paste live keys, `room_id` UUIDs, or `dist/` bundles into tickets. Rotate keys after any share.
