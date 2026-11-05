import { useEffect, useSyncExternalStore } from 'react';
import { isUuid } from '../../lib/format';

export type ShortcutKind = 'project' | 'task' | 'report';
export interface WorkReference { kind: ShortcutKind; id: string }
interface Shortcuts { recent: WorkReference[]; pinned: WorkReference[] }
const EVENT = 'workloom:shortcuts';
const LIMIT = 10;
const EMPTY: Shortcuts = { recent: [], pinned: [] };
const storageKey = (actorId: string, workspaceId: string) => `workloom.shortcuts.v1.${actorId}.${workspaceId}`;
export const referenceKey = (ref: WorkReference) => `${ref.kind}:${ref.id}`;

function validRef(value: unknown): value is WorkReference {
  if (!value || typeof value !== 'object' || !('kind' in value) || !('id' in value)) return false;
  return (value.kind === 'project' || value.kind === 'task' || value.kind === 'report') &&
    typeof value.id === 'string' && isUuid(value.id);
}
function read(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function decode(value: string | null): Shortcuts {
  if (value === null) return EMPTY;
  try {
    const parsed = JSON.parse(value) as Partial<Shortcuts> | null;
    return {
      recent: Array.isArray(parsed?.recent) ? parsed.recent.filter(validRef).slice(0, LIMIT) : [],
      pinned: Array.isArray(parsed?.pinned) ? parsed.pinned.filter(validRef).slice(0, LIMIT) : [],
    };
  } catch { return EMPTY; }
}
function write(key: string, value: Shortcuts) {
  const data = JSON.stringify(value);
  if (data === read(key)) return;
  try { window.localStorage.setItem(key, data); } catch { return; }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener(EVENT, listener);
  };
}
function promote(list: WorkReference[], ref: WorkReference): WorkReference[] {
  return [ref, ...list.filter(item => referenceKey(item) !== referenceKey(ref))].slice(0, LIMIT);
}

export function useWorkShortcuts(actorId: string, workspaceId: string) {
  const key = storageKey(actorId, workspaceId);
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  return decode(raw);
}

export function useRememberWork(actorId: string, workspaceId: string, kind: ShortcutKind, id: string | null) {
  useEffect(() => {
    if (!id || !isUuid(id)) return;
    const key = storageKey(actorId, workspaceId);
    const before = decode(read(key));
    write(key, { ...before, recent: promote(before.recent, { kind, id }) });
  }, [actorId, workspaceId, kind, id]);
}

export function togglePinnedWork(actorId: string, workspaceId: string, ref: WorkReference) {
  const key = storageKey(actorId, workspaceId);
  const before = decode(read(key));
  const rest = before.pinned.filter(item => referenceKey(item) !== referenceKey(ref));
  write(key, { ...before, pinned: rest.length === before.pinned.length ? promote(rest, ref) : rest });
}
