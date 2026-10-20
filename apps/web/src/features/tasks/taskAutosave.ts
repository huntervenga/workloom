import type { TaskDto, UpdateTaskInput } from '@workloom/contracts';
import {
  buildUpdateInput,
  changedKeys,
  draftFromTask,
  rebaseDraft,
  taskDraftKeys,
  type TaskDraft,
  type TaskDraftErrors,
  type TaskDraftKey,
} from './taskDraft';
import type { EditSession } from './useTaskCommands';

/** How a sent field save ended without a confirmed task. */
export type AutosaveFailure = 'unknown' | 'conflict' | 'rejected';
/** `notSent`: the existing writer refused the call before sending, so it may be queued again. */
export type AutosaveOutcome = 'notSent' | AutosaveFailure;

export type AutosavePhase = 'idle' | 'saving' | 'saved' | 'invalid' | AutosaveFailure;

/** One sent field save. Never changed: a Retry may only resend exactly this body. */
export interface AutosaveSubmission {
  readonly keys: readonly TaskDraftKey[];
  /** Frozen; its identity ties the existing mutation's held uncertain command to this save. */
  readonly input: UpdateTaskInput;
  /** The confirmed base with only `keys` applied: what the task becomes on success. */
  readonly draft: TaskDraft;
}

/** One saved task's autosave state. Replaced, never mutated, on every change. */
export interface AutosaveEntry {
  readonly taskId: string;
  /** The last confirmed server task; every guard revision comes from here. */
  readonly base: TaskDto;
  /** Everything shown in the form, including typed text that was not committed yet. */
  readonly draft: TaskDraft;
  /** Committed (blur, Enter, choice) fields waiting to be sent, in commit order. */
  readonly committed: readonly TaskDraftKey[];
  readonly sending: AutosaveSubmission | null;
  /** A save that ended without a confirmed task; it pauses the page's queue until resolved. */
  readonly failed: AutosaveSubmission | null;
  readonly phase: AutosavePhase;
  readonly errors: TaskDraftErrors;
  readonly error: unknown;
}

/** The page's existing write path and guards; the controller never writes by itself. */
export interface AutosaveTransport {
  /** First send of one body through the existing update mutation. */
  send: (taskId: string, input: UpdateTaskInput) => Promise<TaskDto>;
  /** Resends the held uncertain body with its key, or `null` when that body is not the one held. */
  resend: (taskId: string, input: UpdateTaskInput) => Promise<TaskDto> | null;
  /** Read at send time: current scope and no other unresolved task command. */
  canSend: () => boolean;
  classify: (error: unknown) => AutosaveOutcome;
  /** True only for the trusted, confirmed completion prerequisite refusal. */
  completionRefused?: (error:unknown)=>boolean;
  /** Mirrors retained state into the page's edit sessions; `null` once nothing is retained. */
  retain?: (taskId: string, session: EditSession | null) => void;
}

const errorKeys: Record<keyof TaskDraftErrors, readonly TaskDraftKey[]> = {
  title: ['title'],
  description: ['description'],
  startDate: ['startDate'],
  dueDate: ['dueDate'],
  estimate: ['estimate'],
  form: taskDraftKeys,
};

const unique = <T,>(items: readonly T[]): T[] => [...new Set(items)];

/** Fields whose shown value differs from the confirmed task. */
export function unsentKeys(entry: AutosaveEntry): TaskDraftKey[] {
  return changedKeys(draftFromTask(entry.base), entry.draft);
}

/** Raw controlled input may differ before its meaning changes (for example a word separator). */
function bufferedKeys(entry: AutosaveEntry): TaskDraftKey[] {
  const base = draftFromTask(entry.base);
  const changed = new Set(unsentKeys(entry));
  return taskDraftKeys.filter(key => changed.has(key)
    || key === 'title' && entry.draft.title !== base.title
    || key === 'estimate' && entry.draft.estimate !== base.estimate);
}

/** Typed, queued, sending or unresolved input that closing the pane must not lose. */
export function autosaveRetains(entry: AutosaveEntry | undefined): entry is AutosaveEntry {
  return entry !== undefined && (entry.sending !== null || entry.failed !== null || entry.committed.length > 0 || bufferedKeys(entry).length > 0);
}

function freezeInput(input: UpdateTaskInput): UpdateTaskInput {
  const copy = structuredClone(input);
  for (const value of Object.values(copy)) if (Array.isArray(value)) Object.freeze(value);
  return Object.freeze(copy);
}

/** The confirmed base with exactly `keys` taken from the draft; nothing else can leak in. */
function project(baseDraft: TaskDraft, draft: TaskDraft, keys: readonly TaskDraftKey[]): TaskDraft {
  const next: TaskDraft = { ...baseDraft };
  for (const key of keys) {
    const value = draft[key];
    Object.assign(next, { [key]: Array.isArray(value) ? [...value] : value });
  }
  return next;
}

