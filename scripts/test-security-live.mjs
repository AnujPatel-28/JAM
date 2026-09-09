/**
 * Live security matrix v2 — RUN AGAINST STAGING ONLY.
 * Env: VITE_INSFORGE_URL + VITE_INSFORGE_ANON_KEY (fail-fast, no fallbacks).
 * NOTE (docs/014): this project's single API key is SERVICE-level (it reads
 * room_secrets despite REVOKE ALL), so SELECT-based C2 checks CANNOT be proven
 * behaviorally with it — those are verified at policy-definition level via CLI
 * (`db policies` exact-match). Everything below exercises RPC LOGIC, which
 * treats key-only callers as anon (auth.uid() NULL) and is therefore valid.
 * Fixture: service-seeded room SECT01. Fixture removed service-side after run.
 */
import { createClient } from '@insforge/sdk';

const url = process.env.VITE_INSFORGE_URL;
const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
if (!url || !anonKey) throw new Error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY');
if (!url.includes('-xwm')) throw new Error(`Refusing: target does not look like the staging branch (${url})`);

const CODE = 'SECT01';
const ROOM_ID = '5a7df03e-0a0d-41ec-8684-3fede250e2cf';
const GOOD_PWD = 'fixture-pass-42';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const rpcData = (res) => res?.data ?? res ?? null;

const anon = createClient({ baseUrl: url, anonKey });

// --- join with correct password (anon) issues a member token ---
const MY_SESSION = 'dddddddd-dddd-4ddd-dddd-ddddddddddd4';
const good = rpcData(await anon.database.rpc('join_room_secure', {
  p_code: CODE, p_session_id: MY_SESSION, p_display_name: 'RedTeam', p_password: GOOD_PWD,
}));
const myToken = good?.member_token || null;
check('C3: correct-password join succeeds + returns member_token', good?.success === true && typeof myToken === 'string' && myToken.length >= 32, JSON.stringify(good).slice(0, 160));

// --- C3: forged kick must not remove the joiner (immediate, no stale gap) ---
await anon.database.rpc('ping_room_presence', { p_room_id: ROOM_ID, p_session_id: MY_SESSION, p_member_token: myToken });
await anon.database.rpc('leave_room', { p_room_id: ROOM_ID, p_session_id: MY_SESSION, p_member_token: 'wrong-token' });
const members = rpcData(await anon.database.rpc('get_active_room_members', { p_room_id: ROOM_ID }));
const rows = Array.isArray(members) ? members : [];
check('C3: forged kick leaves victim present', rows.some((r) => r.session_id === MY_SESSION), JSON.stringify(rows).slice(0, 200));
// ...and the real token still works (heartbeat accepted → still listed)
await anon.database.rpc('ping_room_presence', { p_room_id: ROOM_ID, p_session_id: MY_SESSION, p_member_token: myToken });
const members2 = rpcData(await anon.database.rpc('get_active_room_members', { p_room_id: ROOM_ID }));
check('C3: valid token heartbeat keeps presence', (Array.isArray(members2) ? members2 : []).some((r) => r.session_id === MY_SESSION));

// --- H3: wrong password rejected + throttled ---
const t0 = Date.now();
const b1 = rpcData(await anon.database.rpc('join_room_secure', { p_code: CODE, p_session_id: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeee5', p_display_name: 'X', p_password: 'nope-nope-nope' }));
const b2 = rpcData(await anon.database.rpc('join_room_secure', { p_code: CODE, p_session_id: 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeee5', p_display_name: 'X', p_password: 'nope-nope-nope' }));
const elapsed = Date.now() - t0;
check('H3: wrong password rejected', b1?.success === false && b2?.success === false, JSON.stringify(b1).slice(0, 120));
check('H3: 2 bad joins take >=2s (pg_sleep throttle)', elapsed >= 2000, `${elapsed}ms`);

// --- Phase B: private queue requires presence proof (overloads dropped → no PGRST203) ---
const noProof = rpcData(await anon.database.rpc('request_song', {
  p_room_id: ROOM_ID, p_video_id: 'dQw4w9WgXcQ', p_title: 'Nope', p_artist: 'Nope',
  p_album_art: '', p_session_id: 'ffffffff-ffff-4fff-ffff-fffffffffff6', p_display_name: 'Intruder',
}));
check('B: private request without token denied', noProof?.success === false, JSON.stringify(noProof).slice(0, 160));
const withProof = rpcData(await anon.database.rpc('request_song', {
  p_room_id: ROOM_ID, p_video_id: 'dQw4w9WgXcQ', p_title: 'Proof', p_artist: 'RedTeam',
  p_album_art: '', p_session_id: MY_SESSION, p_display_name: 'RedTeam', p_member_token: myToken,
}));
const myQueueId = withProof?.queue_id || null;
check('B: private request with token accepted', withProof?.success === true && !!myQueueId, JSON.stringify(withProof).slice(0, 160));
if (myQueueId) {
  const badVote = rpcData(await anon.database.rpc('toggle_upvote_song', { p_queue_id: myQueueId, p_session_id: 'ffffffff-ffff-4fff-ffff-fffffffffff6' }));
  check('B: private vote without token denied', badVote?.success === false, JSON.stringify(badVote).slice(0, 160));
  const goodVote = rpcData(await anon.database.rpc('toggle_upvote_song', { p_queue_id: myQueueId, p_session_id: MY_SESSION, p_member_token: myToken }));
  check('B: private vote with token accepted', goodVote?.success === true, JSON.stringify(goodVote).slice(0, 160));
}

// --- H3 queue-status whitelist ---
const evil = rpcData(await anon.database.rpc('update_queue_status', { p_queue_id: myQueueId || '00000000-0000-0000-0000-000000000000', p_status: 'hacked' }));
check('H3: bogus queue status rejected', evil?.success === false, JSON.stringify(evil).slice(0, 120));

// --- H5 enumeration ---
const e1 = await anon.auth.signInWithPassword({ email: 'no_such_user_xyz@example.com', password: 'Whatever123!' });
const e2 = await anon.auth.signInWithPassword({ email: 'host@example.com', password: 'DefinitelyWrong123!' });
check('H5: backend signin errors identical', (e1.error?.message || '') === (e2.error?.message || '') && !!(e1.error?.message), `'${e1.error?.message}' vs '${e2.error?.message}'`);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
