# 023 — Rename: "Wifi Jokey" → "JAM" (2026-09-05)

## WHY
User decision: shorter, clearer brand. "JAM — Listen Together" lockup
("JAM" alone is generic and collides visually with JAM-style room codes).

## WHAT changed (user-visible)
- `src/pages/LobbyPage.tsx` — logo pill + footer brand → `JAM`.
- `index.html` — `<title>` → `JAM — Listen Together in Real-Time`;
  meta description → `JAM — listen together in real-time…`.
- `README.md`, `ARCHITECTURE.md` headers → JAM (with "formerly" note).

## Deliberately NOT changed
- Folder `wifi-jokey/`, `package.json` name, `.insforge` link, InsForge
  project name — invisible to users; renaming breaks CLI binding + doc paths.
- Room codes, DB values, URLs, keys — none referenced the brand.
- Dated audit logs (`SECURITY-AUDIT.md`, `000–022`) keep the old name —
  they are historical records; rewriting them falsifies the trail.
- Favicon/radio icon — still on-brand, no asset work.

## Owner dashboard actions (user)
- Resend email sender name → `JAM` (was `Wifi Jokey <onboarding@resend.dev>`).
- Optional: InsForge project display name (cosmetic only).

## Verify
- `grep (?i)jokey|wifi jokey` over `src/`, `public/`, `index.html` → zero hits.
- Docs sweep + full build green (see 022 log).
