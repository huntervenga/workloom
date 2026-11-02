/**
 * Change sequences this browser's own writes committed, as reported by the server in `x-workloom-change-seq`
 * ("<workspaceId>:<seq>[,…]"). Live refresh uses them to tell a head that only moved because of our own writes
 * (the write path already refreshed what it touched) from one that also holds somebody else's change.
 */
const MAX_PER_WORKSPACE = 500;
const MAX_SPAN = 200;
const own = new Map<string, Set<string>>();

export function recordOwnChanges(header: string | null): void {
  if (!header) return;
  for (const part of header.split(',')) {
    const [workspaceId, seq] = part.trim().split(':');
    if (!workspaceId || !seq || !/^\d{1,18}$/.test(seq)) continue;
    const key = workspaceId.toLowerCase();
    const seen = own.get(key) ?? new Set<string>();
    seen.add(seq);
    if (seen.size > MAX_PER_WORKSPACE) seen.delete(seen.values().next().value as string);
    own.set(key, seen);
  }
}

/** True when every sequence in (from, to] is known to be this browser's own write. */
export function ownChangesCover(workspaceId: string, from: string, to: string): boolean {
  let start: bigint;
  let end: bigint;
  try { start = BigInt(from) + 1n; end = BigInt(to); } catch { return false; }
  if (end < start || end - start >= BigInt(MAX_SPAN)) return false;
  const seen = own.get(workspaceId.toLowerCase());
  if (!seen) return false;
  for (let seq = start; seq <= end; seq += 1n) if (!seen.has(seq.toString())) return false;
  return true;
}

export function resetOwnChangesForTests(): void { own.clear(); }
