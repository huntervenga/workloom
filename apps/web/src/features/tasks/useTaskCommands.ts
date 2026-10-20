import type { CreateTaskInput, ProjectDto, TagDto, TaskDto, TaskWorkScope, WorkspaceDto } from '@workloom/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, isUncertainOutcome } from '../../lib/api';
import { PendingCommandError } from '../../lib/idempotency';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { fetchTask } from './api';
import { createRetainedTaskSessions } from './retainedTaskSessions';
import { createTaskAutosave } from './taskAutosave';
import {
  useBulkUpdateTasksMutation,
  useArchiveTaskMutation,
  useCreateTagMutation,
  useCreateTaskMutation,
  useMoveTaskMutation,
  useRestoreTaskMutation,
  useUpdateTaskMutation,
} from './queries';
import { useInlineTagCreation } from './inlineTagCreate';
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
  /** A pane-owned child stays held if its authoritative parent detail is later removed. */
  requiresParentRead?: boolean;
  /** At most one queue-owned read after a pane cancels its invalidated parent renewal. */
  parentReadAttempted?: boolean;
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

/** A loaded parent must finish its authoritative renewal before a child intent may be sent. */
function quickParentCurrent(client: QueryClient, actorId: string, workspaceId: string, entry: QuickCreateEntry): boolean {
  const parent = entry.session.request.parent;
  if (parent === null) return true;
  const workspace = client.getQueryState<WorkspaceDto>(queryKeys.workspace(actorId, workspaceId));
  const project = client.getQueryState<ProjectDto>(queryKeys.project(actorId, workspaceId, parent.projectId));
  if (workspace && (workspace.status !== 'success' || workspace.isInvalidated || workspace.fetchStatus !== 'idle' || workspace.data === undefined || workspace.data.role === 'viewer')) return false;
  if (project && (project.status !== 'success' || project.isInvalidated || project.fetchStatus !== 'idle' || project.data === undefined || project.data.archivedAt !== null)) return false;
  const current = client.getQueryState<TaskDto>(queryKeys.task(actorId, workspaceId, parent.id));
  // A table-only child composer may have no detail observer; its existing command/server guards still apply.
  if (current === undefined) return entry.requiresParentRead !== true;
  const task = current.data;
  return task !== undefined && current.status === 'success' && !current.isInvalidated && current.fetchStatus === 'idle'
    && task.id === parent.id && task.workspaceId === workspaceId && task.projectId === parent.projectId
    && task.archivedAt === null && task.meetingId === null;
}

/** Complete a canceled pane renewal once; its result only wakes the usual guarded queue. */
function renewInactiveQuickParent(client: QueryClient, actorId: string, workspaceId: string, entry: QuickCreateEntry): void {
  const parent = entry.session.request.parent;
  if (!parent || !entry.requiresParentRead || entry.sent !== undefined || entry.parentReadAttempted) return;
  const workspace = client.getQueryState<WorkspaceDto>(queryKeys.workspace(actorId, workspaceId));
  const project = client.getQueryState<ProjectDto>(queryKeys.project(actorId, workspaceId, parent.projectId));
  if (!workspace || workspace.status !== 'success' || workspace.isInvalidated || workspace.fetchStatus !== 'idle'
    || workspace.data?.id !== workspaceId || workspace.data.role === 'viewer') return;
  if (!project || project.status !== 'success' || project.isInvalidated || project.fetchStatus !== 'idle'
    || project.data?.id !== parent.projectId || project.data.workspaceId !== workspaceId || project.data.archivedAt !== null) return;
  const queryKey = queryKeys.task(actorId, workspaceId, parent.id);
  const query = client.getQueryCache().find<TaskDto>({ queryKey, exact: true });
  const current = query?.state;
  if (!query || query.getObserversCount() !== 0 || !current || current.status !== 'success' || !current.isInvalidated || current.fetchStatus !== 'idle') return;
  const task = current.data;
  if (!task || task.id !== parent.id || task.workspaceId !== workspaceId || task.projectId !== parent.projectId
    || task.archivedAt !== null || task.meetingId !== null) return;
  entry.parentReadAttempted = true;
  // No direct dispatch, retry or body rewrite here. Error/denial stays in the query for explicit recovery.
  void client.fetchQuery({ queryKey, queryFn: ({ signal }) => fetchTask(workspaceId, parent.id, signal), retry: false, staleTime: 0 }).catch(() => undefined);
}

const hasQuickValues = (session: CreateSession | null) => session !== null && quickSessionHasValues(session);

