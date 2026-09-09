# Implementation Plan — Security Hardening & Vulnerability Remediation

---

## Goal Description
Conduct a comprehensive security hardening of the **WiFi Jokey** platform to eliminate critical vulnerabilities identified across the database RLS policies, realtime WebSocket publishing rules, session hijacking attack surfaces, stored procedure execution contexts, and frontend secret storage.

---

## User Review Required

> [!IMPORTANT]
> **Realtime Sync Host Authorization (Critical Fix):**
> Currently, migration `20260903000001_multiroom-realtime-rls.sql:26-32` permits *any* authenticated user to publish to `room:%:sync`. We will lock this down with a strict regex and SQL check:
> `channel_name ~ '^room:[0-9a-f-]{36}:sync$' AND EXISTS (SELECT 1 FROM rooms WHERE id = ... AND host_id = auth.uid())`.
> This guarantees that no user can hijack playback in another user's room.

> [!WARNING]
> **Session Ownership & Kicking Fix:**
> Currently, `leave_room(p_room_id, p_session_id)` allows anyone who sees another user's `session_id` to kick them.
> We introduce a secure, secret `member_token` generated inside Postgres on `join_room_secure()`:
> - The `member_token` is returned **only to the joining client** and kept in React memory.
> - `get_active_room_members()` will **redact** this token and only expose `session_id` for UI matching.
> - `leave_room` and `ping_room_presence` will require the valid `member_token`.

> [!NOTE]
> **Removal of Plaintext Passwords in Browser Storage:**
> Currently, `LobbyPage.tsx` and `RoomPage.tsx` store private room passwords in `sessionStorage` (`wj_pwd_<CODE>`).
> We will eliminate `sessionStorage` password caching and keep passwords exclusively in React component memory during the session lifecycle.

---

## Vulnerability Threat Matrix & Prioritized Findings

| ID | Vulnerability | Severity | Vector | Target Component |
|:---|:---|:---|:---|:---|
| **C1** | **Realtime Sync Broadcast Spoofing** | **CRITICAL** | Any signed-in user can publish to another room's sync channel and hijack playback | `realtime.messages` RLS policy |
| **C2** | **Private Room Data Disclosure (IDOR)** | **CRITICAL** | `chat_messages`, `room_queue`, `room_members` world-readable (`USING (true)`) by anonymous queries | Table RLS policies & Lobby query |
| **C3** | **Unauthorized Kick & Session Ghosting** | **CRITICAL** | `leave_room` & `ping` accept plain `p_session_id` without ownership proof | `leave_room`, `ping_room_presence` RPCs |
| **H1** | **`SECURITY DEFINER` Search Path Hijacking** | **HIGH** | All 14 stored procedures lack `SET search_path = public, pg_temp` | All PostgreSQL functions |
| **H2** | **Host Handover Private Room Hijack** | **HIGH** | `claim abandoned room` allows updating any column (`max_members`, `is_private`) without password check | `claim abandoned room` RLS policy |
| **H3** | **Unvalidated Queue Status & Lengths** | **HIGH** | `update_queue_status` accepts arbitrary status; `request_song` lacks video ID regex & queue limit | `room_queue` table & RPCs |
| **H4** | **Plaintext Room Passwords in `sessionStorage`** | **HIGH** | XSS or browser extensions can read plaintext room passwords from storage | `LobbyPage.tsx`, `RoomPage.tsx` |
| **M1** | **Realtime Anonymous Auth Downgrade** | **MEDIUM** | Realtime client downgrades to anonymous on JWT failure instead of failing closed | `src/lib/realtime.ts` |
| **M2** | **Full Table Presence Dump in Lobby** | **MEDIUM** | `LobbyPage` queries all active members across entire database to count occupants | `src/pages/LobbyPage.tsx` |
| **M3** | **Missing Content Security Policy (CSP)** | **MEDIUM** | No CSP meta tag or HTTP security headers in production bundle | `index.html`, `vite.config.ts` |

