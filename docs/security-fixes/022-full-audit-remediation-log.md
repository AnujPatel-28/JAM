# Session Log — Full Audit Remediation (2026-09-04/05)

> **Rule for this session (user-mandated):** every change gets WHY (problem) /
> WHAT (fix) / RESULT (verification), so other agents/sessions have full context.
> Scope approved: **Everything** (Critical + High + Medium/Low).
> DB strategy: **prepare ordered SQL files** — user applies in InsForge dashboard.
> Turnstile strictness: **fail open with loud warning when unconfigured**
> (user asked "WHAT IS turnstile??" — it's Cloudflare's free CAPTCHA replacement;
> decision: enforce token when configured, warn when not, never lock out dev).

## Conventions
- SQL files: `migrations/20260903900000_*.sql` … numbered after `038`.
- Code refs: `path:line` at time of writing.
- Live DB state at session start: room `Z68WRK` exists + private (verified via
  anon `join_room_secure` probe → `Incorrect password for this private room.`).
- Prior session fixed: RoomPage password flow, PasswordPromptModal stuck state,
  `public/_redirects` SPA fallback.

---

## Phase 0 — Live-state checks + behavioral re-probe
### WHY: prior hardening files (033→038) were marked "not applied / staging only".
Must confirm what prod actually enforces before writing fixes.
### WHAT: anon RPC probes (safe: fake room UUIDs; only real-room call was a
failed password attempt, which writes nothing).
### RESULT (2026-09-05, evidence):
- `join_room_secure` bad-code → `Room not found or inactive.` (2038ms);
  bad-password on Z68WRK → `Incorrect password…` (1588ms).
  **~1s+ timings ⇒ pg_sleep throttle live ⇒ 034 IS applied.** Error oracle
  (distinct strings) confirmed live — accepted risk, fixed in 043.
- `update_queue_status(fake,'hacked')` → `Invalid queue status.` ⇒ **033 live**.
- `request_song` bad video id → `Invalid YouTube Video ID format.` (fires
  before room-validity) ⇒ **036 live**.
- `ping_room_presence` with **2 args → 204 AND 3 args → 204** ⇒ at the time,
  read as legacy overloads callable (later corrected: InsForge routes by
  provided params; 038 WAS applied per migration list — see APPLY LOG).
- `purge_expired_rooms` anon → `200 body 0` ⇒ **anon EXECUTE confirmed**;
  grants fix required (041).
- `get_active_room_members(fake)` → `[]` (inconclusive alone; SQL text shows
  no auth check ⇒ fixed in 041 regardless).

## Phase 1 — SQL migrations 039→044 (APPLIED staging+prod by agent 2026-09-05,
see APPLY LOG; headers saying "USER APPLIES" are stale but kept verbatim)
### WHY: close chat-spam, realtime-spoof, members-enumeration, PUBLIC execute,
###   Turnstile bypass, join-expiry/oracle gaps found in audit.
### WHAT (files in migrations/, each with header WHY/WHAT/ROLLBACK/VERIFY):
- `20260903900000_secure-chat-rpc.sql` — post_chat RPC (room+expiry check,
  private token/host gate, 500/50 caps, control-char strip, reserved-name
  fold, 10/min throttle, server-side realtime fan-out with client_id);
  REVOKEs direct chat INSERT; reserved-name triggers on all 3 name tables.
- `20260904000000_realtime-publish-lockdown.sql` — chat publish:
  authenticated member/host only; sync regex strict lowercase UUID; explicit
  queue publish policy. NO subscribe policy (would break anon listeners —
  documented accepted residual: UUID unguessability).
- `20260904100000_least-privilege-grants.sql` — re-drops legacy overloads
  (038 never applied live); members-list RPC gated for private rooms (new
  overload, old dropped); REVOKE PUBLIC + least-privilege GRANTs; purge
  authenticated-only + 60s throttle; member_token column revoked from API;
  RLS on room_secrets; drops superseded trigger fn.
- `20260904200000_turnstile-ticket-create.sql` — turnstile_tickets table;
  create_room REQUIRES fresh single-use action-bound ticket (edge mints;
  dev-mode mints with warning when secret unset); code-collision retry.
- `20260904300000_join-expiry-generic-errors.sql` — server-side expiry gate;
  not-found/bad-password collapse to 'Invalid code or password.';
  pg_sleep removed (bcrypt-12 ~250ms remains the per-guess throttle).
