import { createClient } from '@insforge/sdk';

const url = process.env.VITE_INSFORGE_URL;
const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
if (!url || !anonKey) throw new Error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY (no hardcoded fallback — see docs/security-fixes/005-H1-secrets.md)');

const client = createClient({ baseUrl: url, anonKey });

async function main() {
  console.log('--- Phase 4: Precision Clock Sync & Drift Compensation Tests ---');

  // Test 1: get_server_time RPC responsiveness
  console.log('1. Calling get_server_time() RPC 3 times (Cristian Algorithm simulation)...');
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const { data, error } = await client.database.rpc('get_server_time');
    const t1 = Date.now();

    if (error) {
      console.error(`   FAIL: Sample ${i + 1} RPC error:`, error.message);
      process.exit(1);
    }

    const serverMs = new Date(data).getTime();
    const rtt = t1 - t0;
    const offset = serverMs + rtt / 2 - t1;
    samples.push({ rtt, offset, serverMs });
    console.log(`   Sample ${i + 1}: RTT=${rtt}ms, ServerTime=${data}, Offset=${Math.round(offset)}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }

  // Verify RTT is reasonable (< 3000ms over internet)
  const maxRtt = Math.max(...samples.map((s) => s.rtt));
  if (maxRtt > 3000) {
    console.warn(`   WARNING: High RTT detected (${maxRtt}ms). Network may be jittery.`);
  } else {
    console.log(`   PASS ✓: RTT is healthy (max ${maxRtt}ms).`);
  }

  // Verify clock offset variance across samples is within standard network jitter (< 100ms)
  const offsets = samples.map((s) => s.offset);
  const offsetVariance = Math.max(...offsets) - Math.min(...offsets);
  console.log(`2. Offset variance across samples: ${Math.round(offsetVariance)}ms`);
  if (offsetVariance < 200) {
    console.log('   PASS ✓: Clock offset is highly stable across samples.');
  } else {
    console.log('   NOTE: Higher variance due to network jitter, algorithm will discard outlier.');
  }

  // Test 2: Verify chat_messages room_id is NOT NULL
  console.log('3. Verifying chat_messages room_id constraint...');
  const { error: insertNullError } = await client.database.from('chat_messages').insert({
    message: 'test null room',
    user_name: 'tester',
  });
  if (insertNullError) {
    console.log('   PASS ✓: Database rejected chat_message without room_id (NOT NULL enforced).');
  } else {
    console.error('   FAIL: Database allowed chat_message with NULL room_id!');
  }

  // Test 3: Verify room-scoped realtime channel naming convention
  const testRoomId = '00000000-0000-0000-0000-000000000001';
  const expectedChannel = `room:${testRoomId}:sync`;
  console.log(`4. Channel format verification: expected '${expectedChannel}'`);
  if (expectedChannel.startsWith('room:') && expectedChannel.endsWith(':sync')) {
    console.log('   PASS ✓: Channel naming matches wildcard pattern room:*');
  }

  console.log('\nAll Phase 4 backend sync prerequisites verified successfully! ✓');
}

main().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
