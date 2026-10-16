import type { CreateTaskInput, TagDto, TaskDto, TaskWorkScope } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { createRetainedTaskSessions } from './retainedTaskSessions';
import {
  useArchiveTaskMutation,
  useCreateTagMutation,
  useCreateTaskMutation,
  useRestoreTaskMutation,
  useUpdateTaskMutation,
} from './queries';
import { changedKeys, emptyDraft, type TaskDraft } from './taskDraft';
import type { TaskInlineField } from './tableEditing';

/** Where a new task goes: a section (or none) and, for a subtask, its parent as listed. */
export interface CreateRequest {
  sectionId: string | null;
  parent: TaskDto | null;
}

export interface CreateSession {
  request: CreateRequest;
  draft: TaskDraft;
  workScope: TaskWorkScope;
  /** Quick creation keeps recovery in its original inline form while a command is unresolved. */
  origin?: 'quick';
}

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
    queue: [] as { session: CreateSession; input: CreateTaskInput; onCreated: (task: TaskDto) => void }[],
    sending: false,
    paused: false,
    publish: () => {},
  }), [actorId, workspaceId]);
  const [quickVersion, updateQuick] = useState(0);
  const quickProtected = useCallback(() => quick.queue.length > 0 || (quick.draft !== null && changedKeys(emptyDraft(quick.draft.draft.statusId, quick.draft.request.sectionId), quick.draft.draft).length > 0), [quick]);
  const notifyQuick = () => { quick.publish(); updateQuick(value => value + 1); };
  const setQuickDraft = (session: CreateSession) => {
    quick.draft = session;
    if (quick.queue.length === 0) createSession.current = changedKeys(emptyDraft(session.draft.statusId, session.request.sectionId), session.draft).length > 0 ? session : null;
    notifyQuick();
  };
  const enqueueQuickCreate = (session: CreateSession, input: CreateTaskInput, next: CreateSession, onCreated: (task: TaskDto) => void) => {
    quick.queue.push({ session, input, onCreated });
    quick.draft = next;
    createSession.current = quick.queue[0]?.session ?? null;
    notifyQuick();
  };
  const retryQuickCreate = () => { quick.paused = false; notifyQuick(); };
  const releaseQuickDraft = () => { quick.draft = null; notifyQuick(); };
  const discardRejectedQuickCreate = () => {
    if (!quick.paused || quick.sending || create.pendingCommand || create.uncertain) return;
    const rejected = quick.queue.shift();
    if (rejected && createSession.current === rejected.session) {
      const draft = quick.draft;
      createSession.current = quick.queue[0]?.session ?? (draft && changedKeys(emptyDraft(draft.draft.statusId, draft.request.sectionId), draft.draft).length > 0 ? draft : null);
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
    if (!front || quick.sending || quick.paused || create.pendingCommand || update.pendingCommand || update.uncertain || archive.pendingCommand || archive.uncertain || restore.pendingCommand || restore.uncertain) return;
    quick.sending = true;
    // An uncertain front is retried only after the explicit Retry action unpauses it. The
    // unchanged input lets the existing tracker reuse the original body and idempotency key.
    void create.mutateAsync({ input: front.input }).then(task => {
      if (confirmSession(front.session, task)) front.onCreated(task);
      if (quick.queue[0] === front) quick.queue.shift();
      const draft = quick.draft;
      if (createSession.current === null || createSession.current === front.session) createSession.current = quick.queue[0]?.session ?? (draft && changedKeys(emptyDraft(draft.draft.statusId, draft.request.sectionId), draft.draft).length > 0 ? draft : null);
    }).catch(() => { quick.paused = true; }).finally(() => {
      quick.sending = false;
      quick.publish();
      updateQuick(value => value + 1);
    });
  }, [quick, quickVersion, create, update.pendingCommand, update.uncertain, archive.pendingCommand, archive.uncertain, restore.pendingCommand, restore.uncertain, confirmSession, createSession]);


  const addCreatedTag = useCallback((tag: TagDto) => setCreatedTags((previous) => [...previous, tag]), []);

  return { create, update, archive, restore, createTag, createdTags, addCreatedTag, createSession, editSessions, confirmedSessions, confirmSession, quick, quickVersion, setQuickDraft, enqueueQuickCreate, retryQuickCreate, releaseQuickDraft, discardRejectedQuickCreate };
}

export type TaskCommands = ReturnType<typeof useTaskCommands>;

export interface UnresolvedTaskCommand {
  /** The edited, archived or restored task; null for a task being created. */
  taskId: string | null;
  /** Sent without a confirmed answer; otherwise still waiting for one. */
  uncertain: boolean;
}

/**
 * The page's task command that is still being sent or has no confirmed answer. Until it is
 * resolved no other task command is sent, so its outcome cannot be confused with another one.
 * Read from the commands each hook holds, never from TanStack's latest `variables`.
 */
export function unresolvedTaskCommand(commands: TaskCommands): UnresolvedTaskCommand | null {
  const { create, update, archive, restore } = commands;
  for (const mutation of [update, archive, restore]) {
    if (mutation.pendingCommand) return { taskId: mutation.pendingCommand.variables.taskId, uncertain: false };
  }
  if (create.pendingCommand) return { taskId: null, uncertain: false };
  for (const mutation of [update, archive, restore]) {
    if (mutation.uncertain) return { taskId: mutation.uncertain.variables.taskId, uncertain: true };
  }
  if (create.uncertain) return { taskId: null, uncertain: true };
  return null;
}