interface Built {
  keys: TaskDraftKey[];
  input: UpdateTaskInput | null;
  draft: TaskDraft;
  errors: TaskDraftErrors;
  /** Committed keys left as unsent input because their value is invalid. */
  invalid: TaskDraftKey[];
}

/** A field-only PATCH through the shared builder; invalid fields stay behind with their errors. */
function build(entry: AutosaveEntry): Built {
  const baseDraft = draftFromTask(entry.base);
  const changed = new Set(changedKeys(baseDraft, entry.draft));
  const wanted = entry.committed.filter((key) => changed.has(key));
  let keys = wanted;
  let errors: TaskDraftErrors = {};
  while (keys.length > 0) {
    const draft = project(baseDraft, entry.draft, keys);
    const result = buildUpdateInput(entry.base, baseDraft, draft);
    if (result.ok) {
      const invalid = wanted.filter((key) => !keys.includes(key));
      const fields = result.input ? Object.keys(result.input).filter((name) => !name.startsWith('expected')) : [];
      return { keys, input: fields.length > 0 ? result.input : null, draft, errors, invalid };
    }
    errors = { ...errors, ...result.errors };
    const bad = new Set(Object.keys(result.errors).flatMap((name) => errorKeys[name as keyof TaskDraftErrors] ?? []));
    const next = keys.filter((key) => !bad.has(key));
    keys = next.length === keys.length ? [] : next;
  }
  return { keys: [], input: null, draft: baseDraft, errors, invalid: wanted };
}

/**
 * Field-level autosave for saved tasks of one page and one actor/workspace scope. Committed
 * fields are queued and sent one PATCH at a time through the existing update mutation, each
 * against the base confirmed by the previous answer. An unknown, conflicting or rejected answer
 * pauses the whole queue; only an explicit Retry or review continues it. Nothing is retried
 * automatically, and a disposed or out-of-scope controller never sends.
 */