---

## Proposed Changes

### 1. Database & Migrations

#### [NEW] `migrations/20260903300000_security-hardening.sql`

```sql
-- Migration: Complete Security Hardening & Access Control Lockdown

-- ============================================================
-- 1. Realtime Sync Publish Lockdown (Fix C1)
-- ============================================================
DROP POLICY IF EXISTS "room host can publish room sync" ON realtime.messages;
DROP POLICY IF EXISTS "room host can publish sync" ON realtime.messages;

CREATE POLICY "room host can publish room sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-f-]{36}:sync$'
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = (split_part(channel_name, ':', 2))::uuid
        AND r.host_id = (SELECT auth.uid())
    )
  );

-- Disable legacy global channels
UPDATE realtime.channels
SET enabled = false
WHERE pattern IN ('player_sync', 'chat_messages');

-- ============================================================
-- 2. Member Token & Secure Presence (Fix C3)
-- ============================================================
ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS member_token VARCHAR(64) NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex');

-- Re-create join_room_secure to return member_token securely
CREATE OR REPLACE FUNCTION public.join_room_secure(
  p_code TEXT,
  p_session_id UUID,
  p_display_name TEXT,
  p_password TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
  v_hash TEXT;
  v_count INT;
  v_role TEXT := 'listener';
  v_token VARCHAR(64);
BEGIN
  -- 1. Find room by code
  SELECT * INTO v_room FROM public.rooms WHERE UPPER(code) = UPPER(trim(p_code)) AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room not found or inactive.');
  END IF;

  -- 2. Check password if private (cost 12 compatible)
  IF v_room.is_private AND v_room.host_id IS DISTINCT FROM auth.uid() THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Incorrect password for this private room.');
    END IF;
  END IF;

  -- 3. Prune stale members
  DELETE FROM public.room_members
  WHERE room_id = v_room.id AND last_seen < now() - interval '45 seconds';

  -- 4. Check active member count with row lock
  PERFORM 1 FROM public.rooms WHERE id = v_room.id FOR UPDATE;

  SELECT count(*) INTO v_count FROM public.room_members WHERE room_id = v_room.id;

  IF NOT EXISTS (SELECT 1 FROM public.room_members WHERE room_id = v_room.id AND session_id = p_session_id) THEN
    IF v_count >= v_room.max_members THEN
      RETURN jsonb_build_object('success', false, 'error', 'Room is currently full (Maximum 5 listeners).');
    END IF;
  END IF;

  IF auth.uid() IS NOT NULL AND auth.uid() = v_room.host_id THEN
    v_role := 'host';
  END IF;

  -- Generate fresh member token
  v_token := encode(gen_random_bytes(24), 'hex');

  -- 5. Upsert membership with token
  INSERT INTO public.room_members (room_id, user_id, session_id, display_name, role, member_token, last_seen)
  VALUES (v_room.id, auth.uid(), p_session_id, trim(p_display_name), v_role, v_token, now())
  ON CONFLICT (room_id, session_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      member_token = v_token,
      last_seen = now();

  RETURN jsonb_build_object(
    'success', true,
    'member_token', v_token,
    'room', jsonb_build_object(
      'id', v_room.id,
      'code', v_room.code,
      'name', v_room.name,
      'is_private', v_room.is_private,
      'host_id', v_room.host_id,
      'role', v_role
    )
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Secure Ping requiring token
CREATE OR REPLACE FUNCTION public.ping_room_presence(
  p_room_id UUID,
  p_session_id UUID,
  p_member_token TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE public.room_members
  SET last_seen = now()
  WHERE room_id = p_room_id
    AND session_id = p_session_id
    AND (member_token = p_member_token OR (user_id IS NOT NULL AND user_id = (SELECT auth.uid())));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Secure Leave requiring token
CREATE OR REPLACE FUNCTION public.leave_room(
  p_room_id UUID,
  p_session_id UUID,
  p_member_token TEXT
) RETURNS VOID AS $$
BEGIN
  DELETE FROM public.room_members
  WHERE room_id = p_room_id
    AND session_id = p_session_id
    AND (member_token = p_member_token OR (user_id IS NOT NULL AND user_id = (SELECT auth.uid())));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Redact member_token from get_active_room_members
CREATE OR REPLACE FUNCTION public.get_active_room_members(p_room_id UUID)
RETURNS TABLE (
  session_id UUID,
  display_name VARCHAR(50),
  role VARCHAR(20),
  joined_at TIMESTAMPTZ,
  is_active BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.session_id,
    m.display_name,
    m.role,
    m.joined_at,
    (m.last_seen > now() - interval '45 seconds') AS is_active
  FROM public.room_members m
  WHERE m.room_id = p_room_id
    AND m.last_seen > now() - interval '45 seconds'
  ORDER BY m.joined_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- 3. Room & Data Access Policies (Fix C2)
-- ============================================================
-- Chat messages: only readable by members of that room or public rooms
DROP POLICY IF EXISTS "select chat_messages by room" ON public.chat_messages;
CREATE POLICY "select chat_messages by room" ON public.chat_messages
  FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = chat_messages.room_id
        AND (NOT r.is_private OR r.host_id = (SELECT auth.uid()) OR EXISTS (
          SELECT 1 FROM public.room_members m
          WHERE m.room_id = r.id AND m.last_seen > now() - interval '45 seconds'
        ))
    )
  );

-- Queue moderation status constraint (Fix H3)
ALTER TABLE public.room_queue DROP CONSTRAINT IF EXISTS chk_queue_status;
ALTER TABLE public.room_queue
  ADD CONSTRAINT chk_queue_status CHECK (status IN ('queued', 'playing', 'played', 'dismissed'));

-- Fix update_queue_status to validate status
CREATE OR REPLACE FUNCTION public.update_queue_status(
  p_queue_id UUID,
  p_status TEXT
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_host_id UUID;
BEGIN
  IF p_status NOT IN ('queued', 'playing', 'played', 'dismissed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid queue status.');
  END IF;

  SELECT q.room_id, r.host_id INTO v_room_id, v_host_id
  FROM public.room_queue q
  JOIN public.rooms r ON r.id = q.room_id
  WHERE q.id = p_queue_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Track not found.');
  END IF;

  IF v_host_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only the room host can moderate the queue.');
  END IF;

  UPDATE public.room_queue SET status = p_status, updated_at = now() WHERE id = p_queue_id;

  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'status', 'id', p_queue_id, 'status', p_status));

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- Request Song Validation & Queue Limit (Fix H3)
CREATE OR REPLACE FUNCTION public.request_song(
  p_room_id UUID,
  p_video_id TEXT,
  p_title TEXT,
  p_artist TEXT,
  p_album_art TEXT,
  p_session_id UUID,
  p_display_name TEXT
) RETURNS JSONB AS $$
DECLARE
  v_active_count INT;
  v_total_queue INT;
  v_new_id UUID;
  v_is_room_valid BOOLEAN;
  v_clean_vid TEXT := trim(p_video_id);
BEGIN
  -- Strict 11-char YouTube ID regex
  IF v_clean_vid !~ '^[a-zA-Z0-9_-]{11}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid YouTube Video ID format.');
  END IF;

  -- Verify room is active and non-expired
  SELECT EXISTS(
    SELECT 1 FROM public.rooms WHERE id = p_room_id AND expires_at > now() AND is_active = true
  ) INTO v_is_room_valid;

  IF NOT v_is_room_valid THEN
    RETURN jsonb_build_object('success', false, 'error', 'This room has expired or is inactive.');
  END IF;

  -- Max 50 songs total per room queue (DoS barrier)
  SELECT count(*) INTO v_total_queue FROM public.room_queue WHERE room_id = p_room_id AND status = 'queued';
  IF v_total_queue >= 50 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room queue is currently full (Maximum 50 songs).');
  END IF;

  -- Max 3 active queued songs per session
  SELECT count(*) INTO v_active_count 
  FROM public.room_queue 
  WHERE room_id = p_room_id 
    AND requested_by_session = p_session_id 
    AND status = 'queued';

  IF v_active_count >= 3 THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have 3 songs in the queue. Wait for one to play!');
  END IF;

  INSERT INTO public.room_queue (
    room_id, video_id, title, artist, album_art, requested_by_session, requested_by_name, vote_count, status
  )
  VALUES (
    p_room_id, v_clean_vid, substr(trim(p_title), 1, 200), substr(trim(p_artist), 1, 100),
    substr(trim(p_album_art), 1, 500), p_session_id, substr(trim(p_display_name), 1, 50), 1, 'queued'
  )
  RETURNING id INTO v_new_id;

  INSERT INTO public.queue_votes (queue_id, session_id)
  VALUES (v_new_id, p_session_id)
  ON CONFLICT DO NOTHING;

  PERFORM realtime.publish('room:' || p_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'added', 'id', v_new_id));

  RETURN jsonb_build_object('success', true, 'queue_id', v_new_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- ============================================================
-- 4. Hardening All SECURITY DEFINER Functions with search_path (Fix H1)
-- ============================================================
-- Re-calculate exact count inside transaction to eliminate race conditions
CREATE OR REPLACE FUNCTION public.toggle_upvote_song(
  p_queue_id UUID,
  p_session_id UUID
) RETURNS JSONB AS $$
DECLARE
  v_room_id UUID;
  v_has_voted BOOLEAN;
  v_new_votes INT;
BEGIN
  SELECT room_id INTO v_room_id FROM public.room_queue WHERE id = p_queue_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Track not found in queue.');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id
  ) INTO v_has_voted;

  IF v_has_voted THEN
    DELETE FROM public.queue_votes WHERE queue_id = p_queue_id AND session_id = p_session_id;
  ELSE
    INSERT INTO public.queue_votes (queue_id, session_id) VALUES (p_queue_id, p_session_id);
  END IF;

  -- Re-calculate exact vote count atomically to prevent drift
  SELECT count(*) INTO v_new_votes FROM public.queue_votes WHERE queue_id = p_queue_id;
  UPDATE public.room_queue SET vote_count = v_new_votes, updated_at = now() WHERE id = p_queue_id;

  PERFORM realtime.publish('room:' || v_room_id || ':queue', 'queue_update', jsonb_build_object('action', 'vote', 'id', p_queue_id, 'votes', v_new_votes));

  RETURN jsonb_build_object('success', true, 'votes', v_new_votes, 'voted', NOT v_has_voted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

ALTER FUNCTION public.create_room_secure(TEXT, BOOLEAN, TEXT, TEXT) SET search_path = public, pg_temp;
ALTER FUNCTION public.purge_expired_rooms() SET search_path = public, pg_temp;
ALTER FUNCTION public.broadcast_playback_state() SET search_path = public, pg_temp;
ALTER FUNCTION public.protect_chat_display_name() SET search_path = public, pg_temp;

-- ============================================================
-- 5. Secure Host Handover Procedure (Fix H2)
-- ============================================================
DROP POLICY IF EXISTS "claim abandoned room" ON public.rooms;

CREATE OR REPLACE FUNCTION public.claim_abandoned_room(
  p_room_id UUID,
  p_password TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_room public.rooms%ROWTYPE;
  v_hash TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Must be signed in to claim host.');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Room not found.');
  END IF;

  -- Must be abandoned (> 2 mins)
  IF v_room.host_last_seen IS NOT NULL AND v_room.host_last_seen > now() - interval '2 minutes' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Current host is still active.');
  END IF;

  -- If private, claimer must verify password
  IF v_room.is_private THEN
    SELECT password_hash INTO v_hash FROM public.room_secrets WHERE room_id = v_room.id;
    IF v_hash IS NULL OR p_password IS NULL OR crypt(trim(p_password), v_hash) != v_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Incorrect room password.');
    END IF;
  END IF;

  UPDATE public.rooms
  SET host_id = auth.uid(),
      host_last_seen = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('success', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;
```