### RESULT: files written, signatures verified against 033/036 (no overload
###   ambiguity except where explicitly dropped). NOT yet applied — pending user.
###   Frontend note: 'Invalid code or password.' still contains 'password', so
###   RoomPage's includes('password') branch keeps working (mistyped codes now
###   land on the password prompt — accepted anti-enumeration trade-off).

## Phase 2 — Code fixes (all in working tree; tsc + oxlint + build GREEN)
### WHY/WHAT (file: change → reason):
- `hooks/useChatMessages.ts` — sendMessage now calls post_chat RPC with
  session+token+client_id; server fans out realtime. WHY: direct table INSERT
  is revoked by 039; client_id echo reconciles (not duplicates) optimistic msgs;
  temp ids are crypto.randomUUID (were predictable temp-Date.now).
- `hooks/useAuth.ts` + `lib/session.ts` — signOut now rotates session id
  (clears token+password Maps, mints fresh CSPRNG id) then drops JWT from
  socket. WHY: stale presence/secrets/socket survived sign-out. Session
  Math.random fallback replaced with getRandomValues UUIDv4. Signup
  'already exists' → generic inbox message (enumeration closed).
- `lib/displayName.ts` — new safeStoredDisplayName() choke point; RoomPage
  chat-send + both requestSong call sites use it (queue path was raw).
  WHY: reserved names leaked via requestSong + recent chips.
- `hooks/useYouTubeMusic.ts` — seq window (±10min/24h, else drop + DB
  reconcile) kills far-future-seq pinning DoS; currentTime/serverTime/
  title/artist clamps before the player. WHY: forged sync acceptance.
- `hooks/useRoomQueue.ts` — select('*') → explicit columns; album_art
  coerced client-side to img.youtube/i.ytimg (server re-coerces per 044).
- `lib/turnstile.ts` — verifyTurnstileTicket() returns single-use { ticket };
  old boolean helper kept (deprecated) for RequestSongModal UX gate.
- `components/CreateRoomModal.tsx` — passes p_turnstile_ticket to
  create_room_secure (042 consumes it). Null when widget disabled (RPC rejects
  null in prod; dev edge mints with warning).
- `functions/verify-turnstile.ts` — mints tickets; 10/min/IP limit; generic
  failure when secret unset + UNVERIFIED dev mint (loud console.error);
  remoteip sent; hostname asserted ∈ APP_ORIGIN; no-store everywhere;
  10s siteverify timeout; error-codes logged server-side only.
- `functions/cleanup-chat.ts` — accepts INSFORGE_SERVICE_KEY (fallback
  ADMIN_API_KEY), asserts ik_ prefix, fails closed otherwise. WHY: field name
  anonKey holding a service key invited misconfiguration.
- `components/YouTubePlayer.tsx` — MutationObserver hardens the YT iframe
  (minimal allow + strict-origin referrer). sandbox intentionally NOT used
  (breaks playback).
- `components/PasswordPromptModal.tsx` — autoComplete=current-password.
- `.env.example` — documents INSFORGE_SERVICE_KEY.
### RESULT: `npx tsc -b` clean, `oxlint src functions` 0/0, `npm run build`
###   success (only pre-existing SDK crypto-externalized warning).

## Phase 3 — Medium/low batch (done where safe; rest documented)
### WHAT:
- RoomPage: pagehide leave beacon (best-effort; raw sendBeacon can't carry
  SDK auth shape — 45s timeout stays the backstop) + ghost-window copy in
  full-room screen; mapJoinError + Try-Again on Unable-to-Join; route-code
  charset gate; fixed false 'password survives refresh' comment; chat error
  surfaces a Retry chip (was swallowed).
- LobbyPage: recents validated on load (shape + 24h expiry, rooms are
  ephemeral); recent chips enforce the same name rules as the join form.
- New SQL `20260904400000_queue-art-allowlist.sql` — album_art coerced
  server-side to deterministic thumbnail; requested_by_name folded.
- Accepted residuals (no change, rationale): realtime SUBSCRIBE policy
  (would break anon listeners — UUID unguessability is the control);
  per-message Turnstile tickets (UX cost > gain given caps; create-room
  enforced); tsconfig for functions/ (Deno runtime — node tsc can't check;
  deploy pipeline owns it); OPTIONS liveness (required for CORS).

