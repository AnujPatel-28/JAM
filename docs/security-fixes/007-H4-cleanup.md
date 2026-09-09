# 007 — H4 Cleanup Endpoint Lockdown

## Problem
`functions/cleanup-chat.ts`: `Access-Control-Allow-Origin: *`, `GET` allowed, timing-unsafe `!==` token compare, no rate limit, `500` leaked `error.message`, `200` returned deleted rows (`deleted: data` oracle + content leak). A leaked/static `CLEANUP_TOKEN` meant full chat wipe from any origin.

## Decision
- **CORS:** allowlisted `APP_ORIGIN` (comma-separated env) only, `Vary: Origin`, methods `POST, OPTIONS`, headers include `x-cleanup-token`. No `*`. Non-browser callers (cron) work via token without ACAO.
- **Method:** `POST` only (`405` otherwise) — safe-method crawlers/preloads can't trigger deletes.
- **Auth:** constant-time `constantTimeEqual` compare, missing-secret fails closed, identical `401` body either way.
- **Rate limit:** 10 req/min/IP in-memory (documented best-effort single-isolate; platform limits stay outer boundary).
- **Leak removal:** `500` → generic `Cleanup failed`; `200` → `{ ok, cutoff }` only, no row dump.
- **Not changed:** `ADMIN_API_KEY` naming/env wiring (dashboard concern) — flagged: must be a server-only key, never the anon key; set `APP_ORIGIN` + `CLEANUP_TOKEN` in function env.

## Why
`*` + `GET` made the endpoint callable from any site/`<img>` prefetch with only the static token as defense. Constant-time compare removes length/timing oracle; method + rate limits blunt spray; no row echo removes content oracle. Each is cheap and independent.

## What changed
- `functions/cleanup-chat.ts` (full rewrite, same path/signature)

## Verify
- Static: no `'*'` ACAO, `req.method !== 'POST'` → 405, `constantTimeEqual` present, no `deleted: data`, no `error.message` echo
- Live (not run): wrong token → 401 ×2 same body; 11th req/min → 429; `GET` → 405; random origin gets no ACAO; valid cron POST → `{ok,cutoff}`

## Rollback
Restore prior file from git. Requires setting `APP_ORIGIN` for browser callers — cron unaffected.
