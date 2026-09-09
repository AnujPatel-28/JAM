# 012 — Turnstile Bot Gates + Abuse Controls

## Problem
Room creation + song queue are anon-reachable: self-minted `session_id` ⇒ unlimited rooms, 50-song fills, vote inflation (Sybil, `009`). No human check anywhere; per-IP limits don't exist in plain Postgres here.

## Decision
- **Widget:** zero-dep `TurnstileWidget.tsx` (explicit render, compact **managed** mode — invisible mode retry-loops per SO 78351582; singleton script tag; expiry/error/timeout all clear the token).
- **Server verify:** `functions/verify-turnstile.ts` POSTs `{secret, response}` to Cloudflare `siteverify`; allowlisted `APP_ORIGIN`, POST-only, generic failures (no `error-codes` echo). Secret is `TURNSTILE_SECRET_KEY` (function env, never `VITE_`).
- **Gating points:** `CreateRoomModal` (room spam) + `RequestSongModal` (queue spam). Token verified **before** the RPC; token reset after each attempt (single-use, 300s expiry). Submit disabled until solved.
- **Feature-flag:** no `VITE_TURNSTILE_SITE_KEY` ⇒ widget hidden, flow unchanged. Verify helper (`src/lib/turnstile.ts`) defaults to `${VITE_INSFORGE_URL}/functions` — confirm the functions route prefix in the InsForge dashboard (some projects use `/api/functions/*`); override via `VITE_FUNCTIONS_URL`.
- **Not done:** per-IP DB rate limits + OTP server lockout still need platform primitives (noted in `006`/`008`); service-role split for purge still pending dashboard work.

## Why
Widget-alone is theater (tokens must hit `siteverify` — dev.to/Astro+React guide, bliztek server pattern). Gating creation + queue covers the two cheapest abuse funnels; join stays frictionless (capacity lock already bounds it, and gating join would hurt the invite-link UX). Managed-visible over invisible trades one checkbox for no retry-loop support load.

## What changed
- `src/components/TurnstileWidget.tsx`, `src/lib/turnstile.ts`, `functions/verify-turnstile.ts` (new)
- `src/components/RequestSongModal.tsx`, `src/components/CreateRoomModal.tsx` (gate), `.env.example` (keys)

## Verify
- Static: no secret in `src/` (only `VITE_TURNSTILE_SITE_KEY` public); submit disabled without token when configured; token reset after verify
- Staging (not run): valid solve → create/request succeeds; reused token → rejected; wrong secret → generic failure; unset site key → legacy flow

## Rollback
Unset `VITE_TURNSTILE_SITE_KEY` (widgets disappear, zero code change) or revert the two modals. Function is additive.
