import type { CreateTaskInput, TagDto, TaskDto, TaskWorkScope } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { createRetainedTaskSessions } from './retainedTaskSessions';
import {
  useBulkUpdateTasksMutation,
  useArchiveTaskMutation,
  useCreateTagMutation,
  useCreateTaskMutation,
  useMoveTaskMutation,
  useRestoreTaskMutation,
  useUpdateTaskMutation,
} from './queries';
import type { InitialTaskCellsDraft } from './InitialTaskCells';
import type { InitialCreateExtras, TaskDraft } from './taskDraft';
import { hasQuickInitialCells, quickSessionHasValues, type TaskInlineField } from './tableEditing';

/** A place right before or after an existing task of the same list. */
export interface TaskInsertion {
  anchorTaskId: string;
  placement: 'before' | 'after';
}

/** The task an earlier queued create becomes; its ID is known only once that create is confirmed. */
export interface CreateResultAnchor {
  taskId: string | null;
  /** Relative to `taskId`, after unless a discarded predecessor handed on its own place. */
  placement?: TaskInsertion['placement'];
}

/** Where a new task goes: a section (or none) and, for a subtask, its parent as listed. */
export interface CreateRequest {
  sectionId: string | null;
  parent: TaskDto | null;
  /** The row the person continued from; the new task is placed right next to it. */
  insertion?: TaskInsertion;
  /** A queued create from the same row that this one follows; it wins over `insertion` once known. */
  insertionAnchor?: CreateResultAnchor;
  /**
   * Row-local, never sent: a row without an anchor (a parent's first child) whose first task goes
   * in by the body alone and whose next tasks each follow the one before, like an inserted row.
   */
  continueInPlace?: boolean;
  /**
   * Row-local, never sent: the assignee of the group the row was explicitly opened in. A new
   * draft starts with it; only the draft's own assignee is sent, and the server checks it.
   */
  defaultResponsibleMembershipId?: string | null;
}

/** The create body as sent, including its resolved place when the row had one. */
export type QuickCreateInput = CreateTaskInput & { insertion?: TaskInsertion };

export interface CreateSession {
  request: CreateRequest;
  draft: TaskDraft;
  workScope: TaskWorkScope;
  /** Quick creation keeps recovery in its original inline form while a command is unresolved. */
  origin?: 'quick';
  /** Stable key of the unsaved or submitted table row for this draft. */
  clientId?: string;
  /** The status a fresh quick row started with, so choosing another one counts as a draft value. */
  baseStatusId?: string;
  /** Custom field values and hours staged in the quick row; replaced, never mutated, on each edit. */
  initialCells?: InitialTaskCellsDraft;
}

interface QuickCreateEntry {
  session: CreateSession;
  /** The validated draft snapshot; never changed after it is queued. */
  input: CreateTaskInput;
  /** Extras created atomically with the task, cloned at enqueue; absent keeps the existing create. */
  initial?: InitialCreateExtras;
  onCreated: (task: TaskDto) => void;
  /** Filled with the confirmed task, so the next create from this row can follow it. */
  resultAnchor: CreateResultAnchor;
  /** The exact first body; every retry sends it again under the same key. */
  sent?: QuickCreateInput;
}

/**
 * The body for a queued create, placed where its row asked, or null while the earlier create it
 * follows has no confirmed task: a position is never guessed. Unplaced input is returned as is;
 * row-local request flags never reach the body.
 */
export function resolveQuickCreateInput(entry: Pick<QuickCreateEntry, 'session' | 'input'>): QuickCreateInput | null {
  const { insertion, insertionAnchor } = entry.session.request;
  if (insertionAnchor) {
    if (insertionAnchor.taskId === null) return null;
    return { ...entry.input, insertion: { anchorTaskId: insertionAnchor.taskId, placement: insertionAnchor.placement ?? 'after' } };
  }
  return insertion ? { ...entry.input, insertion: { anchorTaskId: insertion.anchorTaskId, placement: insertion.placement } } : entry.input;
}

const hasQuickValues = (session: CreateSession | null) => session !== null && quickSessionHasValues(session);

export interface EditSession {
  /** The snapshot the draft was made against; its revisions are the guards. */
  base: TaskDto;
  draft: TaskDraft;
  /** Limits an inline save to the single field whose draft the user opened. */
  inlineField?: TaskInlineField;
}

/**
 * Task writes of one project page, owned by the page so that closing the drawer forgets
 * neither an uncertain command nor an unsaved draft. Drafts live in memory only.
 */
