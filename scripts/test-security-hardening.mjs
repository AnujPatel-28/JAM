/**
 * Security-hardening static checks (no DB required).
 * Optional live checks run only if VITE_INSFORGE_URL + VITE_INSFORGE_ANON_KEY are set.
 * Usage: node scripts/test-security-hardening.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let pass = 0;
let fail = 0;
const check = (name, ok, hint = '') => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${hint ? ` — ${hint}` : ''}`); }
};

// 1. Realtime host lockdown present in new migration
const migPath = 'migrations/20260903300000_security-hardening.sql';
check('migration file exists', existsSync(join(root, migPath)));
const mig = existsSync(join(root, migPath)) ? read(migPath) : '';
check('C1 sync policy regex + host check', mig.includes("^room:[0-9a-fA-F-]{36}:sync$") && mig.includes('r.host_id = (SELECT auth.uid())'));
check('no USING(true) on scoped tables', !/CREATE POLICY "(select|rooms select|anyone can view)/.test(mig) || !mig.includes('USING (true)'));
check('status enum uses rejected', mig.includes(`IN ('queued', 'playing', 'played', 'rejected')`) && !/IN \([^)]*'dismissed'/.test(mig));
check('updated_at column added', mig.includes('ADD COLUMN IF NOT EXISTS updated_at'));
check('member_token column + RPC params', mig.includes('member_token') && mig.includes('p_member_token'));
check('search_path pinned', (mig.match(/SET search_path = public, pg_temp/g) || []).length >= 6);
check('uuid cast guarded (CASE)', mig.includes('CASE') && mig.includes("split_part(channel_name, ':', 2)"));
check('request_song video regex', mig.includes(`'^[a-zA-Z0-9_-]{11}$'`));

// 2. Frontend: no sessionStorage passwords, tokens in memory, channel-aware dispatch
const lobby = read('src/pages/LobbyPage.tsx');
const room = read('src/pages/RoomPage.tsx');
const rt = read('src/lib/realtime.ts');
const yt = read('src/hooks/useYouTubeMusic.ts');
check('no wj_pwd_ in src', !/wj_pwd_/.test(lobby + room + read('src/lib/session.ts')));
check('lobby public-only + explicit columns', lobby.includes(`.eq('is_private', false)`) && !lobby.includes(`.select('*')`));
check('member_token wired in RoomPage', room.includes('p_member_token') && room.includes('setMemberToken'));
check('onChannel exists + used', rt.includes('onChannel') && yt.includes('onChannel') && read('src/hooks/useChatMessages.ts').includes('onChannel'));
check('sync track id validated', yt.includes(`^[a-zA-Z0-9_-]{11}$`));

// 3. CSP baseline
check('CSP meta present', read('index.html').includes('Content-Security-Policy'));

// 4. H1: no hardcoded secrets in trackable scripts
for (const f of ['scripts/test-multiroom-rpc.mjs', 'scripts/test-phase3-queue.mjs', 'scripts/test-phase4-sync.mjs', 'scripts/handshake-test.mjs', 'scripts/relay-test.mjs']) {
  const src = read(f);
  check(`no live key in ${f}`, !/ik_[A-Za-z0-9]+/.test(src) && !/p4rcgqh8/.test(src));
}
check('env example documents test vars', read('.env.example').includes('INSFORGE_SERVICE_KEY'));
check('env example mandates anon key type', read('.env.example').includes('anon_') && read('.env.example').includes('NEVER put an ik_'));

// 5. H3/H4/H5/M checks
const pwdMig = existsSync(join(root, 'migrations/20260903400000_password-hardening.sql')) ? read('migrations/20260903400000_password-hardening.sql') : '';
check('bcrypt cost 12 + min 8', pwdMig.includes(`gen_salt('bf', 12)`) && pwdMig.includes('< 8'));
check('join failure delay', (pwdMig.match(/pg_sleep\(1\)/g) || []).length >= 2);
check('cleanup locked down', (() => { const s = read('functions/cleanup-chat.ts'); return !s.includes(`'*'`) && s.includes('constantTimeEqual') && s.includes(`req.method !== 'POST'`) && !s.includes('deleted: data'); })());
check('fail-closed sync publish', read('src/lib/realtime.ts').includes('publishSync') && read('src/hooks/useYouTubeMusic.ts').includes('publishSync'));
check('socket re-auth on auth change', (read('src/hooks/useAuth.ts').match(/refreshAuth/g) || []).length >= 4);
check('generic auth errors', read('src/hooks/useAuth.ts').includes('Invalid email or password'));
check('purge throttled', read('src/pages/LobbyPage.tsx').includes('60_000'));

// 6. Phase B: membership-token queue RPCs
const memMig = existsSync(join(root, 'migrations/20260903600000_membership-rpcs.sql')) ? read('migrations/20260903600000_membership-rpcs.sql') : '';
check('membership migration exists', memMig.length > 0);
check('queue RPCs take member token', memMig.includes('p_member_token') && memMig.includes('Join the room before requesting songs.') && memMig.includes('Join the room before voting.'));
check('private-gated, public-open', memMig.includes('IF v_room.is_private') || memMig.includes('v_room.is_private'));
check('hook passes token on request+vote', read('src/hooks/useRoomQueue.ts').includes('p_member_token'));

// 7. Phase C: Turnstile
check('turnstile widget + verify fn', existsSync(join(root, 'src/components/TurnstileWidget.tsx')) && existsSync(join(root, 'functions/verify-turnstile.ts')) && existsSync(join(root, 'src/lib/turnstile.ts')));
check('gates on create + request', read('src/components/CreateRoomModal.tsx').includes('verifyTurnstileTicket') && read('src/components/RequestSongModal.tsx').includes('verifyTurnstileToken'));
check('siteverify only server-side', read('functions/verify-turnstile.ts').includes('siteverify') && !read('src/lib/turnstile.ts').includes('siteverify') && !read('src/lib/turnstile.ts').includes('TURNSTILE_SECRET_KEY'));

// 8. Phase D: hygiene
check('hosting headers present', existsSync(join(root, 'public/_headers')) && read('public/_headers').includes('Content-Security-Policy'));
check('headers Cloudflare syntax + exact host', (() => { const h = read('public/_headers'); return /^\s*\/\*$/m.test(h) && !/^\s*\/\*:/m.test(h) && h.includes('wss://p4rcgqh8.ap-southeast.insforge.app'); })());
check('oembed debounced', read('src/components/RequestSongModal.tsx').includes('resolveSeq') && read('src/components/RequestSongModal.tsx').includes('400'));
check('legacy lockdown migration', existsSync(join(root, 'migrations/20260903700000_legacy-cleanup.sql')) && read('migrations/20260903700000_legacy-cleanup.sql').includes('REVOKE ALL ON public.song_requests'));
check('legacy overloads dropped', (() => { const f = 'migrations/20260903800000_drop-legacy-overloads.sql'; return existsSync(join(root, f)) && read(f).includes('DROP FUNCTION IF EXISTS public.leave_room(UUID, UUID)'); })());
check('reserved names blocked', (() => {
  const src = read('src/lib/displayName.ts');
  return src.includes('isReservedDisplayName') && read('src/pages/LobbyPage.tsx').includes('isReservedDisplayName');
})());
check('realtime uses token-form auth only', (() => { const s = read('src/lib/realtime.ts'); return !/apiKey:\s*this\.apiKey/.test(s) && s.includes('token: userToken ?? this.apiKey') && s.includes('this.authed'); })());
check('queue errors are user-friendly', (() => { const s = read('src/hooks/useRoomQueue.ts'); return s.includes('mapQueueError') && s.includes('Song service is updating'); })());
check('password eye toggles', ['src/components/AuthModal.tsx', 'src/components/PasswordPromptModal.tsx', 'src/components/CreateRoomModal.tsx'].every((f) => read(f).includes('showPassword') && read(f).includes('EyeOff')));
check('signup verification notice', read('src/components/AuthModal.tsx').includes('verification code to'));

// 9. Phase 022: full-audit remediation (docs/security-fixes/022-*)
const m039 = existsSync(join(root, 'migrations/20260903900000_secure-chat-rpc.sql')) ? read('migrations/20260903900000_secure-chat-rpc.sql') : '';
check('039 post_chat + insert revoked', m039.includes('CREATE OR REPLACE FUNCTION public.post_chat(') && m039.includes('REVOKE INSERT ON public.chat_messages FROM anon, authenticated'));
check('039 name triggers on 3 tables', m039.includes('trg_enforce_display_name_chat') && m039.includes('trg_enforce_display_name_members') && m039.includes('trg_enforce_display_name_queue'));
check('chat hook uses post_chat, no direct publish', (() => { const s = read('src/hooks/useChatMessages.ts'); return s.includes(`rpc('post_chat'`) && !s.includes(`.insert(`) && !s.includes('realtime.publish'); })());
const m040 = existsSync(join(root, 'migrations/20260904000000_realtime-publish-lockdown.sql')) ? read('migrations/20260904000000_realtime-publish-lockdown.sql') : '';
check('040 chat publish member-only', m040.includes('member can publish room chat') && m040.includes('FOR INSERT TO authenticated'));
const m041 = existsSync(join(root, 'migrations/20260904100000_least-privilege-grants.sql')) ? read('migrations/20260904100000_least-privilege-grants.sql') : '';
check('041 grants + members gate', m041.includes('REVOKE ALL ON FUNCTION public.purge_expired_rooms() FROM PUBLIC, anon, authenticated') && m041.includes('DROP FUNCTION IF EXISTS public.get_active_room_members(UUID)') && m041.includes('REVOKE SELECT (member_token)'));
const m042 = existsSync(join(root, 'migrations/20260904200000_turnstile-ticket-create.sql')) ? read('migrations/20260904200000_turnstile-ticket-create.sql') : '';
check('042 ticket table + create requires ticket', m042.includes('CREATE TABLE IF NOT EXISTS public.turnstile_tickets') && m042.includes('Human verification required.'));
check('042 single-use consume', m042.includes('DELETE FROM public.turnstile_tickets'));
const m043 = existsSync(join(root, 'migrations/20260904300000_join-expiry-generic-errors.sql')) ? read('migrations/20260904300000_join-expiry-generic-errors.sql') : '';
check('043 generic join errors + expiry, no sleep', m043.includes('Invalid code or password.') && m043.includes('expires_at <= now()') && !m043.includes('PERFORM pg_sleep'));
const m044 = existsSync(join(root, 'migrations/20260904400000_queue-art-allowlist.sql')) ? read('migrations/20260904400000_queue-art-allowlist.sql') : '';
check('044 art allowlist coercion', m044.includes('img\\.youtube\\.com|i\\.ytimg\\.com') && m044.includes('hqdefault.jpg'));
check('verify fn mints tickets + rate limited', (() => { const s = read('functions/verify-turnstile.ts'); return s.includes('mintTicket') && s.includes('rateLimited') && s.includes('remoteip') && s.includes('hostname'); })());
check('signout rotates session', read('src/hooks/useAuth.ts').includes('rotateSessionId'));
check('sync seq window', read('src/hooks/useYouTubeMusic.ts').includes('10 * 60 * 1000'));
check('join errors mapped + retry', read('src/pages/RoomPage.tsx').includes('mapJoinError'));

// 10. A-slim role clarity (frontend-only, no migration)
check('brand is JAM in user-visible surfaces', (() => {
  const lobby = read('src/pages/LobbyPage.tsx');
  const html = read('index.html');
  const noOld = !/(wifi jokey|wifijokey)/i.test(lobby + html);
  return noOld && lobby.includes('<span>JAM</span>') && html.includes('<title>JAM — Listen Together in Real-Time</title>');
})());check('listener pill + you badge', read('src/components/RoomHeader.tsx').includes('listener-mode-badge') && read('src/components/RoomHeader.tsx').includes('you-badge'));
check('guest DJ hint', read('src/pages/RoomPage.tsx').includes('guest-dj-hint'));
check('queue own + quota', (() => { const s = read('src/components/SongQueuePanel.tsx'); return s.includes('own-request') && s.includes('myQueuedCount') && read('src/hooks/useRoomQueue.ts').includes('myQueuedCount'); })());

// 11. Reset-password mechanism + reachable signupcheck('reset trio in useAuth', (() => { const s = read('src/hooks/useAuth.ts'); return s.includes('requestPasswordReset') && s.includes('confirmPasswordReset') && s.includes('sendResetPasswordEmail') && s.includes('resetPassword({'); })());
check('auth modal reset states + switch', (() => { const s = read('src/components/AuthModal.tsx'); return s.includes('forgot-verify') && s.includes('forgot-new') && s.includes('onVerifyReset') && s.includes('onSwitchMode') && s.includes('Forgot password?') && s.includes('New here? Create a host account'); })());
check('lobby signup entry + handoff', (() => { const s = read('src/pages/LobbyPage.tsx'); return s.includes(`setAuthModal('signup')`) && s.includes('createAfterAuthRef'); })());

// 12. Turnstile Spin: per-surface actions + single-use widget lifecycle
check('widget action + reset lifecycle', (() => { const s = read('src/components/TurnstileWidget.tsx'); return s.includes('action') && s.includes('resetSignal') && s.includes('.reset('); })());
check('surfaces pass actions', read('src/components/CreateRoomModal.tsx').includes('action="create_room"') && read('src/components/RequestSongModal.tsx').includes('action="request_song"'));
check('edge asserts action + token shape', (() => { const s = read('functions/verify-turnstile.ts'); return s.includes('out.action !== action') && s.includes('token.length > 2048'); })());

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
