// Display-name normalization + reservation (docs/security-fixes/013, 022/039).
// Complements the DB trigger (enforce_display_name): trigger guards all stored
// names server-side; this folds leet-speak (H0st→host) and warns BEFORE join so
// users aren't silently renamed to Guest mid-session.

const RESERVED = new Set(['host', 'admin', 'administrator', 'moderator', 'mod', 'support', 'system', 'owner']);

const LEET: Record<string, string> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };

export function normalizeDisplayName(name: string): string {
  const nfkc = (name || '').normalize('NFKC');
  const collapsed = nfkc.replace(/[\s\u200B-\u200D\uFEFF]+/g, ' ').trim();
  return collapsed.slice(0, 24);
}

function foldForCompare(name: string): string {
  return normalizeDisplayName(name)
    .toLowerCase()
    .split('')
    .map((c) => LEET[c] ?? c)
    .join('')
    .replace(/[^a-z]/g, '');
}

export function isReservedDisplayName(name: string): boolean {
  const folded = foldForCompare(name);
  if (!folded) return true; // empty/blank is also unusable
  return RESERVED.has(folded);
}

// 022: single choke point — every writer (chat send, song request, join)
// resolves the stored name through here so reserved names can never leak into
// a room, even on paths that forgot the explicit check.
export function safeStoredDisplayName(stored: string): string {
  return isReservedDisplayName(stored) ? 'Guest' : normalizeDisplayName(stored) || 'Guest';
}
