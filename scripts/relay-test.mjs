import { io } from 'socket.io-client';

const URL = process.env.VITE_INSFORGE_URL;
const ANON = process.env.VITE_INSFORGE_ANON_KEY;
// Service key for the write path under test — never the anon key, never hardcoded.
const ADMIN = process.env.INSFORGE_SERVICE_KEY;
const ROOM_ID = process.env.TEST_ROOM_ID;
if (!URL || !ANON || !ADMIN || !ROOM_ID) throw new Error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY / INSFORGE_SERVICE_KEY / TEST_ROOM_ID (no hardcoded fallback — see docs/security-fixes/005-H1-secrets.md)');

// Listener
const s = io(URL, { transports: ['polling', 'websocket'], reconnection: false, auth: { apiKey: ANON } });
s.on('connect_error', (e) => { console.log('connect_error:', e.message); process.exit(1); });

s.on('connect', async () => {
  const sub = await new Promise((res) => s.emit('realtime:subscribe', { channel: 'player_sync' }, (r) => res(r)));
  console.log('subscribed:', sub.ok);

  s.onAny((event, msg) => {
    if (['realtime:error', 'presence:join', 'presence:leave'].includes(event)) return;
    console.log(`RECEIVED [${event}]:`, JSON.stringify(msg).slice(0, 200));
    console.log('SUCCESS: trigger relay works');
    process.exit(0);
  });

  // Host-side simulation: DB update (what the app now does)
  await new Promise((r) => setTimeout(r, 1000));
  const res = await fetch(`${URL}/api/database/records/rooms?id=eq.${ROOM_ID}`, {
    method: 'PATCH',
    headers: { 'x-api-key': ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      playback_state: { track: { id: 'dx4Teh-nv3A', title: 'Trigger Test' }, isPlaying: true, currentTime: 42.5 },
    }),
  });
  console.log('PATCH status:', res.status);
});

setTimeout(() => { console.log('TIMEOUT: no sync event received'); process.exit(1); }, 15000);
