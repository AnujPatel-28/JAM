-- Migration: Drop legacy insecure RPC overloads (live-matrix finding, docs/010)
-- SCOPE: code + SQL files only unless applied to staging with the others.
-- Why: adding `p_member_token TEXT DEFAULT NULL` via CREATE OR REPLACE created a
-- SECOND overload; Postgres keeps the old signature. Consequence found live on
-- staging: old leave_room(uuid,uuid) / ping(uuid,uuid) / request_song(7 args) /
-- toggle(uuid,uuid) still callable, and PostgREST returns PGRST203 (ambiguous)
-- for some calls. The old signatures are the pre-token insecure versions.
-- ROLLBACK: re-apply the superseded definitions from 20260903100000 (request/
-- toggle) and 20260903000000 (ping/leave). No data change (functions only).

DROP FUNCTION IF EXISTS public.leave_room(UUID, UUID);
DROP FUNCTION IF EXISTS public.ping_room_presence(UUID, UUID);
DROP FUNCTION IF EXISTS public.request_song(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.toggle_upvote_song(UUID, UUID);
