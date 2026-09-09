-- Migration: Realtime publish lockdown, round 2 (audit 022, Phase 1 item 3)
--
-- WHY:
--   (a) realtime chat publish allowed ANON with no membership check, so anyone
--       with a room UUID could spoof host/chat messages to subscribers.
--   (b) sync regex allowed any 36-char dash string then raised on ::uuid cast
--       (noisy deny instead of clean deny).
--   (c) queue channel had no explicit publish policy (default-deny only).
-- WHAT:
--   1. Chat publish: authenticated only + must be host or a RECENT member row
--      (user_id match). Anon guests publish via post_chat() (039), which
--      fans out server-side — they never need direct publish.
--   2. Sync publish: strict lowercase-UUID regex (clean deny, no cast raise).
--   3. Queue publish: explicit authenticated-member/host-only policy
--      (server RPCs publish as definer and are unaffected).
-- DELIBERATELY NOT DONE: no SELECT (subscribe) policy on realtime.messages.
--   Anon guests carry no auth.uid/session in their JWT, so RLS cannot tell an
--   anon MEMBER from an anon stranger; a SELECT gate would break chat/queue/
--   sync reception for every logged-out listener in private rooms. Accepted
--   residual: knowing a room UUID lets you snoop realtime payloads (UUIDs are
--   unguessable; DB history reads stay RLS-denied). Revisit if InsForge ships
--   token-bound subscriptions.
-- ROLLBACK: re-apply the two policies from 20260903300000 §2.
-- VERIFY: anon realtime publish to room:*:chat → rejected; authed stranger
--   publish → rejected; sync to malformed channel → clean reject, no error.

-- Strict-UUID helper lives inline (policies can't easily share functions
-- without extra grants; shape duplicated per policy as in 033).

-- 1. Sync: host-only + strict shape.
DROP POLICY IF EXISTS "room host can publish room sync" ON realtime.messages;
CREATE POLICY "room host can publish room sync" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:sync$'
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = (split_part(channel_name, ':', 2))::uuid
        AND r.host_id = (SELECT auth.uid())
    )
  );

-- 2. Chat: authenticated member-or-host only (anon uses post_chat RPC).
DROP POLICY IF EXISTS "anyone can publish room chat" ON realtime.messages;
DROP POLICY IF EXISTS "anyone can publish chat" ON realtime.messages;
CREATE POLICY "member can publish room chat" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:chat$'
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = (split_part(channel_name, ':', 2))::uuid
        AND (
          r.host_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.room_members m
            WHERE m.room_id = r.id
              AND m.user_id = (SELECT auth.uid())
              AND m.last_seen > now() - interval '45 seconds'
          )
        )
    )
  );

-- 3. Queue: explicit member-or-host-only (previously implicit default-deny).
DROP POLICY IF EXISTS "member can publish room queue" ON realtime.messages;
CREATE POLICY "member can publish room queue" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    channel_name ~ '^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:queue$'
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = (split_part(channel_name, ':', 2))::uuid
        AND (
          r.host_id = (SELECT auth.uid())
          OR EXISTS (
            SELECT 1 FROM public.room_members m
            WHERE m.room_id = r.id
              AND m.user_id = (SELECT auth.uid())
              AND m.last_seen > now() - interval '45 seconds'
          )
        )
    )
  );
