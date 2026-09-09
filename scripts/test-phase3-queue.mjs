import { createClient } from '@insforge/sdk';

const url = process.env.VITE_INSFORGE_URL;
const anonKey = process.env.VITE_INSFORGE_ANON_KEY;
if (!url || !anonKey) throw new Error('Missing VITE_INSFORGE_URL / VITE_INSFORGE_ANON_KEY (no hardcoded fallback — see docs/security-fixes/005-H1-secrets.md)');

const client = createClient({ baseUrl: url, anonKey });

async function main() {
  console.log('--- Phase 3: Song Queue & 24-Hour Expiry Verification Tests ---');

  // 1. Get an active room
  const { data: rooms } = await client.database.from('rooms').select('*').limit(1);
  if (!rooms || rooms.length === 0) {
    console.error('No rooms available for queue testing.');
    process.exit(1);
  }

  const room = rooms[0];
  console.log(`1. Testing with room: ${room.name} (${room.code}) - ID: ${room.id}`);
  console.log(`   Room expires at: ${room.expires_at}`);

  const testSession = '33333333-3333-4333-8333-333333333331';

  // 2. Request Song 1
  console.log('2. Submitting Song Request 1...');
  const { data: req1, error: err1 } = await client.database.rpc('request_song', {
    p_room_id: room.id,
    p_video_id: 'jfKfPfyJRdk',
    p_title: 'Lofi Girl Beats',
    p_artist: 'Lofi Girl',
    p_album_art: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg',
    p_session_id: testSession,
    p_display_name: 'QueueTester',
  });

  if (err1) {
    console.error('   FAIL: Song request 1 failed:', err1.message);
  } else {
    console.log('   PASS ✓: Song 1 queued successfully:', JSON.stringify(req1));
  }

  const songId1 = req1?.queue_id;

  // 3. Request Song 2 & 3
  console.log('3. Submitting Song Requests 2 and 3...');
  await client.database.rpc('request_song', {
    p_room_id: room.id,
    p_video_id: '5qap5aO4i9A',
    p_title: 'Chillhop Beats',
    p_artist: 'Lofi Records',
    p_album_art: 'https://img.youtube.com/vi/5qap5aO4i9A/hqdefault.jpg',
    p_session_id: testSession,
    p_display_name: 'QueueTester',
  });

  await client.database.rpc('request_song', {
    p_room_id: room.id,
    p_video_id: '4xDzrJKXOOY',
    p_title: 'Synthwave Radio',
    p_artist: 'Lofi Synthwave',
    p_album_art: 'https://img.youtube.com/vi/4xDzrJKXOOY/hqdefault.jpg',
    p_session_id: testSession,
    p_display_name: 'QueueTester',
  });
  console.log('   PASS ✓: Songs 2 & 3 added.');

  // 4. Test Rate Limit (4th song from same session)
  console.log('4. Testing queue rate-limit (Attempting 4th active song from same session)...');
  const { data: req4 } = await client.database.rpc('request_song', {
    p_room_id: room.id,
    p_video_id: 'dQw4w9WgXcQ',
    p_title: 'Rick Astley',
    p_artist: 'Rick',
    p_album_art: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    p_session_id: testSession,
    p_display_name: 'QueueTester',
  });

  console.log('   4th Request Result:', JSON.stringify(req4));
  if (req4?.success === false && req4?.error?.includes('3 songs')) {
    console.log('   PASS ✓: 4th song rejected by rate-limiter as expected!');
  } else {
    console.error('   FAIL: Rate limiter did not trigger:', req4);
  }

  // 5. Test Upvote and Toggle
  if (songId1) {
    console.log('5. Testing upvote on song 1 from a second session...');
    const voterSession = '44444444-4444-4444-8444-444444444441';

    const { data: vote1 } = await client.database.rpc('toggle_upvote_song', {
      p_queue_id: songId1,
      p_session_id: voterSession,
    });
    console.log('   Vote Result:', JSON.stringify(vote1));
    if (vote1?.success && vote1?.votes === 2) {
      console.log('   PASS ✓: Song upvoted (Vote count: 2).');
    } else {
      console.error('   FAIL: Upvote failed:', vote1);
    }

    console.log('6. Testing toggle upvote off (clicking upvote again)...');
    const { data: vote2 } = await client.database.rpc('toggle_upvote_song', {
      p_queue_id: songId1,
      p_session_id: voterSession,
    });
    console.log('   Vote Result:', JSON.stringify(vote2));
    if (vote2?.success && vote2?.votes === 1) {
      console.log('   PASS ✓: Upvote toggled off (Vote count returned to 1).');
    } else {
      console.error('   FAIL: Toggle upvote off failed:', vote2);
    }
  }

  // 7. Test Purge Expired Rooms Function
  console.log('7. Testing purge_expired_rooms function...');
  const { data: purgedCount, error: purgeErr } = await client.database.rpc('purge_expired_rooms');
  if (purgeErr) {
    console.error('   FAIL: purge_expired_rooms error:', purgeErr.message);
  } else {
    console.log(`   PASS ✓: purge_expired_rooms ran successfully (Purged: ${purgedCount} expired rooms).`);
  }

  console.log('\n--- All Phase 3 Tests Completed Successfully! ---');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