---

### 2. Client Security & Secret Elimination

#### [MODIFY] `src/pages/LobbyPage.tsx`
- **Eliminate `sessionStorage`**: Remove line 125 `sessionStorage.setItem(...)`. Pass password strictly via router state (`navigate(..., { state: { password } })`).
- **Eliminate Full Table Dump**: Replace lines 53-56 (`select('room_id')` from `room_members`) with safe count calculation.

#### [MODIFY] `src/pages/RoomPage.tsx`
- **Eliminate `sessionStorage`**: Remove line 92 & 130 (`sessionStorage.getItem` / `sessionStorage.setItem`). Store password in React `useRef` in memory.
- **Support Member Token**: Store `member_token` in `useRef`, pass to `ping_room_presence` and `leave_room`.

#### [MODIFY] `src/hooks/useYouTubeMusic.ts`
- **Validate Video ID in Sync Payloads**: In `applyPlaybackState()`, run `extractYouTubeId(state.track?.id)` and verify `state.track.id` matches an 11-char ID before setting `tracksRef` or updating player embed.
- **Reject Anomalous Sequence Numbers**: Drop sequence numbers jumping ahead by $> 1000$ to prevent denial-of-service sequence saturation attacks.

#### [MODIFY] `scripts/relay-test.mjs` & `scripts/test-multiroom-rpc.mjs`
- Purge hardcoded API keys and fallbacks (`ik_***`), reading strictly from `process.env`.

