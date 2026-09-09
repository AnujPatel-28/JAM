import { io } from 'socket.io-client';

// Diagnostic: which realtime auth forms the gateway accepts.
// 020 finding (verified live): ONLY `auth.token` (JWT or anon_ key) connects.
// `auth.apiKey` is rejected ("Invalid API key") — the app must never send it.

const URL = process.env.VITE_INSFORGE_URL;
const ANON = process.env.VITE_INSFORGE_ANON_KEY;
if (!URL || !ANON) throw new Error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY (no hardcoded fallback — see docs/security-fixes/005-H1-secrets.md)');

const variants = [
  { name: 'auth.token = anon', opts: { auth: { token: ANON } } },
  { name: 'auth.apiKey = anon', opts: { auth: { apiKey: ANON } } },
  { name: 'no auth', opts: {} },
  { name: 'query token', opts: { auth: (cb) => cb({}) , query: { token: ANON } } },
];

for (const v of variants) {
  const result = await new Promise((resolve) => {
    const socket = io(URL, { transports: ['websocket'], reconnection: false, timeout: 8000, ...v.opts });
    const done = (r) => { try { socket.disconnect(); } catch {} resolve(r); };
    socket.on('connect', () => done('CONNECTED sid=' + socket.id));
    socket.on('connect_error', (e) => done('ERROR: ' + e.message));
    setTimeout(() => done('TIMEOUT'), 9000);
  });
  console.log(`${v.name.padEnd(22)} -> ${result}`);
}
process.exit(0);
