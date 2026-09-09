# 016 — Key Split, Option A: anon_ Key in the Bundle (DONE)

## Discovery (InsForge docs + CLI, 2026-09-03)
Every InsForge project has TWO keys, confirmed in docs (`docs.insforge.dev/faq`, `get-anon-key` endpoint):
- **Anon Key** (`anon_…`): public client identifier, maps to the `anon` role, **RLS is the boundary**. Safe in frontend bundles. Fetchable by project admins (`GET /api/metadata/anon-key`, or here via `insforge secrets get ANON_KEY`).
- **API Key** (`ik_…`): full-access admin, **bypasses RLS either way**, server-only.
- Our app shipped `ik_…` in `VITE_` — wrong key. Auth header detail found empirically: `anon_…` authenticates via `Authorization: Bearer` (SDK handles it); `x-api-key` is the admin path.

## What was done
1. Retrieved staging `ANON_KEY` via CLI (value never printed/stored in repo; staging-only copy in OS temp, prod copy likewise).
2. **Behavioral proof on staging** (private fixture SECT02, since cleaned): anon key → chat/queue/members on private room = 0 rows each; `room_secrets` → `42501 permission denied`; public directory works; correct-password join issues token; wrong password rejected. 6/6.
3. Retrieved prod `ANON_KEY`, verified (`42501` on secrets, public reads fine, join RPC reachable), swapped `.env` `VITE_INSFORGE_ANON_KEY` to it (deduped a double line — both were the same value), left CLI context on **staging**, `.env` on **prod**.
4. `015`'s rotation item stands: old `ik_` dies ~24h after user's dashboard action — retest then (expect 401). Staging `project.json` still holds the old `ik_` (staging SDK runs will 401 after deactivation — refresh then).

## Why this closes the master-key issue
Threat model before: every browser held a bypass key → RLS decorative. After: browsers hold `anon_…` → `anon`/`authenticated` roles → every policy in `20260903300000` actually gates. Service key (`ik_…`) must now live ONLY in: function env (`ADMIN_API_KEY`), server scripts via `INSFORGE_SERVICE_KEY`, never `VITE_`.

## Remaining for the user (dashboard/hosting)
- Hosting is **Cloudflare Pages**: set `VITE_INSFORGE_ANON_KEY` = `anon_…` value in Pages project **Settings → Environment variables** (Production + Preview), then redeploy (the UI session should rebuild after that — the bundle must be rebuilt for the key swap to ship). `public/_headers` is copied to `dist/` and applies automatically — no `vercel.json` needed.
- Optional: `POST /api/secrets/anon-key/rotate` if the anon key itself ever leaks (it's public-by-design; rotation is hygiene, not emergency).

## 2026-09-03 follow-through (done by agent)
- `APP_ORIGIN=https://wifi-jokey.pages.dev` set via CLI on **both prod and staging** (was missing everywhere — browser calls would have lacked ACAO).
- Both rewritten functions **deployed to staging** (`verify-turnstile` new, `cleanup-chat` updated): live `GET→405`, `POST no-token→401`, bad verify token→generic failure. `TURNSTILE_SECRET_KEY` still unset (needs Cloudflare Turnstile secret from user).
- Note: deployed functions were stale (Aug 23 build) until this deploy — treat function deploys as part of every relevant change, not automatic with migrations.
- Hosting is Cloudflare Pages (`016` correction): `public/_headers` is copied to `dist/` and applies automatically — no `vercel.json` needed. (An old `VERCEL_WEBHOOK_SECRET` in function secrets is unrelated to frontend hosting.)

## Verify (done)
- Static suite + lint green; live anon matrix 6/6 staging; prod anon probe clean.
- Pending (time-gated): old-`ik_` 401 retest post-deactivation.
