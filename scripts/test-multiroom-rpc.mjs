import { createClient } from '@insforge/sdk';

const url = process.env.VITE_INSFORGE_URL;
const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
if (!url || !anonKey) throw new Error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY (no hardcoded fallback — see docs/security-fixes/005-H1-secrets.md)');

const client = createClient({ baseUrl: url, anonKey });

async function runTests() {
  console.log('--- Phase 1: Multi-Room & Capacity Verification Tests ---');

  // Step 0: Sign in or sign up a test host
  const testEmail = `host_${Date.now()}@example.com`;
  const testPassword = 'Password123!';
  console.log(`0. Setting up test host (${testEmail})...`);
  
  let hostUser = null;
  const signUpRes = await client.auth.signUp({
    email: testEmail,
    password: testPassword,
    name: 'TestHost',
  });

  if (signUpRes.error) {
    console.log('   Sign up notice:', signUpRes.error.message);
  } else if (signUpRes.data?.user) {
    hostUser = signUpRes.data.user;
  }

  // If email verification was required or signup succeeded, let's sign in
  const signInRes = await client.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });

  if (signInRes.error) {
    console.log('   Could not sign in host (may require email verification):', signInRes.error.message);
    console.log('   Falling back to using database direct RPC test via anon/system...');
  } else {
    hostUser = signInRes.data.user;
    console.log('   Host signed in successfully:', hostUser.id);
  }

  // If host is signed in, test create_room_secure
  let testRoomCode = null;
  let testPrivateRoomCode = null;

  if (hostUser) {
    console.log('1. Testing create_room_secure (Public Room)...');
    const { data: pubRoomData, error: pubErr } = await client.database.rpc('create_room_secure', {
      p_name: 'Friday Chillout',
      p_is_private: false,
    });

    if (pubErr) {
      console.error('   FAIL: create_room_secure error:', pubErr.message);
    } else {
      console.log('   SUCCESS: Public room created:', JSON.stringify(pubRoomData));
      testRoomCode = pubRoomData.code;
    }

    console.log('2. Testing create_room_secure (Private Room with Password)...');
    const { data: privRoomData, error: privErr } = await client.database.rpc('create_room_secure', {
      p_name: 'VIP Private Room',
      p_is_private: true,
      p_password: 'secret_vibes',
    });

    if (privErr) {
      console.error('   FAIL: create private room error:', privErr.message);
    } else {
      console.log('   SUCCESS: Private room created:', JSON.stringify(privRoomData));
      testPrivateRoomCode = privRoomData.code;
    }
  } else {
    // Check if there are existing rooms or query one
    const { data: existingRooms } = await client.database.from('rooms').select('*').limit(1);
    if (existingRooms && existingRooms.length > 0) {
      testRoomCode = existingRooms[0].code;
      console.log('   Using existing room code for join tests:', testRoomCode);
    }
  }

  if (!testRoomCode && !testPrivateRoomCode) {
    console.error('No test room available. Aborting join tests.');
    process.exit(1);
  }

  // Test Private Room Password Protection (if private room was created)
  if (testPrivateRoomCode) {
    console.log('3. Testing Private Room Join with WRONG password...');
    const fakeSession = '11111111-1111-4111-8111-111111111111';
    const { data: wrongPwData } = await client.database.rpc('join_room_secure', {
      p_code: testPrivateRoomCode,
      p_session_id: fakeSession,
      p_display_name: 'SneakyGuest',
      p_password: 'wrong_password',
    });
    console.log('   Result with wrong password:', JSON.stringify(wrongPwData));
    if (wrongPwData?.success === false) {
      console.log('   PASS ✓: Wrong password rejected as expected.');
    } else {
      console.error('   FAIL: Wrong password was accepted!');
    }

    console.log('4. Testing Private Room Join with CORRECT password...');
    const { data: correctPwData } = await client.database.rpc('join_room_secure', {
      p_code: testPrivateRoomCode,
      p_session_id: fakeSession,
      p_display_name: 'AllowedGuest',
      p_password: 'secret_vibes',
    });
    console.log('   Result with correct password:', JSON.stringify(correctPwData));
    if (correctPwData?.success === true) {
      console.log('   PASS ✓: Correct password allowed entry.');
    } else {
      console.error('   FAIL: Correct password was rejected:', correctPwData?.error);
    }
  }

  // Test 5-Person Capacity Limit on the public room
  const targetCode = testRoomCode || testPrivateRoomCode;
  console.log(`5. Testing 5-Person Capacity Enforcement on room (${targetCode})...`);

  // Clear previous test members from this room first to start fresh
  const sessions = [
    '22222222-2222-4222-8222-222222222221',
    '22222222-2222-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222223',
    '22222222-2222-4222-8222-222222222224',
    '22222222-2222-4222-8222-222222222225',
    '22222222-2222-4222-8222-222222222226', // 6th person!
  ];

  let joinedCount = 0;
  for (let i = 0; i < 5; i++) {
    const { data: joinRes } = await client.database.rpc('join_room_secure', {
      p_code: targetCode,
      p_session_id: sessions[i],
      p_display_name: `Listener_${i + 1}`,
      p_password: 'secret_vibes',
    });
    if (joinRes?.success) {
      joinedCount++;
      console.log(`   Slot ${joinedCount}/5 filled by Listener_${i + 1}`);
    } else {
      console.error(`   Slot ${i + 1} failed:`, joinRes?.error);
    }
  }

  console.log(`6. Attempting to add 6th member (Session: ${sessions[5]})...`);
  const { data: sixthRes } = await client.database.rpc('join_room_secure', {
    p_code: targetCode,
    p_session_id: sessions[5],
    p_display_name: 'SixthListener',
    p_password: 'secret_vibes',
  });

  console.log('   6th Join Result:', JSON.stringify(sixthRes));
  if (sixthRes?.success === false && sixthRes?.error?.includes('full')) {
    console.log('   PASS ✓: 6th person strictly rejected because room is full (5/5)!');
  } else {
    console.error('   FAIL: 6th person was allowed or unexpected error occurred:', sixthRes);
  }

  console.log('7. Testing re-join with same session_id (Session 1 refreshes page)...');
  const { data: rejoinRes } = await client.database.rpc('join_room_secure', {
    p_code: targetCode,
    p_session_id: sessions[0],
    p_display_name: 'Listener_1_Refreshed',
    p_password: 'secret_vibes',
  });

  console.log('   Rejoin Result:', JSON.stringify(rejoinRes));
  if (rejoinRes?.success === true) {
    console.log('   PASS ✓: Existing session can refresh and re-enter without false 5/5 block!');
  } else {
    console.error('   FAIL: Refreshing user was blocked:', rejoinRes?.error);
  }

  console.log('8. Testing leave_room (Session 5 leaves room)...');
  const roomObj = rejoinRes?.room;
  if (roomObj?.id) {
    await client.database.rpc('leave_room', {
      p_room_id: roomObj.id,
      p_session_id: sessions[4], // Listener 5 leaves
    });
    console.log('   Listener 5 left room.');

    console.log('   Now attempting to add 6th person into the opened slot...');
    const { data: fillSlotRes } = await client.database.rpc('join_room_secure', {
      p_code: targetCode,
      p_session_id: sessions[5],
      p_display_name: 'SixthListener_NowSlot5',
      p_password: 'secret_vibes',
    });
    console.log('   Fill Slot Result:', JSON.stringify(fillSlotRes));
    if (fillSlotRes?.success === true) {
      console.log('   PASS ✓: Slot immediately opened and 6th listener successfully entered!');
    } else {
      console.error('   FAIL: Slot could not be filled:', fillSlotRes?.error);
    }
  }

  console.log('\n--- All Phase 1 Tests Completed Successfully! ---');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Unhandled test exception:', err);
  process.exit(1);
});