export interface EditSession {
  /** The snapshot the draft was made against; its revisions are the guards. */
  base: TaskDto;
  draft: TaskDraft;
  /** Limits an inline save to the single field whose draft the user opened. */
  inlineField?: TaskInlineField;
  /** Local identity of this draft for inline tag creation; never sent. A reset mints a new one. */
  draftId?: string;
}

const noCreatedTags: TagDto[] = [];

/**
 * Task writes of one project page, owned by the page so that closing the drawer forgets
 * neither an uncertain command nor an unsaved draft. Drafts live in memory only.
 * `canCreateTags` is the current role's right to create workspace tags inline; denied by default.
 */
export function useTaskCommands(actorId: string, workspaceId: string, canCreateTags = false) {
  const create = useCreateTaskMutation(actorId, workspaceId);
  const update = useUpdateTaskMutation(actorId, workspaceId);
  const archive = useArchiveTaskMutation(actorId, workspaceId);
  const restore = useRestoreTaskMutation(actorId, workspaceId);
  const move = useMoveTaskMutation(actorId, workspaceId);
  const bulk = useBulkUpdateTasksMutation(actorId, workspaceId);
  const createTag = useCreateTagMutation(actorId, workspaceId);
  /** Tags created from the task form, shown before the tag list refetches; kept per actor and workspace. */
  const scopeKey = `${actorId}\u0000${workspaceId}`;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [created, setCreated] = useState<{ scopeKey: string; tags: TagDto[] }>(() => ({ scopeKey, tags: [] }));
  const createdTags = created.scopeKey === scopeKey ? created.tags : noCreatedTags;
  const sessions = useMemo(() => ({ actorId, workspaceId, ...createRetainedTaskSessions() }), [actorId, workspaceId]);
  const { createSession, editSessions } = sessions;
  const queryClient = useQueryClient();
  const drafts = protectedDraftsFor(queryClient);
  const commandRegistry = protectedCommandsFor(queryClient);
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
    const parent = session.request.parent;
    const requiresParentRead = parent !== null && queryClient.getQueryState(queryKeys.task(actorId, workspaceId, parent.id)) !== undefined;
    quick.queue.push({ session, input, onCreated, resultAnchor, requiresParentRead, ...(initial ? { initial: structuredClone(initial) } : {}) });
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
    if (currentScope.current !== scopeKey) return;
    const front = quick.queue[0];
    if (!front || quick.sending || quick.paused || bulk.pendingCommand || bulk.uncertain || create.pendingCommand || update.pendingCommand || update.uncertain || archive.pendingCommand || archive.uncertain || restore.pendingCommand || restore.uncertain || move.pendingCommand || move.uncertain) return;
    if (!quickParentCurrent(queryClient, actorId, workspaceId, front)) {
      renewInactiveQuickParent(queryClient, actorId, workspaceId, front);
      return;
    }
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
  }, [quick, quickVersion, create, update.pendingCommand, update.uncertain, archive.pendingCommand, archive.uncertain, restore.pendingCommand, restore.uncertain, move.pendingCommand, move.uncertain, bulk.pendingCommand, bulk.uncertain, confirmSession, createSession, queryClient, actorId, workspaceId, scopeKey]);
  // Parent detail observers live in the pane, so their settled reads must also wake the page-owned queue.
  useEffect(() => queryClient.getQueryCache().subscribe(event => {
    const parent = quick.queue[0]?.session.request.parent;
    if (event.type !== 'updated' || !parent) return;
    const keys = [queryKeys.task(actorId, workspaceId, parent.id), queryKeys.project(actorId, workspaceId, parent.projectId), queryKeys.workspace(actorId, workspaceId)];
    if (keys.some(queryKey => queryClient.getQueryCache().find({ queryKey, exact: true }) === event.query)) updateQuick(version => version + 1);
  }), [queryClient, quick, actorId, workspaceId]);


  // Saved-task autosave: one controller per actor and workspace, owned here so a closed or
  // switched pane keeps queued, sending and unknown saves. It writes only through `update`,
  // and only while no other task command of the page is unresolved.
  const blocked = Boolean(bulk.pendingCommand || bulk.uncertain || create.pendingCommand || create.uncertain || update.pendingCommand || update.uncertain
    || archive.pendingCommand || archive.uncertain || restore.pendingCommand || restore.uncertain || move.pendingCommand || move.uncertain);
  const live = useRef({ update, blocked, mounted: false });
  live.current = { update, blocked, mounted: live.current.mounted };
  const autosave = useMemo(() => {
    const scope = scopeKey;
    // Only sessions this controller mirrored may be replaced or removed by it.
    const mirrored = new WeakSet<EditSession>();
    return createTaskAutosave({
      send: (taskId, input) => live.current.update.mutateAsync({ taskId, input }),
      resend: (taskId, input) => {
        const { update: current } = live.current;
        const held = current.uncertain?.variables;
        if (!live.current.mounted || currentScope.current !== scope || current.hasOtherProtectedCommands() || !held || held.taskId !== taskId || held.input !== input) return null;
        return new Promise<TaskDto>((resolve, reject) => current.retryUncertain({ onSuccess: resolve, onError: reject }));
      },
      canSend: () => live.current.mounted && currentScope.current === scope && !live.current.blocked && !live.current.update.hasOtherProtectedCommands() && !quick.sending,
      completionRefused:error=>error instanceof ApiError&&error.kind==='validation'&&error.completionFieldsRequired,
      classify: error => error instanceof PendingCommandError ? 'notSent'
        : isUncertainOutcome(error) ? 'unknown'
        : error instanceof ApiError && error.kind === 'conflict' ? 'conflict' : 'rejected',
      retain: (taskId, session) => {
        const kept = editSessions.current.get(taskId);
        if (session) {
          if (kept && !mirrored.has(kept)) return;
          mirrored.add(session);
          editSessions.current.set(taskId, session);
        } else if (kept && mirrored.has(kept)) editSessions.current.delete(taskId);
      },
    });
  }, [scopeKey, editSessions, quick]);
  useEffect(() => {
    live.current.mounted = true;
    const entry = drafts.register();
    const sync = () => entry.set(autosave.hasRetained());
    const unsubscribe = autosave.subscribe(sync);
    sync();
    const warn = (event: BeforeUnloadEvent) => {
      if (!autosave.hasRetained()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => { live.current.mounted = false; unsubscribe(); entry.dispose(); window.removeEventListener('beforeunload', warn); };
  }, [drafts, autosave]);
  // A replaced scope never sends what its actor queued.
  useEffect(() => {
    const scope = scopeKey;
    return () => { if (currentScope.current !== scope) autosave.dispose(); };
  }, [autosave, scopeKey]);
  // The queue continues once the previous answer has rendered and no other command is unresolved.
  useEffect(() => { if (!blocked) autosave.pump(); }, [autosave, blocked, quickVersion]);
  // A different protected writer can finish without changing any task mutation state.
  useEffect(() => {
    let active = true;
    const unsubscribe = commandRegistry.subscribe(() => {
      queueMicrotask(() => { if (active) autosave.pump(); });
    });
    return () => { active = false; unsubscribe(); };
  }, [autosave, commandRegistry]);

  /** Explicit handoff from an unsent inline/rich draft; a held foreign command keeps its owner. */
  const adoptAutosaveSession = (session: EditSession): boolean => {
    const taskId = session.base.id;
    if (editSessions.current.get(taskId) !== session || update.pendingCommand?.variables.taskId === taskId || update.uncertain?.variables.taskId === taskId) return false;
    const failed = update.variables?.taskId === taskId && update.variables.input.expectedRevision === session.base.revision && update.error !== null
      ? { input: update.variables.input, error: update.error } : null;
    editSessions.current.delete(taskId);
    if (failed) {
      const transferred = autosave.adoptFailure(session, failed.input, failed.error, failed.error instanceof ApiError && failed.error.kind === 'conflict' ? 'conflict' : 'rejected');
      if (!transferred) editSessions.current.set(taskId, session);
      return transferred;
    }
    autosave.stage(session.base, session.draft);
    return true;
  };

  // An answer that arrives after the actor or workspace changed never enters the current catalog.
  const addCreatedTag = useCallback((tag: TagDto) => {
    if (currentScope.current !== scopeKey || tag.workspaceId !== workspaceId) return;
    setCreated(previous => previous.scopeKey !== scopeKey ? { scopeKey, tags: [tag] }
      : previous.tags.some(kept => kept.id === tag.id) ? previous : { scopeKey, tags: [...previous.tags, tag] });
  }, [scopeKey, workspaceId]);
  const inlineTags = useInlineTagCreation(createTag, addCreatedTag, canCreateTags, scopeKey);

  return { create, update, archive, restore, move, bulk, createTag, createdTags, addCreatedTag, inlineTags, createSession, editSessions, confirmedSessions, confirmSession, autosave, adoptAutosaveSession, quick, quickVersion, setQuickDraft, enqueueQuickCreate, retryQuickCreate, releaseQuickDraft, cancelQuickDraft, discardRejectedQuickCreate };
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
