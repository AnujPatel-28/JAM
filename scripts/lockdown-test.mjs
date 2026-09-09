import { io } from 'socket.io-client';

const URL = process.env.VITE_INSFORGE_URL;
const ANON = process.env.VITE_INSFORGE_ANON_KEY;

const socket = io(URL, { transports: ['websocket'], reconnection: false, auth: { apiKey: ANON } });

const fail = (msg) => { console.log('FAIL:', msg); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

const subscribe = (channel) => new Promise((resolve) => {
  socket.emit('realtime:subscribe', { channel }, (r) => resolve(r));
});

const publish = (channel, event, payload) => new Promise((resolve) => {
  let acked = false;
  socket.timeout(5000).emit('realtime:publish', { channel, event, payload }, (err) => {
    acked = true;
    resolve(err ? { ok: false, err: String(err?.message || err) } : { ok: true });
  });
  setTimeout(() => { if (!acked) resolve({ ok: null, note: 'no-ack (may be fire-and-forget)' }); }, 5500);
});

socket.on('connect', async () => {
  console.log('connected as ANONYMOUS:', socket.id);

  const subSync = await subscribe('player_sync');
  console.log('1. anon subscribe player_sync:', JSON.stringify(subSync));

  const subChat = await subscribe('chat_messages');
  console.log('2. anon subscribe chat_messages:', JSON.stringify(subChat));

  const pubSync = await publish('player_sync', 'sync', { forged: true });
  console.log('3. anon publish player_sync:', JSON.stringify(pubSync));

  let chatEcho = false;
  socket.onAny((event) => { if (event === 'message') chatEcho = true; });

  // Publish a uniquely-identifiable chat message, then watch for our own echo
  // (delivery proves the insert passed RLS).
  const marker = 'rls-test-' + Date.now();
  await publish('chat_messages', 'message', { id: marker, user_name: 'RLSProbe', message: marker });

  socket.onAny((event, message) => {
    if (event === 'message' && message && JSON.stringify(message).includes(marker)) {
      console.log('4. anon publish chat_messages: DELIVERED ✓ (insert passed policy)');
      console.log('DONE');
      process.exit(0);
    }
  });

  setTimeout(() => {
    console.log('4. anon publish chat_messages:', chatEcho ? 'acked' : 'NO ECHO — possibly rejected');
    process.exit(0);
  }, 6000);
});

socket.on('connect_error', (e) => fail('connect_error: ' + e.message));
