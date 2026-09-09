# 006 — H3 Password Strength + Spray Throttle

## Problem
`gen_salt('bf', 8)` (fast), min 3 chars (`create_room_secure`, `CreateRoomModal.tsx:23`), unlimited `join_room_secure` guesses with `!=` compare and `Room not found` vs `Incorrect password` oracle. Host-bypass + 2-min handover steal covered in 001–004's `claim_abandoned_room` RPC.

## Decision
- **New rooms:** min **8** chars (server `RAISE EXCEPTION` + client `minLength={8}`), bcrypt cost **12** (`gen_salt('bf', 12)`). Old 3-char rooms keep verifying (crypt is cost-agnostic) — no lockout migration.
- **Server throttle:** `pg_sleep(1)` on every `join`/`claim` failure path (not-found + bad-password). Error strings unchanged because `RoomPage`/`LobbyPage` branch on `includes('password'/'full')` — the delay is the mitigation; oracle accepted and documented.
- **Bounds:** `p_name` 1–60, `p_description` ≤200, display name 1–24 enforced server-side (were client-`maxLength`-only, bypassable via direct RPC).
- **Client cooldown:** `PasswordPromptModal` 10s lockout after 3 failures — UX only, server delay is the boundary.
- **Out of scope:** per-IP lockout and constant-time compare need backend rate-limit primitives not available in plain Postgres here — noted for platform-level follow-up (InsForge dashboard / edge throttling).

## Why
Cost 12 raises offline-crack cost ~16× vs 8 while keeping join latency acceptable (one hash per join, not per tick). `pg_sleep` makes online spray ~1s/attempt/connection without schema or API changes. Keeping error strings avoids breaking join-barrier UX (`needsPassword` vs `isFull` vs `joinError`).

## What changed
- `migrations/20260903400000_password-hardening.sql` (new)
- `src/components/CreateRoomModal.tsx` (min 8), `src/components/PasswordPromptModal.tsx` (cooldown)

## Verify
- Static: migration contains `gen_salt('bf', 12)`, `< 8`, `pg_sleep(1)`; modal contains `minLength={8}`, `cooldownUntil`
- Staging DB (not run): create private room with 7-char pwd → rejected; 8+ → bcrypt `$2a$12$` prefix in `room_secrets`; 5 rapid bad joins take ≥5s

## Rollback
Re-apply prior function definitions; old hashes still verify. Client min-length is backward-compatible (server enforces).
