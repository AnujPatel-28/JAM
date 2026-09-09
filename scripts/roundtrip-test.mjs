import { io } from 'socket.io-client';

const URL = process.env.VITE_INSFORGE_URL;
const ANON = process.env.VITE_INSFORGE_ANON_KEY;

const socket = io(URL, { transports: ['websocket'], reconnection: false, auth: { apiKey: ANON } });

const fail = (msg) => { console.log('FAIL:', msg); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

socket.on('connect_error', (e) => fail('connect_error: ' + e.message));

socket.on('connect', async () => {
  console.log('1. connected:', socket.id);

  const sub = await new Promise((resolve) => {
    socket.emit('realtime:subscribe', { channel: 'player_sync' }, (r) => resolve(r));
    setTimeout(() => resolve({ ok: false, error: 'subscribe timeout' }), 8000);
  });
  console.log('2. subscribe player_sync:', JSON.stringify(sub));
  if (!sub.ok) fail('subscription rejected');

  socket.onAny((event, message) => {
    if (event === 'realtime:error') return;
    if (event === 'sync') {
      console.log('4. RECEIVED sync event:', JSON.stringify(message).slice(0, 200));
      console.log('SUCCESS — full round trip works');
      process.exit(0);
    }
  });

  socket.emit('realtime:publish', { channel: 'player_sync', event: 'sync', payload: { hello: 'world', t: Date.now() } });
  console.log('3. published');
});
