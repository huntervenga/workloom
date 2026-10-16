import type { TagDto, TaskDto, TaskWorkScope } from '@workloom/contracts';
import { useCallback, useRef, useState } from 'react';
import {
  useArchiveTaskMutation,
  useCreateTagMutation,
  useCreateTaskMutation,
  useRestoreTaskMutation,
  useUpdateTaskMutation,
} from './queries';
import type { TaskDraft } from './taskDraft';
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
  const createSession = useRef<CreateSession | null>(null);
  const editSessions = useRef(new Map<string, EditSession>());
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
  }, []);


  const addCreatedTag = useCallback((tag: TagDto) => setCreatedTags((previous) => [...previous, tag]), []);

  return { create, update, archive, restore, createTag, createdTags, addCreatedTag, createSession, editSessions, confirmedSessions, confirmSession };
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
