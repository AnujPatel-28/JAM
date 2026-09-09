# 018 — Password Visibility + Verification surfacing (auth UX)

## Problem
User report with screenshot: sign-in fails with generic `Invalid email or password`, no way to see typed text (typo blindness), and signup gave no "check your inbox" signal even though the backend enforces email OTP (`verifyEmailMethod: code`, `requireEmailVerification`, confirmed in `insforge metadata`).

## Decision
- **Eye toggle** (`Eye`/`EyeOff`, lucide) on all three password fields: `AuthModal` (signin+signup), `PasswordPromptModal` (room join), `CreateRoomModal` (room create). Absolute-positioned button inside a relative wrapper, `aria-label`, state resets on unmount. No CSS file changes (inline styles match modal theme vars).
- **Signup notice:** on successful signup, show `Account created! We sent a 6-digit verification code to {email}…` — previously the modal flipped to OTP mode silently. Signin-unverified path already showed its notice; OTP resend + 5-guess gate from `008` unchanged.
- **Not changed:** error text stays generic by design (`008` anti-enumeration). Backend SMTP state unknown — if codes never arrive, check InsForge dashboard email/SMTP settings (staging showed `smtpConfig.enabled: false`).

## Why
Typo'd passwords are the #1 "can't sign in" cause and invisible without a toggle. Verification existed but was undiscoverable — a missing notice, not a missing feature. Both fixes are client-only, zero backend impact.

## What changed
- `src/components/AuthModal.tsx`, `PasswordPromptModal.tsx`, `CreateRoomModal.tsx`

## Verify
- Static: `Eye`/`EyeOff` imports + `showPassword` in all three modals; signup notice string present
- `npm run lint`, `npm run build`; manual: toggle flips `type`, signup shows inbox notice, OTP flow unchanged

## Rollback
Remove the toggle buttons (inputs default back to `type="password"`); drop the notice line.
