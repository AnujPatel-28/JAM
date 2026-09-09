import { createClient } from '@insforge/sdk';

const url = process.env.VITE_INSFORGE_URL;
const key = process.env.VITE_INSFORGE_ANON_KEY;

const client = createClient({ baseUrl: url, anonKey: key });

console.log('1. connecting...');
try {
  await client.realtime.connect();
  console.log('   connected:', client.realtime.isConnected);
} catch (e) {
  console.log('   CONNECT FAILED:', e.message);
  process.exit(1);
}

console.log('2. subscribing to player_sync...');
const sub = await client.realtime.subscribe('player_sync');
console.log('   subscribe result:', JSON.stringify(sub));

console.log('3. listening + publishing test event...');
client.realtime.on('sync', (p) => {
  console.log('   RECEIVED sync event:', JSON.stringify(p));
});

try {
  await client.realtime.publish('player_sync', 'sync', { hello: 'world', n: Date.now() });
  console.log('   published');
} catch (e) {
  console.log('   PUBLISH FAILED:', e.message);
}

await new Promise((r) => setTimeout(r, 4000));
console.log('4. done — if no RECEIVED line above, events are not being delivered back');
process.exit(0);
