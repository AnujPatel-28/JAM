# 005 — H1 Secrets Hygiene

## Problem
Live backend URL + anon key were baked into trackable files with `|| fallback` semantics: `test-multiroom-rpc.mjs:3-4`, `test-phase3-queue.mjs:3-4`, `test-phase4-sync.mjs:3-4`, `handshake-test.mjs:3`, and `relay-test.mjs:5` (mislabeled `ADMIN`, same value as the anon key, plus a live room UUID). Any clone, zip, or future `git add` from the Desktop-root monorepo ships working credentials. `dist/` also bakes `VITE_*` by design.

## Decision
- All scripts are **env-only + fail-fast**: missing vars throw with a pointer to this doc. No `|| '<url>'` / `|| 'ik_…'` fallbacks anywhere.
- `relay-test.mjs`: `ADMIN` → `INSFORGE_SERVICE_KEY` (fail-fast), `ROOM_ID` → `TEST_ROOM_ID` (fail-fast). Never reuse the anon key as the write-path key — the old code proved nothing about privilege separation.
- `.env.example` documents the two test-only vars without values. `.env`, `dist/`, `.insforge/` stay gitignored (verified).
- Rotation note: the exposed anon key should still be rotated in the InsForge dashboard if the repo/zip was ever shared — code cleanup does not un-leak a key.

## Why
Fallbacks defeat rotation: after rotating the key in the dashboard, every stale fallback still carries the old live credential and silently re-authenticates old checkouts. Fail-fast forces one source of truth (`process.env`) and makes missing-env failures loud in CI instead of silently testing the wrong project.

## What changed
- `scripts/test-multiroom-rpc.mjs`, `test-phase3-queue.mjs`, `test-phase4-sync.mjs`, `handshake-test.mjs`, `relay-test.mjs`, `.env.example`

## Verify
- `grep -rn "ik_\|p4rcgqh8" scripts/ .env.example` → no hits (run in verification step)
- `node scripts/test-security-hardening.mjs` extended with a secrets check (next edit)

## Rollback
Re-add fallbacks (do not — this would re-leak). To run tests locally: set env vars per `.env.example`.
