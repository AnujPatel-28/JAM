# 020 — Guest realtime blackout: gateway rejects `apiKey` auth form

## Symptom (user report, live prod)
Guest (signed-out) on mobile, same WiFi, Android Chrome, private room: chat stuck on "Connecting", no music. Host on desktop fine. Same-WiFi rules out carrier websocket blocking; guest-vs-host difference isolated it to auth.

## Root cause (proven live, staging probe 2026-09-03)
The realtime gateway accepts ONLY `auth: { token }` (user JWT **or** `anon_` key):
- `{ apiKey: anon_ }` → `ERROR: Invalid API key` (websocket AND polling)
- `{ token: anon_ }` → `CONNECTED in 631ms`
- no auth → rejected (correct)

`realtime.ts buildAuth()` sent `{ apiKey }` for every signed-out visitor → handshake always failed → `connect()` never resolved → `isConnected` false forever ("Connecting") and zero sync events (no music). Signed-in users were unaffected (JWT path). So this was never a mobile/device issue — any guest on any device was dark. Music compounded: private-room guests also can't DB-fetch `playback_state` (anon RLS denies private), so with no socket there was no track source at all.

## Fix
- `buildAuth()` returns `{ token: userToken ?? apiKey }` in all paths (fallback + error callback included).
- New `authed` flag (true only on real JWT): `isDegraded = fallback || !authed`; `publishSync` throws unless connected AND authed (anon may listen/chat, never broadcast sync — server would reject anyway).
- `scripts/handshake-test.mjs` header documents the accepted form.

## Why this shape
Token-form anon is a *legit working* auth (not a downgrade), so the H5 fallback path is preserved for listening while sync stays fail-closed with a loud error. No transport change needed — websocket connected fine in the probe.

## Known remainder (private-room guests)
Guest in a private room now gets live chat + live sync ticks, but still no *initial* `playback_state` (paused host = silent guest until host plays). Full fix needs member-proofed state reads (JWT claim / token view) — follow-up, same family as `011` chat-INSERT note.

## Verify
- Static: no `apiKey:` auth payload left in `src/`; `publishSync` checks `authed`
- Live probe results above; user retest: guest mobile should show Live + hear music (tap once for autoplay)
- `npm run lint`, `npm run build`

## Rollback
Restore `{ apiKey }` returns (re-breaks all guests — do not).
