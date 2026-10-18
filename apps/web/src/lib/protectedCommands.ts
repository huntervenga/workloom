import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';

/** One write hook's slot in the registry. */
export interface ProtectedCommandEntry {
  /** True while the hook's command is being sent or its outcome is unknown. */
  set: (active: boolean) => void;
  /** The hook unmounted; later updates are ignored. */
  dispose: () => void;
  /**
   * True while any slot other than this one holds a pending or uncertain command. After dispose
   * this slot is no longer active, so every remaining active slot counts as another.
   */
  hasOthers: () => boolean;
}

/** Asks the user whether to leave anyway; resolves true to leave. */
export type DepartureConfirmation = () => Promise<boolean>;

interface Slot {
  disposed: boolean;
}

/**
 * Every write hook of one QueryClient that holds a command still being sent or with an unknown
 * outcome. Leaving the page (or switching the actor) discards such a command, so a guard asks
 * first. Nothing here is persisted; the entries live as long as the hooks that own them.
 */
export class ProtectedCommandRegistry {
  private readonly slots = new Set<Slot>();
  private readonly active = new Set<Slot>();
  private readonly listeners = new Set<() => void>();
  private confirmer: DepartureConfirmation | null = null;

  /** True while any registered hook holds a pending or uncertain command. */
  get protecting(): boolean {
    return this.active.size > 0;
  }

  register(): ProtectedCommandEntry {
    const slot: Slot = { disposed: false };
    this.slots.add(slot);
    return {
      set: (active) => {
        if (!slot.disposed) this.update(slot, active);
      },
      dispose: () => {
        if (slot.disposed) return;
        slot.disposed = true;
        this.slots.delete(slot);
        this.update(slot, false);
      },
      hasOthers: () => this.active.size > (this.active.has(slot) ? 1 : 0),
    };
  }

  /**
   * Forgets every entry, e.g. when the actor changed: the previous actor's commands must not
   * hold back the cleanup that leaves its screens.
   */
  clear(): void {
    for (const slot of this.slots) slot.disposed = true;
    this.slots.clear();
    if (this.active.size === 0) return;
    this.active.clear();
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): boolean => this.protecting;

  /** Installed by the mounted navigation guard; returns the uninstaller. */
  setConfirmer(confirmer: DepartureConfirmation): () => void {
    this.confirmer = confirmer;
    return () => {
      if (this.confirmer === confirmer) this.confirmer = null;
    };
  }

  /** Resolves true when nothing is protected or the user chose to leave. Without a guard nothing asks. */
  confirmDeparture(): Promise<boolean> {
    if (!this.protecting || this.confirmer === null) return Promise.resolve(true);
    return this.confirmer();
  }

  private update(slot: Slot, active: boolean): void {
    const before = this.protecting;
    if (active) this.active.add(slot);
    else this.active.delete(slot);
    if (before !== this.protecting) this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const registries = new WeakMap<QueryClient, ProtectedCommandRegistry>();

function meActorId(data: unknown): string | null {
  const actor = (data as { actor?: { id?: unknown } } | undefined)?.actor;
  return typeof actor?.id === 'string' ? actor.id : null;
}

/** The registry of this QueryClient, which is the scope of every cached and recorded write. */
export function protectedCommandsFor(queryClient: QueryClient): ProtectedCommandRegistry {
  const known = registries.get(queryClient);
  if (known) return known;

  const registry = new ProtectedCommandRegistry();
  registries.set(queryClient, registry);
  // The server may report another actor at any time (e.g. a switch in another tab). The shell then
  // drops the previous actor's data and leaves its routes; its commands must not block that.
  let actorId = meActorId(queryClient.getQueryData(queryKeys.me));
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryKey[0] !== queryKeys.me[0]) return;
    const next = meActorId(event.query.state.data);
    if (next === null) return;
    if (actorId !== null && actorId !== next) registry.clear();
    actorId = next;
  });
  return registry;
}
