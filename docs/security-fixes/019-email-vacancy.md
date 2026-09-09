# 019 — Email Verification vacancy: SMTP off + verification on (login failures)

## Finding (InsForge CLI `metadata`, 2026-09-03, BOTH prod and staging)
- `requireEmailVerification: true`, `verifyEmailMethod: code`, `resetPasswordMethod: code`
- `smtpConfig.enabled: false` (host `smtp.resend.com:465`, user `resend`, password stored, sender `Wifi Jokey <onboarding@resend.dev>`, resend cooldown 60s)

## Meaning
New signups demand a 6-digit code that **can never arrive** — the mail sender is switched off. This exactly matches the user report (`Invalid email or password` on a fresh account; the account exists but is stuck unverified). Existing already-verified accounts are unaffected. Password-reset codes are equally dead.

## Why CLI can't fix it
No CLI command manages auth/email config (`db/functions/storage/secrets/logs/metadata` only). Enabling the sender is dashboard-only: InsForge dashboard → project → **Auth / Authentication → Email** (or Settings → Email/SMTP): enable the email sender (stored Resend creds exist — just flipped off — or switch on the default provider), then send a test code.

## What changed (repo)
- Nothing (operational finding). `018` modal work already handles the verified-side UX (inbox notice, resend, 5-guess gate); it cannot conjure undeliverable mail.

## Verify after the dashboard flip
1. Sign up a fresh `@example.com`-style test address → code arrives ≤60s → verify → sign in works.
2. Resend respects the 60s cooldown; 5 wrong codes force resend (client gate, `008`).
3. If mail still doesn't arrive: check spam + InsForge logs for the send error, and confirm the sender domain is verified in Resend.

## 2026-09-03 follow-up: two separate issues found, neither is a wrong password
1. **SMTP still OFF on prod** (re-checked via CLI `metadata` after the user's toggle flip — `smtpConfig.enabled: false`). The flipped toggle was something else (three unrelated `enabled: true` entries exist nearby). The mail sender is specifically under Auth/Email-SMTP settings.
2. **The account does not exist**: `auth.users WHERE email='anuj2812004@gmail.com'` → 0 rows on prod. The error message is literally accurate — there is nothing to sign into. Almost certainly a signup attempt died at the unverifiable OTP step (see above), so the user believes they have an account.
3. Correct order: enable SMTP first → **Sign Up** (not Sign In) fresh → enter the emailed code → then sign in works.

## 2026-09-03 follow-up 2: screenshot shows a THIRD lock — signups disabled
User screenshot (Auth Settings → General): **"Disable New User Signups" is ON** (green). CLI confirms prod: `disableSignup: true`, SMTP still off, 4 existing users, reporter's email absent.
- Meaning: public sign-up is rejected at the door. Even with SMTP fixed, the reporter cannot self-register while this stays on.
- Two valid setups — pick one:
  - **A. Open hosting (recommended for this app):** turn OFF "Disable New User Signups" + turn ON the SMTP sender (dedicated **SMTP** page in the left menu, InsForge SMTP now, custom later) → reporter signs up → verifies → in.
  - **B. Closed hosting:** leave signups off + create the reporter's user in the dashboard (admin user creation) → they sign in directly, pre-verified.
- Note: with (A), spam signups become possible — the app's OTP + Turnstile gates (`008`, `012`) then carry that weight; revisit if bot accounts appear.

## 2026-09-03 follow-up 3: user chose (A); existing account found
- CLI context note: `branch switch --parent` now errors (already on parent; `project.parent.json` absent) — `insforge current` confirms parent prod (`p4rcgqh8`). Staging reachable via `branch switch staging`.
- Prod `auth.users`: `anujpatel28104@gmail.com` exists with `email_verified: true` — this is almost certainly the reporter's "already there" ID: it can sign in TODAY with no email step. (The reported `anuj2812004@gmail.com` remains absent — likely a typo of this address.)
- Two `host_<ts>@example.com` rows (unverified) are residue from old repo test scripts run against prod — harmless, expire nothing (user rows persist), noted for hygiene.
- Still pending for full (A): `disableSignup: true` → OFF and SMTP → ON (both still as before). Until then, no NEW accounts — but the existing verified ID unblocks room-creation testing immediately.

## 2026-09-03 follow-up 4: live room test PASSED (prod)
User created room `Z68WRK` ("JAM3", private) from the verified account and shared the link. Service-side check: room active, `is_private: true`, `host_id` = reporter's account, member row `TEST`/`host` present with fresh heartbeat, `expires_at` = +24h. Full chain works on prod: signin → create → join → heartbeat → expiry set. Reminder: prod still runs pre-hardening backend (host-steal rule, 3-char passwords, old RPCs) — migrations `033–038` remain staging-only until the prod window.