export function useTaskCommands(actorId: string, workspaceId: string) {
  const create = useCreateTaskMutation(actorId, workspaceId);
  const update = useUpdateTaskMutation(actorId, workspaceId);
  const archive = useArchiveTaskMutation(actorId, workspaceId);
  const restore = useRestoreTaskMutation(actorId, workspaceId);
  const move = useMoveTaskMutation(actorId, workspaceId);
  const bulk = useBulkUpdateTasksMutation(actorId, workspaceId);
  const createTag = useCreateTagMutation(actorId, workspaceId);
  /** Tags created from the task form, shown before the tag list refetches. */
  const [createdTags, setCreatedTags] = useState<TagDto[]>([]);
  const sessions = useMemo(() => ({ actorId, workspaceId, ...createRetainedTaskSessions() }), [actorId, workspaceId]);
  const { createSession, editSessions } = sessions;
  const drafts = protectedDraftsFor(useQueryClient());
  // Unsent text and explicit submissions outlive a collapsed/remounted add row. Each queued
  // session/input is immutable; only the front entry may reach the existing command writer.
  const quick = useMemo(() => ({
    actorId, workspaceId,
    draft: null as CreateSession | null,
    queue: [] as QuickCreateEntry[],
    sending: false,
    paused: false,
    publish: () => {},
  }), [actorId, workspaceId]);
  const [quickVersion, updateQuick] = useState(0);
  const quickProtected = useCallback(() => quick.queue.length > 0 || hasQuickValues(quick.draft), [quick]);
  const notifyQuick = () => { quick.publish(); updateQuick(value => value + 1); };
  const setQuickDraft = (session: CreateSession) => {
    quick.draft = session;
    if (quick.queue.length === 0) createSession.current = hasQuickValues(session) ? session : null;
    notifyQuick();
  };
  /**
   * Queues one explicit submission. `next` may take the anchor of the queued task, so a row's
   * following create is placed right after it; the next buffer it returns is the editable one.
   * `initial` is copied here, so a retry never reads later definitions, context or edits.
   */
  const enqueueQuickCreate = (session: CreateSession, input: CreateTaskInput, next: CreateSession | ((resultAnchor: CreateResultAnchor) => CreateSession), onCreated: (task: TaskDto) => void, initial?: InitialCreateExtras): CreateSession => {
    const resultAnchor: CreateResultAnchor = { taskId: null };
    quick.queue.push({ session, input, onCreated, resultAnchor, ...(initial ? { initial: structuredClone(initial) } : {}) });
    const following = typeof next === 'function' ? next(resultAnchor) : next;
    quick.draft = following;
    createSession.current = quick.queue[0]?.session ?? null;
    notifyQuick();
    return following;
  };
  const retryQuickCreate = () => { quick.paused = false; notifyQuick(); };
  const releaseQuickDraft = () => { quick.draft = null; notifyQuick(); };
  /** An explicit cancel forgets only this never-sent buffer; queued and unknown creates stay. */
  const cancelQuickDraft = (session: CreateSession): boolean => {
    if (quick.draft !== session || quick.queue.some(entry => entry.session === session)) return false;
    quick.draft = null;
    if (createSession.current === session) createSession.current = quick.queue[0]?.session ?? null;
    notifyQuick();
    return true;
  };
  const discardRejectedQuickCreate = () => {
    if (!quick.paused || quick.sending || create.pendingCommand || create.uncertain) return;
    const rejected = quick.queue.shift();
    if (rejected) {
      // Creates that followed the discarded one take the place it would have had.
      const placed = (rejected.sent ?? resolveQuickCreateInput(rejected))?.insertion;
      if (placed) Object.assign(rejected.resultAnchor, { taskId: placed.anchorTaskId, placement: placed.placement });
    }
    if (rejected && createSession.current === rejected.session) {
      const draft = quick.draft;
      createSession.current = quick.queue[0]?.session ?? (hasQuickValues(draft) ? draft : null);
    }
    quick.paused = false;
    create.reset();
    notifyQuick();
  };
  useEffect(() => {
    const entry = drafts.register();
    quick.publish = () => entry.set(quickProtected());
    quick.publish();
    const warn = (event: BeforeUnloadEvent) => {
      if (!quickProtected()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { quick.publish = () => {}; entry.dispose(); window.removeEventListener('beforeunload', warn); };
  }, [drafts, quick, quickProtected]);
  useEffect(() => {
    const entry = drafts.register();
    const sync = () => entry.set(sessions.getSnapshot());
    const unsubscribe = sessions.subscribe(sync);
    sync();
    // Read current retained input at event time, including changes earlier in this turn.
    // This owner outlives every drawer/inline form, so hiding a form cannot remove protection.
    const warn = (event: BeforeUnloadEvent) => {
      if (!sessions.getSnapshot()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { unsubscribe(); entry.dispose(); window.removeEventListener('beforeunload', warn); };
  }, [drafts, sessions]);
  // Object identity ties confirmation to exactly the submitted draft, including after remount.
  // Weak keys retain neither discarded sessions nor an unbounded task history.
  const confirmedSessions = useRef(new WeakMap<CreateSession | EditSession, TaskDto>());
  const [, notifyConfirmation] = useState(0);
  const confirmSession = useCallback((session: CreateSession | EditSession, task: TaskDto): boolean => {
    if (confirmedSessions.current.has(session)) return false;
    confirmedSessions.current.set(session, task);
    if (createSession.current === session) createSession.current = null;
    if (editSessions.current.get(task.id) === session) editSessions.current.delete(task.id);
    notifyConfirmation(version => version + 1);
    return true;
  }, [createSession, editSessions]);


  useEffect(() => {
    const front = quick.queue[0];
    if (!front || quick.sending || quick.paused || bulk.pendingCommand || bulk.uncertain || create.pendingCommand || update.pendingCommand || update.uncertain || archive.pendingCommand || archive.uncertain || restore.pendingCommand || restore.uncertain || move.pendingCommand || move.uncertain) return;
    // The place is resolved once, before the first send; a create following an unknown task waits.
    const input = front.sent ?? resolveQuickCreateInput(front);
    if (!input) return;
    front.sent = input;
    quick.sending = true;
    // An uncertain front is retried only after the explicit Retry action unpauses it. The
    // unchanged input lets the existing tracker reuse the original body and idempotency key.
    // Extras go in the same single create; without them the request is the existing one.
    void create.mutateAsync({ input, ...(front.initial ? { initial: front.initial } : {}) }).then(task => {
      front.resultAnchor.taskId = task.id;
      if (confirmSession(front.session, task)) front.onCreated(task);
      if (quick.queue[0] === front) quick.queue.shift();
      const draft = quick.draft;
      if (createSession.current === null || createSession.current === front.session) createSession.current = quick.queue[0]?.session ?? (hasQuickValues(draft) ? draft : null);
    }).catch(() => { quick.paused = true; }).finally(() => {
      quick.sending = false;
      quick.publish();
      updateQuick(value => value + 1);
    });
  }, [quick, quickVersion, create, update.pendingCommand, update.uncertain, archive.pendingCommand, archive.uncertain, restore.pendingCommand, restore.uncertain, move.pendingCommand, move.uncertain, bulk.pendingCommand, bulk.uncertain, confirmSession, createSession]);


  const addCreatedTag = useCallback((tag: TagDto) => setCreatedTags((previous) => [...previous, tag]), []);

  return { create, update, archive, restore, move, bulk, createTag, createdTags, addCreatedTag, createSession, editSessions, confirmedSessions, confirmSession, quick, quickVersion, setQuickDraft, enqueueQuickCreate, retryQuickCreate, releaseQuickDraft, cancelQuickDraft, discardRejectedQuickCreate };
}

export type TaskCommands = ReturnType<typeof useTaskCommands>;

export interface UnresolvedTaskCommand {
  /** The edited, archived, restored or moved task; null for a task being created. */
  taskId: string | null;
  kind?: 'bulk';
  /** Sent without a confirmed answer; otherwise still waiting for one. */
  uncertain: boolean;
}

/**
 * The page's task command that is still being sent or has no confirmed answer. Until it is
 * resolved no other task command is sent, so its outcome cannot be confused with another one.
 * Read from the commands each hook holds, never from TanStack's latest `variables`.
 */
export function unresolvedTaskCommand(commands: TaskCommands): UnresolvedTaskCommand | null {
  const { create, update, archive, restore, move, bulk } = commands;
  if (bulk?.pendingCommand) return { taskId: null, uncertain: false, kind: 'bulk' };
  if (bulk?.uncertain) return { taskId: null, uncertain: true, kind: 'bulk' };
  for (const mutation of [update, archive, restore, move]) {
    if (mutation.pendingCommand) return { taskId: mutation.pendingCommand.variables.taskId, uncertain: false };
  }
  if (create.pendingCommand) return { taskId: null, uncertain: false };
  for (const mutation of [update, archive, restore, move]) {
    if (mutation.uncertain) return { taskId: mutation.uncertain.variables.taskId, uncertain: true };
  }
  if (create.uncertain) return { taskId: null, uncertain: true };
  return null;
}

/**
 * Whether a quick session may move to the details form now. A queued, sending or unknown create
 * stays with its row and the page's recovery, and nothing moves while any task command is
 * unresolved. Staged extras move only to a details form that keeps them; otherwise the row keeps
 * the whole session instead of dropping them.
 */
export function canTransferQuickSession(commands: TaskCommands, session: CreateSession, detailsKeepInitialCells: boolean): boolean {
  const { quick } = commands;
  // An empty queue also means this session is not a submitted one.
  if (unresolvedTaskCommand(commands) !== null || quick.sending || quick.paused || quick.queue.length > 0) return false;
  return detailsKeepInitialCells || !hasQuickInitialCells(session);
}
