/**
 * Client Session Identifier utility.
 * Persists a unique session UUID across reloads so listeners can rejoin without
 * occupying an extra seat in the room's 5-member capacity limit.
 */

const SESSION_STORAGE_KEY = 'wj_session_id';
const DISPLAY_NAME_KEY = 'wj_display_name';

export function getOrCreateSessionId(): string {
  if (typeof window === 'undefined') return '00000000-0000-0000-0000-000000000000';
  
  let sessionId = localStorage.getItem(SESSION_STORAGE_KEY);
  if (!sessionId) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      sessionId = crypto.randomUUID();
    } else {
      // 022: CSPRNG fallback (was Math.random — predictable session ids).
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }
  return sessionId;
}

export function getStoredDisplayName(): string {
  if (typeof window === 'undefined') return 'Guest';
  return localStorage.getItem(DISPLAY_NAME_KEY) || 'Guest';
}

export function setStoredDisplayName(name: string): void {
  if (typeof window === 'undefined') return;
  // Phase D (docs/013): NFKC + collapse whitespace + 24 cap at the sink, so
  // every writer (lobby, room) stores the same canonical form the DB expects.
  const collapsed = (name || '').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ').trim().slice(0, 24);
  if (collapsed) {
    localStorage.setItem(DISPLAY_NAME_KEY, collapsed);
  }
}

// --- Security-hardening: memory-only secrets (never localStorage/sessionStorage) ---
// member_token (C3) proves presence ownership for ping/leave. Room passwords are also
// kept here during the session lifecycle so XSS-readable storage never holds them.
// Module-scoped Map = per-tab memory, cleared on reload/leave. See docs/security-fixes/003-*.

const memberTokenByRoom = new Map<string, string>();
const roomPasswordByCode = new Map<string, string>();

function normalizeRoomKey(key: string): string {
  return key.trim().toUpperCase();
}

export function setMemberToken(roomId: string, token: string): void {
  if (!roomId || !token) return;
  memberTokenByRoom.set(roomId, token);
}

export function getMemberToken(roomId: string | undefined | null): string | null {
  if (!roomId) return null;
  return memberTokenByRoom.get(roomId) ?? null;
}

export function clearMemberToken(roomId: string | undefined | null): void {
  if (!roomId) return;
  memberTokenByRoom.delete(roomId);
}

export function setRoomPasswordMemory(roomCode: string, password: string): void {
  if (!roomCode || !password) return;
  roomPasswordByCode.set(normalizeRoomKey(roomCode), password);
}

export function getRoomPasswordMemory(roomCode: string | undefined | null): string | null {
  if (!roomCode) return null;
  return roomPasswordByCode.get(normalizeRoomKey(roomCode)) ?? null;
}

export function clearRoomPasswordMemory(roomCode: string | undefined | null): void {
  if (!roomCode) return;
  roomPasswordByCode.delete(normalizeRoomKey(roomCode));
}

// 022: sign-out / account-switch hygiene. Rotating the session id releases the
// old presence seat (stale row ages out) and invalidates anything exfiltrated.
export function rotateSessionId(): string {
  if (typeof window === 'undefined') return '00000000-0000-0000-0000-000000000000';
  // Clear first so getOrCreateSessionId() mints a fresh CSPRNG value.
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Private mode: fall through to direct mint.
  }
  clearAllMemberTokens();
  clearAllRoomPasswords();
  return getOrCreateSessionId();
}

export function clearAllMemberTokens(): void {
  memberTokenByRoom.clear();
}

export function clearAllRoomPasswords(): void {
  roomPasswordByCode.clear();
}