## DEPLOY ORDER (important — SQL first, then frontend+functions)
1. Apply migrations 039→044 in InsForge dashboard, in numeric order.
2. Set edge env INSFORGE_SERVICE_KEY (= service ik_ key) alongside
   ADMIN_API_KEY; ensure TURNSTILE_SECRET_KEY + APP_ORIGIN set in prod.
3. Deploy frontend (dist/) + edge functions together (chat/create flows
   change contract: old clients break against new SQL and vice versa).
4. Re-run behavioural probes (Phase 0 script + post_chat/turnstile paths).

## APPLY LOG (agent-executed, user-authorized)
### Staging (p4rcgqh8-xwm) — DONE 2026-09-05
- Backup N/A (staging). `up --all` hit 2 errors, both fixed in-tree:
  1. `cannot change return type` — purge was INT, 041 declared VOID → kept INT.
  2. `cannot drop protect_chat_display_name` — real trigger name is
     `chat_messages_protect_display_name` (039 used a wrong name); correct
     DROP added to 039 + 041 (039 had already applied, so 041 carries it).
- Applied: 039, 040, 041, 042, 043, 044 (4 in final run after fixes).
- pg_proc: exactly 1 overload each, correct signatures (verified via query).
- Anon probes: join bad-code → generic error; post_chat reachable+gated;
  direct chat INSERT → 42501; purge → 42501; members → [].
- Functions deployed (verify-turnstile, cleanup-chat). verify invoke revealed
  **stale ADMIN_API_KEY** (pre-rotation ik_, ≠ current API_KEY) → edge→DB
  'Invalid API key'. Fixed by refreshing ADMIN_API_KEY from API_KEY (values
  never displayed/stored). Re-invoke → {ok:true, ticket, dev:true}; ticket
  row confirmed in turnstile_tickets. NOTE: cleanup-chat's delete path was
  equally broken since rotation — now healed too.
### Prod — DONE 2026-09-05
- Context: Wi-fi Jockey / p4rcgqh8 (parent). Pre-backup:
  `prod-pre022-schema.sql` (OS temp, schema+functions, no data).
- ADMIN_API_KEY was ALSO stale on prod → refreshed from API_KEY (same
  no-display procedure). verify-turnstile was NEW on prod (creation success).
- Applied all 6 migrations clean (041/039 fixes from staging carried over).
- Deployed verify-turnstile + cleanup-chat to prod.
- Anon probes prod: bad-code + real-room-no-pwd → generic
  'Invalid code or password.' (fast, ~430ms — sleep gone); post_chat gated;
  direct chat INSERT → 42501; purge → 42501; update_queue_status anon → 42501
  (hosts are authed — unaffected); evil-art request → room-gated as expected.
- Prod verify invoke → {ok:true, ticket, dev:true} (no TURNSTILE_SECRET_KEY
  anywhere — dev-mint active; see user action below).
- pg_proc: 1 overload per RPC. Static suite 59/59. tsc/oxlint/build green.
- Behavior note: anon lobby purge calls now 42501 (client try/catches);
  expiry cleanup runs on authed visits + any service-key cron. If rooms seem
  to linger past 24h for pure-anon traffic, add a cron with the service key.

## FINAL VERIFICATION (2026-09-05, this session)
- `npx tsc -b` → clean. `npx oxlint src functions scripts` → 0 warnings, 0 errors.
- `npm run build` → success (dist/ refreshed; _redirects + _headers present).
- `node scripts/test-security-hardening.mjs` → **59 passed, 0 failed**
  (updated 1 stale assertion for ticket flow; added 13 checks for 039→044).
- Post-apply re-probes: see APPLY LOG above (all green on staging + prod).

## INCIDENT + FIX: CLI prod auth died mid-apply (2026-09-05)
- WHY: prod CLI calls began returning 'Invalid API key' right after the prod
  apply. Root cause: `.insforge/project.json` holds a project `ik_` key; the
  pre-rotation key was deactivated server-side at that moment (rotation
  completing — Reserved API_KEY was refreshed 05-09 01:07). Staging kept
  working (separate key, still alive).
- WHAT: `insforge -y link --project-id <prod> --org-id <org>` to relink
  (login session was fine — only the stored project key was dead). Verified
  with `db query SELECT 1`. NOTE: `branch switch --parent` rewrites
  `.insforge/` to a single project.json — that file is CLI-managed, do not
  hand-edit it.
