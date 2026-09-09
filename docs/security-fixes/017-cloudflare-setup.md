# 017 — Cloudflare Agent Setup (skills + MCP) for Deploys

## What was done (2026-09-03, per https://developers.cloudflare.com/agent-setup/prompt.md)
- Installed 13 Cloudflare skills globally (`npx -y skills add cloudflare/skills --skill '*' --yes --global`) → live in `~\.agents\skills\` (auto-loaded by OpenCode; includes `wrangler`, `turnstile-spin`, `workers-best-practices`).
- Registered 5 MCP servers in `~/.config/opencode/opencode.jsonc` (`cloudflare`, `cloudflare-docs`, `cloudflare-bindings`, `cloudflare-builds`, `cloudflare-observability`).
- Verified: `opencode mcp list` shows all 5; `cloudflare-docs` connected (public, no auth).

## Pending (needs the human): OAuth login
`opencode mcp auth cloudflare` opens a browser login that cannot be completed headlessly — it timed out waiting. Run in your own terminal:
```powershell
opencode mcp auth cloudflare
```
Complete the Cloudflare login in the browser tab it opens (one login covers all 4 authed servers). Then **quit and restart opencode** (config + MCP load at startup only).

## Deploy goal (wifi-jokey frontend, Cloudflare Pages)
Once MCP auth is done, remaining deploy steps:
1. Confirm the Pages project name for `wifi-jokey.pages.dev` (via MCP or dashboard).
2. Set Pages env vars (Production + Preview): `VITE_INSFORGE_URL`, `VITE_INSFORGE_ANON_KEY` (`anon_…`), optionally `VITE_TURNSTILE_SITE_KEY`. NEVER `VITE_INSFORGE_API_KEY` (see README env table).
3. Trigger redeploy (dashboard Retry or new commit) so `dist/` (with `_headers`) + new key ship.
4. Verify live: key fingerprint in bundle is `anon_`, security headers present.

## Deploy verified LIVE (2026-09-03, user deployed via `wrangler pages deploy dist`)
- `https://wifi-jokey.pages.dev` → 200; CSP header = our policy; `X-Frame-Options: DENY`, `nosniff`, HSTS all present (`_headers` active).
- Live bundle contains `anon_` key and **no** `ik_` key — the key split has shipped to production.

## Rollback
Remove the `mcp` block from `opencode.jsonc` to detach; skills stay inert until invoked.
