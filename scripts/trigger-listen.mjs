import { io } from 'socket.io-client';

const URL = process.env.VITE_INSFORGE_URL;
const ANON = process.env.VITE_INSFORGE_ANON_KEY;

const s = io(URL, { transports: ['websocket'], reconnection: false, auth: { apiKey: ANON } });
s.on('connect_error', (e) => { console.log('connect_error:', e.message); process.exit(1); });

s.on('connect', async () => {
  s.emit('realtime:subscribe', { channel: 'player_sync' }, (r) => {
    console.log('subscribed:', JSON.stringify(r));
  });
});

s.onAny((event, msg) => {
  if (['realtime:error', 'presence:join', 'presence:leave'].includes(event)) return;
  console.log(`RECEIVED [${event}]:`, JSON.stringify(msg).slice(0, 220));
});

setTimeout(() => {
  console.log('(done listening)');
  process.exit(0);
}, 25000);