- LESSON (future agents): after ANY key rotation, relink the CLI before prod
  work. Never paste key values anywhere (all comparisons done boolean-only).
- Metadata (post-recovery): Email Verification ON (code method); OAuth
  github+google present (not wired in app UI — email codes are the only
  signup path); rooms=2, secrets=2, members=3, tickets=1 (test row —
  harmless, expires logically via 10-min check). disableSignup/SMTP flags are
  NOT in current metadata output → dashboard confirmation still needed (019).

## A-slim UI decision (2026-09-05, user-approved scope cut)
- WHY: user challenged A+B+C as overbuilding pre-users. Agreed: multi-room
  already works live; the signup blocker is dashboard toggles (019), not code.
  Onboarding path chosen: email codes (no OAuth exists in the app UI).
- WHAT: deferred B (DJ handoff + migration 045) and C (host tools) until real
  usage. Built A-slim only, frontend-only, no migration: Listener pill
  (RoomHeader), guest DJ hint bar (RoomPage player), own-request highlight +
  n/3 counter + guest empty-copy (SongQueuePanel/useRoomQueue), you-badge.

## Sign-in triage (2026-09-05, user screenshot)
- User turned "Disable New User Signups" ON (backwards — ON blocks all new
  registrations; needs OFF for public onboarding).
- Screenshot account `anujpatel30106@gmail.com`: EXISTS in prod auth.users,
  email_verified=true since 2026-08-21 → 'Invalid email or password' means
  wrong password only, not a signup/verification problem.
- SMTP/disableSignup flags not visible via CLI metadata → dashboard
  confirmation still pending (019). Password reset codes need SMTP ON.

## Sign-in 401 triage, round 2 (2026-09-05)
- Toggle is OFF now (correct) but same 401. Network tab: POST
  /api/auth/sessions → 401. auth.users has NO lockout/status columns, so 401
  = password mismatch, period (account exists + verified).
- Shipped email normalization in useAuth (trim+lowercase on signIn/signUp/
  verify/resend; passwords NEVER trimmed) — kills the mobile-autofill-space
  class of 401s. Verified: tsc/oxlint clean, suite 62/62. Needs frontend
  redeploy to reach users.
- If it still fails after redeploy: read the 401's Response/Preview tab for
  the exact server message; else dashboard admin password reset for the
  account (SMTP must be ON for self-service reset codes).

## Reset-password mechanism + reachable signup (2026-09-05, user request)
- WHY: (1) no self-service reset existed — a forgotten password was a dead
  account without admin help; (2) signup mode was unreachable — AuthModal had
  no mode switcher and LobbyPage only opened 'signin', so newcomers hit a
  dead end (user: "tried to make a new user, it's not making").
- WHAT (frontend-only, no migration):
  - useAuth: requestPasswordReset (generic reply, no enumeration) +
    confirmPasswordReset ({otp, newPassword} → signed in + socket refresh).
  - AuthModal: forgot-email → forgot-reset states with 5-guess gate + resend
    (target follows the active OTP flow); mode-switch links both ways; new
    .auth-link-btn style.
  - LobbyPage: logged-out Create opens signup mode + auto-opens Create Room
    after first auth (createAfterAuthRef, cleared on modal close).
- RESULT: tsc/oxlint clean, build success, suite 65/65.
  Live staging: send-reset-password for nonexistent address → generic
  {success:true} (no enumeration). Full code→new-password loop needs a real
  inbox → user acceptance on prod after deploy (their own account).

## Turnstile Spin integration (2026-09-05, existing widget 0x4AAAA…mM3B9)
- WHY: widget existed in Cloudflare but only the secret-less dev path ran;
  Spin canonical rules (per-surface action, single-use widget lifecycle in
  SPA, secret never in chat/repo) were not fully met.
- WHAT (frontend + edge, no migration):
  - TurnstileWidget: `action` prop → render opts; `resetSignal` → widget
    reset after each submit (tokens are single-use; SPA stays mounted).
  - CreateRoomModal action="create_room" (+reset), RequestSongModal
    action="request_song" (+reset); boolean helper defaults to request_song.
  - Edge: token length guard (1–2048), `out.action === requested action`
    assertion, hostname check kept; request_song allowed.
  - `.env`: VITE_TURNSTILE_SITE_KEY set (gitignored). NOTE: without a site
    key, create_room_secure rejects (042 ticket rule) — room creation was
    effectively gated until this key landed.