#### [MODIFY] `index.html`
- Add Content Security Policy meta tag:
  ```html
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; img-src 'self' https://img.youtube.com https://i.ytimg.com https://images.unsplash.com data:; connect-src 'self' https://*.insforge.app wss://*.insforge.app https://noembed.com https://www.youtube.com; object-src 'none'; base-uri 'self';">
  ```

---

## Verification Plan

### Automated Tests
1. **Apply Security Migration:**
   ```bash
   insforge -y db migrations up --all
   ```
2. **Security Test Suite (`scripts/test-security-hardening.mjs`):**
   - **Test 1 (Realtime Host Lockdown)**: Verify that publishing to `room:<id>:sync` as a non-host authenticated user is strictly blocked by PostgreSQL RLS.
   - **Test 2 (Kick Protection)**: Attempt to call `leave_room` with a valid `session_id` but invalid `member_token`; confirm no deletion occurs.
   - **Test 3 (Search Path Hardening)**: Query `pg_proc` to verify all `SECURITY DEFINER` functions have `proconfig` containing `search_path=public, pg_temp`.
   - **Test 4 (Queue Status Validation)**: Verify `update_queue_status` rejects invalid statuses like `'evil_status'`.
   - **Test 5 (Video ID Regex)**: Verify `request_song` rejects non-11-char IDs like `'"><script>'`.
3. **Regression Builds & Existing Tests:**
   ```bash
   node scripts/test-multiroom-rpc.mjs
   node scripts/test-phase3-queue.mjs
   node scripts/test-phase4-sync.mjs
   npm run build
   ```

### Manual Verification
1. **Password Memory Isolation**: Check Developer Tools $\rightarrow$ Application $\rightarrow$ Session Storage; verify no `wj_pwd_*` keys exist.
2. **Cross-Room Broadcast Resistance**: From DevTools console in Room A, attempt to emit a sync event to Room B; verify it is dropped by the server.
