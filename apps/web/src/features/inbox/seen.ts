import { useSyncExternalStore } from 'react';
import type { InboxItemDto } from '@workloom/contracts';

const EVENT = 'workloom:inbox-seen';

const key = (actorId: string, workspaceId: string) => `workloom.inbox.seen.${actorId}.${workspaceId}`;

/** The moment this browser last showed the inbox, as an ISO string; storage may be unavailable, then everything counts as new. */
export function readSeenAt(actorId: string, workspaceId: string): string | null {
  try { return window.localStorage.getItem(key(actorId, workspaceId)); } catch { return null; }
}
export function writeSeenAt(actorId: string, workspaceId: string, at: string): void {
  try { window.localStorage.setItem(key(actorId, workspaceId), at); } catch { /* the badge simply stays until storage works */ }
  window.dispatchEvent(new Event(EVENT));
}

/** The bookmark as a live value, so the sidebar badge clears the moment the inbox page has shown the items. */
export function useSeenAt(actorId: string, workspaceId: string): string | null {
  return useSyncExternalStore(
    listener => { window.addEventListener(EVENT, listener); window.addEventListener('storage', listener); return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', listener); }; },
    () => readSeenAt(actorId, workspaceId),
    () => null,
  );
}

/** Items newer than the bookmark; with no bookmark yet, only items from the last day count, so a first visit is not a wall of "new". */
export function unreadItems(items: readonly InboxItemDto[], seenAt: string | null, now: Date = new Date()): InboxItemDto[] {
  const since = seenAt ?? new Date(now.getTime() - 86_400_000).toISOString();
  return items.filter(item => item.at > since);
}