- RESULT: tsc/oxlint clean, build success, suite 68/68. Edge deployed
  staging+prod. Staging probes: empty/oversize → 400; dummy → dev ticket.
  Real-token + replay validation PENDING secret + solved widget (user).
- SECRET (user action, never in chat): add TURNSTILE_SECRET_KEY via InsForge
  dashboard → project → secrets (or CLI `secrets add`), then redeploy is NOT
  needed (env read at runtime) — verify with a real room creation.
- VERIFIED 2026-09-06: secret present staging+prod (names-only check).  Dummy-token probe: dev-mint GONE, real siteverify path active; server log
  shows `invalid-input-response` with NO `invalid-input-secret` — per Spin's
  table this proves the secret is live and valid. Real-token + replay pass
  left to user (needs solved widget).
- Pages env (user): VITE_TURNSTILE_SITE_KEY=0x4AAAAAAEqERxq_Q_zmM3B9 in
  Production + Preview, then redeploy frontend.
- HYGIENE FLAG: local `.env` contains VITE_INSFORGE_API_KEY (master ik_ in a
  VITE_ var). Local-only + gitignored, but rotate/replace with anon key
  locally and confirm Pages env holds anon_ only.
- Site key CONFIRMED by user: 0x4AAAAAAEqERxq_Q_zmM3B9 (in local `.env`;
  code reads it via getTurnstileSiteKey). If user has two widgets, the pair
  rule applies: secret must belong to the same widget; domains must include
  wifi-jokey.pages.dev or the hostname check rejects.

## Rename to JAM (2026-09-05) — see 023-rename-to-jam.md
Lobby logo/footer + tab title/meta → "JAM — Listen Together" lockup.
Suite 66/66 (brand check included). Folder/package/project names untouched.

## Reset flow root cause + two-step rebuild (2026-09-05, user screenshot)
- WHY: reset-password kept 400ing ("Invalid or expired verification token").
  Root cause, proven by live probes + InsForge docs: the emailed 6-digit CODE
  is NOT the reset credential — `resetPassword({otp})` wants the TOKEN from
  `exchangeResetPasswordToken({email, code})`. My first build sent the code as
  otp (always 400). Side finding: user tested on `anuj2812004@gmail.com`,
  which did not exist then — but it EXISTS now (verified, created 10:57),
  i.e. signup works with the toggle OFF.
- WHAT: true one-by-one flow — forgot-email → forgot-verify (code → Verify
  code → token) → forgot-new (password only → set → back to sign in with
  "Password updated!" notice; server reply is message-only, no session).
  Resend allowed at verify step with "(old code stops working)" copy.
- Timings (InsForge docs, defaults): reset codes ~10 min; verify codes ~15
  min; 3 wrong guesses consumes a code; resend client-cooldown 60s (server
  may 429). Surfaced in-modal ("Codes expire after about 10 minutes").
- RESULT: tsc/oxlint clean, build success, suite 65/65.

## Mobile lobby crush fix (2026-09-06, user phone screenshot @412px)
- WHY: feature cards used repeat(3, 1fr) — grid tracks default minmax(auto)
  so items can't shrink below content → crushed/truncated labels.
- WHAT (CSS only, App.css): minmax(0,1fr) tracks + min-width:0 on cards +
  0.7rem anywhere-wrapping labels + tighter padding at ≤640px.
- RESULT: oxlint clean, build success, suite 68/68. Needs frontend redeploy;
  user to re-check on the phone.

## Full-page horizontal overflow fix (2026-09-06, user screenshot #2)
- WHY: entire lobby bled off the right edge (title, subtitle, form, hints
  all clipped) — a wide child stretched the page; no overflow guard existed
  anywhere (body, container, headers all unguarded).
- WHAT (CSS only): body + .lobby-container overflow-x:clip; hero title +
  badge max-width/wrap; fluid title at ≤640 (survives huge system text-size);
  hints/subtitles wrap; rooms header wraps.
- RESULT: oxlint clean, build success, suite 68/68. Needs redeploy; if still
  cut off, suspect the phone's Display/Text-size setting (Android magnifies
  rem layout page-wide) — reply with setting value.
