import { useSyncExternalStore } from 'react';
import data from './changelog.json';

/**
 * What's new: a plain-words log of changes users can notice, newest day first. Entries live in
 * changelog.json and are written with the change; `covers` is the newest main commit the log
 * accounts for, so `npm run changelog:draft` can list the commits that still need an entry.
 */
export interface ChangelogDay {
  /** Calendar day of the change, YYYY-MM-DD. */
  date: string;
  /** Optional heading for a summary day, such as the launch. */
  title?: string;
  items: readonly string[];
}

export interface Changelog {
  covers: string;
  days: readonly ChangelogDay[];
}

export const CHANGELOG: Changelog = data;

/** Identifies the newest entry; it changes when a new day is added or the newest day gains an item. */
export function changelogMarker(log: Changelog = CHANGELOG): string | null {
  const newest = log.days[0];
  return newest ? `${newest.date}:${newest.items.length}` : null;
}

/**
 * Days added since the marker was taken: later days, and the newest day when it has gained items.
 * With no marker only the newest day counts, so a first visit is not a wall of "new".
 */
export function newDays(log: Changelog, marker: string | null): readonly ChangelogDay[] {
  if (marker === changelogMarker(log)) return [];
  const date = marker?.split(':')[0];
  if (!date) return log.days.slice(0, 1);
  return log.days.filter((day, index) => day.date > date || (index === 0 && day.date === date));
}

const EVENT = 'workloom:whats-new';
const seenKey = (actorId: string) => `workloom.whatsNew.seen.${actorId}`;
const dismissedKey = (actorId: string) => `workloom.whatsNew.dismissed.${actorId}`;

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* the note simply shows again until storage works */ }
  window.dispatchEvent(new Event(EVENT));
}
function useStored(key: string): string | null {
  return useSyncExternalStore(
    listener => { window.addEventListener(EVENT, listener); window.addEventListener('storage', listener); return () => { window.removeEventListener(EVENT, listener); window.removeEventListener('storage', listener); }; },
    () => read(key),
    () => null,
  );
}

/** The marker this browser last showed the What's new page at, for this person. */
export function readChangelogSeen(actorId: string): string | null { return read(seenKey(actorId)); }
export function markChangelogSeen(actorId: string, marker: string | null = changelogMarker()): void { if (marker) write(seenKey(actorId), marker); }
/** "Not now" hides the note until the next new entry; the sidebar dot stays until the page is opened. */
export function dismissChangelogNote(actorId: string, marker: string | null = changelogMarker()): void { if (marker) write(dismissedKey(actorId), marker); }

export interface ChangelogState {
  /** Something in the log has not been shown on the page yet. */
  unseen: boolean;
  /** The note offering to open the page should show. */
  note: boolean;
}

export function useChangelogState(actorId: string, log: Changelog = CHANGELOG): ChangelogState {
  const seen = useStored(seenKey(actorId));
  const dismissed = useStored(dismissedKey(actorId));
  const marker = changelogMarker(log);
  const unseen = marker !== null && marker !== seen;
  return { unseen, note: unseen && marker !== dismissed };
}
