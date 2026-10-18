import { createTagInputSchema, type TagDto } from '@workloom/contracts';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isUncertainOutcome } from '../../lib/api';
import { PendingCommandError } from '../../lib/idempotency';
import type { CreateTagVariables, useCreateTagMutation } from './queries';

/**
 * Inline tag creation from a task picker. Creating the workspace tag and selecting it for the
 * task are two separate steps: a confirmed tag is only added to the owner's local draft, which
 * the person still saves explicitly. The page-owned `commands.createTag` is the only writer.
 */

/** The draft a tag is created from: `edit:…` for a saved task's inline editor, `create:…` for a new row. */
export interface InlineTagOrigin {
  id: string;
  /** The saved task, or null for a task being created. */
  taskId: string | null;
  /** Shown in recovery; captured once when the create starts. */
  label: string;
}

/**
 * The exact command: the body and key never change, so a retry resends both unchanged. The origin
 * marker sits outside `input`, so it is never sent and never part of the request fingerprint.
 */
export type InlineTagCreateVariables = CreateTagVariables & {
  input: { name: string; color: null };
  idempotencyKey: string;
  inlineTagOriginId: string;
};

/** Whether a create command was started inline; the details dialog then leaves it to its origin. */
export function isInlineTagCreateCommand(variables: unknown): variables is InlineTagCreateVariables {
  if (typeof variables !== 'object' || variables === null) return false;
  const candidate = variables as Partial<InlineTagCreateVariables>;
  return typeof candidate.inlineTagOriginId === 'string' && typeof candidate.input === 'object' && candidate.input !== null;
}

export type InlineTagCreateStatus = 'pending' | 'unknown' | 'rejected' | 'created';

/** A read-only view of the one current attempt. */
export interface InlineTagAttemptView {
  origin: InlineTagOrigin;
  name: string;
  status: InlineTagCreateStatus;
  /** The definitive or uncertain failure of the last send. */
  error: Error | null;
  tag: TagDto | null;
  /** After creation: whether the tag was added to its original draft. */
  added: boolean | null;
  /** The person continued the draft without this tag: an answer only reaches the catalog. */
  catalogOnly: boolean;
}

export type InlineTagStartResult = 'started' | 'blank' | 'tooLong' | 'exists' | 'archived' | 'denied' | 'readonly' | 'busy';

type CreateTagMutation = ReturnType<typeof useCreateTagMutation>;

export interface LeaseTarget {
  /** The origin this committed target belongs to; an answer for another origin never reaches it. */
  originId: string;
  canAttach: boolean;
  onSelect: (tag: TagDto) => void;
  /** Clears the search of the binding that owns this lease, if it still shows the created name. */
  onAttached: (name: string) => void;
}

/** One mounted binding for one origin; a remount or another origin is a different lease. */
interface Lease {
  originId: string;
  active: boolean;
  target: { current: LeaseTarget };
}

interface Attempt {
  scope: object;
  origin: InlineTagOrigin;
  variables: InlineTagCreateVariables;
  lease: Lease;
  status: InlineTagCreateStatus;
  error: Error | null;
  tag: TagDto | null;
  added: boolean | null;
  /** Set once by an explicit continue and never cleared for this attempt. */
  catalogOnly: boolean;
}

const casefold = (name: string) => name.trim().toLowerCase();

/** The page-lifetime controller; its identity never changes, only its scope and current attempt. */
export interface InlineTagController {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
  /** The current attempt of this actor and workspace, if any. */
  current: () => InlineTagAttemptView | null;
  /** Whether another create (details, or another origin) is being sent or has no answer. */
  busyFor: (originId: string) => boolean;
  /** The origin's own create is being sent or unknown, so its owner does not submit yet. */
  isHeld: (originId: string) => boolean;
  canCreate: () => boolean;
  canRetry: () => boolean;
  /** Resends the unknown or rejected-by-transport command exactly as first sent. Explicit only. */
  retry: () => boolean;
  /** Forgets a definitive outcome; an unknown or pending command cannot be dismissed. */
  dismiss: () => boolean;
  /**
   * Whether the unknown attempt may release its original draft. With an origin ID: only that
   * origin with an active mounted owner. Without: only while no owner of the origin is mounted.
   */
  canContinueWithoutTag: (originId?: string) => boolean;
  /** Releases the original draft; the command stays unknown and retryable but never selects the tag. */
  continueWithoutTag: (originId?: string) => boolean;
  /** @internal for bindings */
  lease: (originId: string, target: { current: LeaseTarget }) => { lease: Lease; release: () => void };
  /** @internal for bindings */
  start: (origin: InlineTagOrigin, name: string, tags: readonly TagDto[], lease: Lease | null) => InlineTagStartResult;
  /** @internal latest render inputs */
  sync: (inputs: SyncInputs) => void;
  /** @internal */
  notify: () => void;
}

