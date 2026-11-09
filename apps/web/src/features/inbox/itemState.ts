import { useSyncExternalStore } from 'react';
import type { InboxItemDto } from '@workloom/contracts';

export interface InboxItemState {
  unread?: boolean;
  saved?: boolean;
  archived?: boolean;
}
type InboxState = Record<string, InboxItemState>;
const EVENT = 'workloom:inbox-item-state';
const key = (actorId: string, workspaceId: string) => `workloom.inbox.items.v1.${actorId}.${workspaceId}`;
const itemKey = (item: InboxItemDto) => `${item.kind}:${item.id}:${item.task?.id ?? ''}`;

function read(storageKey: string) {
  try { return window.localStorage.getItem(storageKey); } catch { return null; }
}
function decode(raw: string | null): InboxState {
  try {
    const state: unknown = raw ? JSON.parse(raw) : null;
    if (state && typeof state === 'object' && !Array.isArray(state)) return state as InboxState;
  } catch { /* An unreadable local preference is equivalent to no preference. */ }
  return {};
}
function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

export function useInboxItemStates(actorId: string, workspaceId: string) {
  const storageKey = key(actorId, workspaceId);
  const raw = useSyncExternalStore(subscribe, () => read(storageKey), () => null);
  return decode(raw);
}

export function inboxItemState(state: InboxState, item: InboxItemDto): InboxItemState {
  return state[itemKey(item)] ?? {};
}

export function updateInboxItemState(actorId: string, workspaceId: string, item: InboxItemDto, patch: InboxItemState) {
  const storageKey = key(actorId, workspaceId), id = itemKey(item);
  const previous = decode(read(storageKey));
  const next = [[id, { ...previous[id], ...patch }], ...Object.entries(previous).filter(([other]) => other !== id)].slice(0, 400);
  try { window.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(next))); } catch { return; }
  window.dispatchEvent(new Event(EVENT));
}
