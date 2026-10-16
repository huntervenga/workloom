import type { RefObject } from 'react';
import { changedKeys, draftFromTask } from './taskDraft';
import type { CreateSession, EditSession } from './useTaskCommands';

/** Notify after every supported Map mutation, without replacing session objects or Map semantics. */
class SessionMap extends Map<string, EditSession> {
  constructor(private readonly changed: () => void) { super(); }
  override set(key: string, value: EditSession): this { super.set(key, value); this.changed(); return this; }
  override delete(key: string): boolean { const deleted = super.delete(key); if (deleted) this.changed(); return deleted; }
  override clear(): void { if (this.size === 0) return; super.clear(); this.changed(); }
}

/**
 * One page's real retained task sessions. Edit snapshots are compared semantically. A nonnull
 * create slot is the existing writer contract for a retained unsent or unconfirmed create;
 * its original status choice must not be guessed from its current fields. Pristine forms
 * leave that slot null. Pending/unknown commands have their own independent registry.
 */
export function createRetainedTaskSessions() {
  let create: CreateSession | null = null;
  let dirty = false;
  const listeners = new Set<() => void>();
  const edits = new SessionMap(refresh);
  function refresh() {
    const next = create !== null || [...edits.values()].some(session => changedKeys(draftFromTask(session.base), session.draft).length > 0);
    if (next === dirty) return;
    dirty = next;
    for (const listener of listeners) listener();
  }
  const createSession: RefObject<CreateSession | null> = {
    get current() { return create; },
    set current(value) { create = value; refresh(); },
  };
  const editSessions: RefObject<Map<string, EditSession>> = { current: edits };
  return {
    createSession, editSessions,
    getSnapshot: () => dirty,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