interface SyncInputs {
  mutation: CreateTagMutation;
  onCreated: (tag: TagDto) => void;
  canCreateTags: boolean;
  scopeKey: string;
}

function createInlineTagController(): InlineTagController {
  let version = 0;
  const listeners = new Set<() => void>();
  let latest: SyncInputs | null = null;
  let scopeKey: string | null = null;
  let scope: object = {};
  let attempt: Attempt | null = null;
  const leases = new Map<string, Lease>();
  // Answers synchronously, before React re-renders: a second press in the same tick is refused.
  let sending = false;

  const notify = () => { version += 1; for (const listener of listeners) listener(); };
  const unresolved = (status: InlineTagCreateStatus) => status === 'pending' || status === 'unknown';
  const own = (variables: unknown) => attempt !== null && variables === attempt.variables;
  /** A create command of the shared mutation that is not the current inline attempt. */
  const foreignCommand = () => {
    const mutation = latest?.mutation;
    if (!mutation) return false;
    const pending = mutation.pendingCommand?.variables;
    const uncertain = mutation.uncertain?.variables;
    return (pending !== undefined && !own(pending)) || (uncertain !== undefined && !own(uncertain));
  };
  const view = (entry: Attempt): InlineTagAttemptView => ({
    origin: entry.origin, name: entry.variables.input.name, status: entry.status, error: entry.error, tag: entry.tag, added: entry.added,
    catalogOnly: entry.catalogOnly,
  });
  /** The current unknown attempt that still holds its original draft. */
  const detachable = () => (attempt !== null && attempt.scope === scope && attempt.status === 'unknown' && !attempt.catalogOnly ? attempt : null);
  // Not gated by the role: continuing writes nothing, so a lost permission never traps the draft.
  const canContinueWithoutTag = (originId?: string) => {
    const entry = detachable();
    if (!entry) return false;
    const owner = leases.get(entry.origin.id);
    // The page notice never releases a draft whose owner is mounted, even a remount of it.
    if (originId === undefined) return owner === undefined || !owner.active;
    return originId === entry.origin.id && owner !== undefined && owner.active && owner.originId === originId;
  };

  const send = (entry: Attempt) => {
    const mutation = latest?.mutation;
    if (!mutation) return;
    const retrying = entry.status === 'unknown';
    sending = true;
    entry.status = 'pending';
    entry.error = null;
    notify();
    // The same object every time: the same body and the same Idempotency-Key.
    mutation.mutateAsync(entry.variables).then(tag => {
      // An answer for another actor or workspace never reaches this one's catalog or drafts.
      if (entry.scope !== scope || attempt !== entry) return;
      entry.status = 'created';
      entry.tag = tag;
      latest?.onCreated(tag);
      const lease = entry.lease;
      const target = lease.target.current;
      // Only the very mount that asked, whose committed target still shows the same origin and may edit.
      // A draft that continued without the tag never takes it back, whatever the role or lease now.
      const live = !entry.catalogOnly && lease.active && leases.get(entry.origin.id) === lease && lease.originId === entry.origin.id
        && target.originId === entry.origin.id && latest?.canCreateTags === true && target.canAttach;
      entry.added = live;
      if (live) {
        target.onSelect(tag);
        target.onAttached(entry.variables.input.name);
      }
    }, (error: unknown) => {
      if (entry.scope !== scope || attempt !== entry) return;
      if (error instanceof PendingCommandError) {
        // Refused before sending: another create got there first. Nothing new was sent, so a
        // retried command stays unknown and a first one is forgotten with its search intact.
        if (retrying) entry.status = 'unknown';
        else attempt = null;
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      entry.error = failure;
      entry.status = isUncertainOutcome(failure) ? 'unknown' : 'rejected';
      // The details dialog shares the mutation; it must not show this inline failure as its own.
      if (entry.status === 'rejected') latest?.mutation.reset();
    }).finally(() => {
      // An old actor's or workspace's send never releases the guard of the current scope.
      if (entry.scope === scope) sending = false;
      notify();
    });
  };

  // A lost permission blocks the resend; so does any other create still in flight or unknown.
  const canRetry = () => attempt !== null && attempt.scope === scope && attempt.status === 'unknown' && !sending && latest?.canCreateTags === true
    && latest.mutation.pendingCommand === null && !foreignCommand();

  return {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => version,
    current: () => (attempt && attempt.scope === scope ? view(attempt) : null),
    busyFor: originId => {
      if (foreignCommand()) return true;
      // A continued attempt blocks every new create, its own origin's too, until it is resolved.
      return attempt !== null && attempt.scope === scope && unresolved(attempt.status) && (attempt.origin.id !== originId || attempt.catalogOnly);
    },
    isHeld: originId => attempt !== null && attempt.scope === scope && attempt.origin.id === originId && unresolved(attempt.status) && !attempt.catalogOnly,
    canCreate: () => latest?.canCreateTags === true,
    canRetry,
    retry: () => {
      if (!canRetry() || !attempt) return false;
      send(attempt);
      return true;
    },
    dismiss: () => {
      if (!attempt || unresolved(attempt.status)) return false;
      attempt = null;
      notify();
      return true;
    },
    canContinueWithoutTag,
    continueWithoutTag: originId => {
      const entry = detachable();
      if (!entry || !canContinueWithoutTag(originId)) return false;
      // Nothing is sent and the command is kept as is: same body, same key, still retryable.
      entry.catalogOnly = true;
      notify();
      return true;
    },
    lease: (originId, target) => {
      const before = canContinueWithoutTag();
      const lease: Lease = { originId, active: true, target };
      leases.set(originId, lease);
      // The page notice offers continuing only while no owner is mounted; tell it when that flips.
      if (canContinueWithoutTag() !== before) notify();
      return {
        lease,
        release: () => {
          const wasGlobal = canContinueWithoutTag();
          lease.active = false;
          if (leases.get(originId) === lease) leases.delete(originId);
          if (canContinueWithoutTag() !== wasGlobal) notify();
        },
      };
    },
    start: (origin, name, tags, lease) => {
      const trimmed = name.trim();
      if (latest === null || latest.canCreateTags !== true) return 'denied';
      if (trimmed === '') return 'blank';
      const input = { name: trimmed, color: null };
      if (!createTagInputSchema.safeParse(input).success) return 'tooLong';
      // Archived tags count too: the server keeps names unique per workspace.
      const namesake = tags.find(tag => casefold(tag.name) === casefold(trimmed))
        ?? (attempt?.scope === scope && attempt.tag && casefold(attempt.tag.name) === casefold(trimmed) ? attempt.tag : undefined);
      if (namesake) return namesake.archivedAt === null ? 'exists' : 'archived';
      if (sending || foreignCommand() || (attempt !== null && attempt.scope === scope && unresolved(attempt.status))) return 'busy';
      if (lease === null || !lease.active || lease.originId !== origin.id || lease.target.current.originId !== origin.id) return 'busy';
      // A read-only or stale owner cannot take the tag, so it starts nothing, whatever the role.
      if (!lease.target.current.canAttach) return 'readonly';
      if (latest.mutation.pendingCommand !== null || latest.mutation.uncertain !== null) return 'busy';
      const entry: Attempt = {
        scope,
        origin: { id: origin.id, taskId: origin.taskId, label: origin.label },
        variables: { input, idempotencyKey: crypto.randomUUID(), inlineTagOriginId: origin.id },
        lease,
        status: 'pending',
        error: null,
        tag: null,
        added: null,
        catalogOnly: false,
      };
      attempt = entry;
      send(entry);
      return 'started';
    },
    sync: inputs => {
      latest = inputs;
      if (scopeKey === inputs.scopeKey) return;
      // Another actor or workspace starts empty; the old attempt's answer is ignored by scope.
      scopeKey = inputs.scopeKey;
      scope = {};
      attempt = null;
      sending = false;
    },
    notify,
  };
}

/**
 * The page-owned controller. Latest mutation, callback and permission are read at use time, as
 * the hook objects change on every render; the controller itself keeps one identity.
 */
export function useInlineTagCreation(mutation: CreateTagMutation, onCreated: (tag: TagDto) => void, canCreateTags: boolean, scopeKey: string): InlineTagController {
  const [controller] = useState(createInlineTagController);
  controller.sync({ mutation, onCreated, canCreateTags, scopeKey });
  // A scope switch during render stays silent there; subscribers hear about it after commit.
  useEffect(() => { controller.notify(); }, [controller, scopeKey]);
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return controller;
}

export interface InlineTagCreateBinding {
  origin: InlineTagOrigin;
  /** The current role may create workspace tags. */
  canCreate: boolean;
  /** This owner may take a confirmed tag into its draft now; otherwise nothing is sent. */
  canAttach: boolean;
  /** This origin's own create is being sent or unknown: its owner must not submit. */
  held: boolean;
  /** Another create of the page is unresolved, so this one cannot start. */
  busy: boolean;
  /** The current attempt when it was started from this origin. */
  own: InlineTagAttemptView | null;
  /** An unresolved attempt started elsewhere. */
  foreign: InlineTagAttemptView | null;
  canRetry: boolean;
  /** This owner's own unknown attempt may release the draft, whatever the role. */
  canContinue: boolean;
  search: string;
  setSearch: (value: string) => void;
  create: (name: string, tags: readonly TagDto[]) => InlineTagStartResult;
  retry: () => boolean;
  dismiss: () => boolean;
  continueWithoutTag: () => boolean;
}

export interface InlineTagBindingOptions {
  origin: InlineTagOrigin;
  canAttach: boolean;
  onSelect: (tag: TagDto) => void;
}

/**
 * One mounted picker owner. Its lease is tied to this mount and this origin ID: a remount, a new
 * buffer or another revision gets a new lease, so a late answer only reaches the catalog.
 */
export function useInlineTagCreateBinding(controller: InlineTagController, { origin, canAttach, onSelect }: InlineTagBindingOptions): InlineTagCreateBinding {
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [searchState, setSearchState] = useState({ originId: origin.id, value: '' });
  const search = searchState.originId === origin.id ? searchState.value : '';
  const target = useRef<LeaseTarget>({ originId: origin.id, canAttach, onSelect, onAttached: () => undefined });
  const lease = useRef<Lease | null>(null);
  // Published on commit, never during render: an answer between a render and its commit still
  // reaches the target of the mount and origin that asked, or none at all.
  useLayoutEffect(() => {
    const originId = origin.id;
    target.current = {
      originId, canAttach, onSelect,
      // A search typed since the create started is the person's newer intent and stays.
      onAttached: name => setSearchState(current => current.originId === originId && casefold(current.value) === casefold(name) ? { originId, value: '' } : current),
    };
  });
  useLayoutEffect(() => {
    const held = controller.lease(origin.id, target);
    lease.current = held.lease;
    return () => {
      held.release();
      if (lease.current === held.lease) lease.current = null;
    };
  }, [controller, origin.id]);
  const current = controller.current();
  const own = current?.origin.id === origin.id ? current : null;
  const foreign = current !== null && own === null && (current.status === 'pending' || current.status === 'unknown') ? current : null;
  return {
    origin,
    canCreate: controller.canCreate(),
    canAttach,
    held: controller.isHeld(origin.id),
    busy: controller.busyFor(origin.id),
    own,
    foreign,
    canRetry: own !== null && controller.canRetry(),
    canContinue: own !== null && controller.canContinueWithoutTag(origin.id),
    search,
    setSearch: value => setSearchState({ originId: origin.id, value }),
    create: (name, tags) => controller.start(origin, name, tags, lease.current),
    retry: () => (own !== null ? controller.retry() : false),
    dismiss: () => (own !== null ? controller.dismiss() : false),
    // Rechecked when pressed: only this mounted owner, for its own origin's attempt.
    continueWithoutTag: () => (own !== null && lease.current !== null && lease.current.active ? controller.continueWithoutTag(origin.id) : false),
  };
}