export function createTaskAutosave(transport: AutosaveTransport) {
  const entries = new Map<string, AutosaveEntry>();
  const authorized = new Map<string, boolean>();
  const mirrored = new Map<string, EditSession>();
  const editIntents = new Map<string, object>();
  const listeners = new Set<() => void>();
  let order: string[] = [];
  let paused: string | null = null;
  let inFlight = false;
  let disposed = false;
  let writable = true;

  const emit = (taskId: string) => {
    const entry = entries.get(taskId);
    const previous = mirrored.get(taskId);
    if (autosaveRetains(entry)) {
      if (!previous || previous.base !== entry.base || previous.draft !== entry.draft) {
        const session: EditSession = { base: entry.base, draft: entry.draft };
        mirrored.set(taskId, session);
        transport.retain?.(taskId, session);
      }
    } else if (previous) {
      mirrored.delete(taskId);
      transport.retain?.(taskId, null);
    }
    for (const listener of [...listeners]) listener();
  };
  const put = (entry: AutosaveEntry) => {
    entries.set(entry.taskId, entry);
    emit(entry.taskId);
  };
  const enqueue = (taskId: string, front = false) => {
    order = order.filter((id) => id !== taskId);
    order = front ? [taskId, ...order] : [...order, taskId];
  };
  const fresh = (base: TaskDto): AutosaveEntry => ({
    taskId: base.id, base, draft: draftFromTask(base), committed: [], sending: null, failed: null, phase: 'idle', errors: {}, error: null,
  });

  const settle = (taskId: string, submission: AutosaveSubmission, promise: Promise<TaskDto>) => {
    promise.then(
      (task) => {
        inFlight = false;
        if (disposed) return;
        const entry = entries.get(taskId);
        if (!entry || entry.sending !== submission) return pump();
        // Sent fields take the confirmed value unless the user typed something newer meanwhile;
        // other fields keep unsent input and otherwise follow the confirmed task.
        const nextBase = draftFromTask(task);
        const newerThanSent = new Set(changedKeys(submission.draft, entry.draft));
        if (entry.draft.title !== submission.draft.title) newerThanSent.add('title');
        if (entry.draft.estimate !== submission.draft.estimate) newerThanSent.add('estimate');
        const unsentBefore = new Set(bufferedKeys(entry));
        const draft: TaskDraft = { ...nextBase };
        for (const key of taskDraftKeys) {
          const keep = submission.keys.includes(key) ? newerThanSent.has(key) : unsentBefore.has(key);
          if (keep) Object.assign(draft, { [key]: entry.draft[key] });
        }
        const committed = entry.committed;
        const invalid = Object.keys(entry.errors).length > 0;
        put({ ...entry, base: task, draft, committed, sending: null, failed: null, error: null, phase: invalid ? 'invalid' : committed.length > 0 ? 'idle' : 'saved' });
        if (committed.length > 0) enqueue(taskId);
        pump();
      },
      (error: unknown) => {
        inFlight = false;
        if (disposed) return;
        const entry = entries.get(taskId);
        if (!entry || entry.sending !== submission) return;
        const outcome = transport.classify(error);
        if (outcome === 'notSent') {
          // Refused before sending: queued again in front, sent when the page's guards allow.
          put({ ...entry, sending: null, committed: unique([...submission.keys, ...entry.committed]), phase: 'idle' });
          enqueue(taskId, true);
          return;
        }
        if(outcome==='rejected'&&submission.keys.includes('statusId')&&transport.completionRefused?.(error)){
          // No ACK: revert the refused status only. Other typed/committed work remains owned,
          // while required-field edits and the rest of the page queue stay available.
          const newerStatus=entry.draft.statusId!==submission.draft.statusId;
          const draft=newerStatus?entry.draft:{...entry.draft,statusId:draftFromTask(entry.base).statusId};
          const committed=unique([...submission.keys.filter(key=>key!=='statusId'),...entry.committed.filter(key=>key!=='statusId'||newerStatus)]);
          put({...entry,draft,committed,sending:null,failed:null,phase:'rejected',error});
          if(committed.length)enqueue(taskId);
          pump();return;
        }
        paused = taskId;
        put({ ...entry, sending: null, failed: submission, phase: outcome, error });
      },
    );
  };

  const start = (taskId: string, submission: AutosaveSubmission, send: () => Promise<TaskDto>) => {
    inFlight = true;
    let promise: Promise<TaskDto>;
    try {
      promise = send();
    } catch (error) {
      promise = Promise.reject(error);
    }
    settle(taskId, submission, promise);
  };

  function pump(): void {
    if (disposed || !writable || inFlight || paused !== null || !transport.canSend()) return;
    for (const taskId of [...order]) {
      const entry = entries.get(taskId);
      if (!entry || entry.committed.length === 0 || entry.sending || entry.failed) {
        order = order.filter((id) => id !== taskId);
        continue;
      }
      if (authorized.get(taskId) !== true) continue;
      const built = build(entry);
      order = order.filter((id) => id !== taskId);
      // Close/blur may commit a field already in flight. Once its ACK matches the shown value,
      // that queued key is a no-op, not a retained unsaved command.
      const stillChanged = new Set(unsentKeys(entry));
      const normalizedDraft = project(entry.draft, draftFromTask(entry.base), entry.committed.filter(key => !stillChanged.has(key)));
      const leftover = entry.committed.filter((key) => stillChanged.has(key) && !built.keys.includes(key) && !built.invalid.includes(key));
      if (built.input === null) {
        const invalid = built.invalid.length > 0;
        put({ ...entry, draft: normalizedDraft, committed: leftover, errors: built.errors, phase: invalid ? 'invalid' : entry.phase });
        continue;
      }
      const submission: AutosaveSubmission = Object.freeze({ keys: Object.freeze([...built.keys]), input: freezeInput(built.input), draft: built.draft });
      put({ ...entry, draft: normalizedDraft, committed: leftover, sending: submission, errors: built.errors, error: null, phase: 'saving' });
      start(taskId, submission, () => transport.send(taskId, submission.input));
      return;
    }
  }

  /** Typing only: stages the shown value, never sends. A clean entry restarts from `base`. */
  function stage(base: TaskDto, patch: Partial<TaskDraft>): void {
    if (disposed) return;
    const current = entries.get(base.id);
    const from = autosaveRetains(current) ? current : fresh(base);
    const changed = new Set(Object.keys(patch));
    editIntents.set(base.id, {});
    const errors: TaskDraftErrors = Object.fromEntries(Object.entries(from.errors).filter(([key]) => !changed.has(key)));
    const phase = from.phase === 'saved' || (from.phase === 'invalid' && Object.keys(errors).length === 0) ? 'idle' : from.phase;
    put({ ...from, draft: { ...from.draft, ...patch }, errors, phase });
  }

  /** Commits fields (blur, Enter, a choice): they are queued and sent when the page allows. */
  function commit(taskId: string, keys: readonly TaskDraftKey[]): void {
    const entry = entries.get(taskId);
    if (disposed || !entry || keys.length === 0) return;
    const baseDraft = draftFromTask(entry.base);
    const pendingFrom = [baseDraft, entry.sending?.draft, entry.failed?.draft].filter((draft): draft is TaskDraft => draft !== undefined);
    const relevant = keys.filter((key) => pendingFrom.some((from) => changedKeys(from, entry.draft).includes(key)));
    const draft = project(entry.draft, baseDraft, keys.filter(key => !relevant.includes(key)));
    if (relevant.length === 0) {
      put({ ...entry, draft });
      return;
    }
    put({ ...entry, draft, committed: unique([...entry.committed, ...relevant]) });
    enqueue(taskId);
    pump();
  }

  return {
    get: (taskId: string): AutosaveEntry | undefined => entries.get(taskId),
    /** User-edit generation; ACK/cache updates cannot cancel a read started by this intent. */
    editIntent(taskId: string): object {
      let intent = editIntents.get(taskId);
      if (!intent) { intent = {}; editIntents.set(taskId, intent); }
      return intent;
    },
    /** The task whose unresolved save holds the queue, if any. */
    getPaused: (): string | null => paused,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    hasRetained: () => [...entries.values()].some((entry) => autosaveRetains(entry)),
    /** Whether `input` is a body this controller sent; used to tell its own save from other commands. */
    owns: (input: unknown) => [...entries.values()].some((entry) => entry.sending?.input === input || entry.failed?.input === input),
    /** The current right to change this task; sending waits for it, and a revoked right holds the queue. */
    authorize(taskId: string, allowed: boolean) {
      if (authorized.get(taskId) === allowed) return;
      authorized.set(taskId, allowed);
      if (allowed) pump();
    },
    /** The current page right also gates tasks whose pane has closed. */
    setWritable(allowed: boolean) { writable = allowed; if (allowed) pump(); },
    /** Explicit pane close/switch commits the latest staged fields, never a stale form closure. */
    flush(taskId: string) {
      const entry = entries.get(taskId);
      if (!entry || !writable || authorized.get(taskId) !== true) return;
      commit(taskId, bufferedKeys(entry));
    },
    /** Transfers an explicitly rejected legacy command without turning it into a new save. */
    adoptFailure(session: EditSession, input: UpdateTaskInput, error: Error, phase: 'conflict' | 'rejected'): boolean {
      const taskId = session.base.id;
      if (disposed || autosaveRetains(entries.get(taskId))) return false;
      const keys = taskDraftKeys.filter(key => Object.hasOwn(input, key === 'estimate' ? 'estimateMinutes' : key));
      if (keys.length === 0) return false;
      const submission: AutosaveSubmission = Object.freeze({
        keys: Object.freeze(keys), input: freezeInput(input),
        draft: project(draftFromTask(session.base), session.draft, keys),
      });
      paused = taskId;
      put({ ...fresh(session.base), draft: session.draft, failed: submission, phase, error });
      return true;
    },
    stage,
    commit,
    /** A discrete choice is staged and committed at once. */
    choose(base: TaskDto, patch: Partial<TaskDraft>) {
      stage(base, patch);
      commit(base.id, Object.keys(patch) as TaskDraftKey[]);
    },
    /**
     * Explicit recovery. An unknown save is resent exactly as first sent, with its key, through
     * the existing mutation; a rejected one is queued again from the current values.
     */
    retry(taskId: string) {
      const entry = entries.get(taskId);
      if (disposed || !writable || authorized.get(taskId) !== true || inFlight || !entry?.failed) return;
      const failed = entry.failed;
      if (entry.phase === 'unknown') {
        const promise = transport.resend(taskId, failed.input);
        if (promise === null) return;
        paused = null;
        put({ ...entry, sending: failed, failed: null, phase: 'saving', error: null });
        start(taskId, failed, () => promise);
        return;
      }
      if (entry.phase !== 'rejected') return;
      if (paused === taskId) paused = null;
      put({ ...entry, failed: null, committed: unique([...failed.keys, ...entry.committed]), phase: 'idle', error: null });
      enqueue(taskId, true);
      pump();
    },
    /**
     * The explicit review outcome against `latest`: keep mine rebases the draft and queues the
     * user's fields again; take latest drops them. Never for an unknown save, which only Retry ends.
     */
    resolveReview(taskId: string, latest: TaskDto, keepMine: boolean) {
      const entry = entries.get(taskId);
      if (disposed || !entry || entry.sending || entry.phase === 'unknown') return;
      const oldBase = draftFromTask(entry.base);
      const latestDraft = draftFromTask(latest);
      const draft = keepMine ? rebaseDraft(oldBase, entry.draft, latestDraft) : latestDraft;
      const committed = keepMine ? unique([...(entry.failed?.keys ?? []), ...entry.committed]) : [];
      if (paused === taskId) paused = null;
      put({ ...entry, base: latest, draft, committed, failed: null, phase: 'idle', errors: {}, error: null });
      if (committed.length > 0) enqueue(taskId, true);
      pump();
    },
    /** Called when the page's guards may have opened. */
    pump,
    /** The scope ended: nothing queued is ever sent, and late answers are ignored. */
    dispose() {
      disposed = true;
      order = [];
    },
  };
}

export type TaskAutosave = ReturnType<typeof createTaskAutosave>;
