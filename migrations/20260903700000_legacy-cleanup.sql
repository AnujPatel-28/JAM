-- Migration: Legacy song_requests lockdown (Phase D, docs/013)
-- SCOPE: code + SQL files only, not applied.
-- song_requests is dead (no references in src/) but anon-writable
-- (SELECT + INSERT in 20260821000000; ALL in init schema). Deny API roles;
-- service_role keeps access for any backfill/admin. Table kept (no DROP)
-- to avoid breaking unknown FKs/consumers.
-- ROLLBACK: re-apply policies from 20260821000000_secure-rls-host-auth.sql:106-127.

DROP POLICY IF EXISTS "Public select song_requests" ON public.song_requests;
DROP POLICY IF EXISTS "Public insert song_requests" ON public.song_requests;
DROP POLICY IF EXISTS "Public update song_requests" ON public.song_requests;
DROP POLICY IF EXISTS "Public delete song_requests" ON public.song_requests;
DROP POLICY IF EXISTS "public select song_requests" ON public.song_requests;
DROP POLICY IF EXISTS "anyone can create song_requests" ON public.song_requests;

REVOKE ALL ON public.song_requests FROM anon, authenticated;
