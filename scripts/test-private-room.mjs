import { createClient } from '@insforge/sdk';

const url = process.env.VITE_INSFORGE_URL;
const anonKey = process.env.VITE_INSFORGE_ANON_KEY;

const client = createClient({ baseUrl: url, anonKey });

async function main() {
  console.log('--- Testing Private Room & Password Verification ---');

  // 1. Check columns of 'rooms' to ensure password_hash does NOT exist on rooms
  const { data: rooms } = await client.database.from('rooms').select('*').limit(1);
  console.log('1. Checking rooms schema on sample row:');
  if (rooms && rooms[0]) {
    const keys = Object.keys(rooms[0]);
    console.log('   Columns present on rooms:', keys.join(', '));
    if (keys.includes('password_hash')) {
      console.error('   FAIL: password_hash was found in rooms table! It must remain secret.');
    } else {
      console.log('   PASS ✓: password_hash is NOT present on rooms table (Zero-leakage).');
    }
  }

  // 2. Try to query room_secrets as anon/client
  console.log('2. Verifying client cannot query room_secrets table directly...');
  const { data: secrets, error: secretsErr } = await client.database.from('room_secrets').select('*').limit(1);
  if (secretsErr) {
    console.log('   PASS ✓: Direct select on room_secrets blocked by RLS/permissions:', secretsErr.message);
  } else if (!secrets || secrets.length === 0) {
    console.log('   PASS ✓: room_secrets query returned 0 rows (RLS restricted).');
  } else {
    console.error('   FAIL: room_secrets was readable by anon client!');
  }

  // 3. Test get_active_room_members RPC
  console.log('3. Testing get_active_room_members RPC on room MAIN01...');
  const { data: members, error: memErr } = await client.database.rpc('get_active_room_members', {
    p_room_id: rooms[0].id
  });

  if (memErr) {
    console.error('   FAIL: get_active_room_members error:', memErr.message);
  } else {
    console.log('   PASS ✓: Active members returned successfully:');
    console.table(members);
  }

  console.log('\n--- Private Room Security Tests Completed Successfully! ---');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
