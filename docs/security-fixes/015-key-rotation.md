# 015 — Key Rotation Verification (privilege split NOT achieved)

## What was done (user, dashboard, 2026-09-03)
Old key scheduled for deactivation within 24h; new key placed in `.env` (`VITE_INSFORGE_ANON_KEY` fingerprint changed — confirmed locally, values never printed).

## Verification results (all against prod host, harmless probes only)
- Old key `rooms?select=id` → **200** (still alive; grace period — retest after 24h).
- Old vs new on `room_secrets`: both `200 []` (prod appears empty — inconclusive alone).
- **Decisive probe:** `POST room_secrets` with a deliberately FK-violating row (zero data impact — row can never insert):
  - old key → `409 FK violation (23503)`
  - new key → `409 FK violation (23503)`
  - A restricted key would have failed FIRST with a permission error (`42501`/403). Passing the privilege check to reach the FK check proves the **new key also bypasses `REVOKE ALL`** — i.e. it is service-level, same as the old one.

## Meaning
Rotation without scoping just swaps one master key for another. The shipped bundle (`VITE_` key) still implies full DB access; RLS constrains JWT callers, not key holders. This cannot be fixed in code — only with a restricted/publishable key type.

## Required follow-up (dashboard or InsForge support)
1. Look for a **publishable/anon** key type (vs secret/service) — if none exists, ask InsForge support how to obtain an RLS-enforced client key.
2. After old-key deactivation (~24h): re-run `rooms?select=id` with old key → must be 401. Then re-run the C2 read matrix with the final client key.
3. Staging branch (`project.json`) still holds the OLD key — after deactivation it will 401; re-link/refresh the branch key then.
4. Keep service key server-side only (`INSFORGE_SERVICE_KEY`, function env).

## What changed (repo)
- No code changes in this step (operational verification only).
- `.env` now holds the new key (user edit). Never commit it.
