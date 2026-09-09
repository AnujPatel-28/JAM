# 009 — M Residual Hardening (purge throttle, impersonation, Sybil notes)

## Problem
- `purge_expired_rooms()` (anon, `SECURITY DEFINER`) fired on **every** lobby load + 15s auto-refresh → DB-wide `DELETE WHERE expires_at < now()` pressure, spammable by refresh loops.
- `protect_chat_display_name()` blocked only exact `ILIKE 'host'` for anon → `Host␣`, `ADMIN`, `MODERATOR`, victim display names all rendered; queue/room strings client-`maxLength`-only.
- Sybil: `session_id` is self-minted (`localStorage`), so 5-seat fill, 3-song bypass, and vote inflation need no account. No full fix exists without identity — caps are the mitigation.

## Decision
- **Purge throttle (client):** `LobbyPage` calls `purge_expired_rooms` at most once/60s/tab (ref-guarded, failure-silent); server cron stays the janitor. Server function untouched (needs anon for the public lobby).
- **Impersonation (server):** `protect_chat_display_name()` now trims/truncates (`user_name` ≤50, `message` ≤500) and maps trimmed case-insensitive `host|admin|moderator` → `Guest` for anon. Homoglyph policing explicitly out of scope (display-layer concern; React escapes HTML).
- **Sybil (documented, not solved):** 50-queued/room + 3-queued/session caps (from 20260903300000) + 5-seat atomic lock bound the damage; `member_token` (003) stops kick/vote replay without identity. True per-human limits need Turnstile/captcha or auth-gated queue — recorded as follow-up, not implemented here.

## Why
Throttle removes the accidental-DDoS shape (every visitor × every 15s) with zero API change. Trigger-level truncation is the last line behind client `maxLength` and RPC `substr()` — all three layers now agree (50/500/60/200/24). Sybil honesty: claiming a token "fixes" self-minted identity would be false; caps + ownership proofs are the correct partial mitigation.

## What changed
- `src/pages/LobbyPage.tsx` (purge throttle)
- `migrations/20260903500000_medium-hardening.sql` (trigger rewrite)

## Verify
- Static: `lastPurgeRef` + `60_000` in lobby; trigger contains `admin`, `moderator`, `substr`
- Manual: rapid lobby refresh → 1 purge RPC/min in network tab; anon post as ` Admin ` → renders `Guest`

## Rollback
Remove throttle guard (restore bare RPC); re-apply old trigger from `20260821120000_hardening.sql`.
