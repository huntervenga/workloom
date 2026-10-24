import { recordMoveUndo } from '../undo/recordMoveUndo';
import { reconcileFieldAcks } from '../undo/storeFieldAck';
import { captureTask, recordTaskUndo, recordBulkUndo, type BulkUndoMetadata } from '../undo/recordUndo';
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type {
  BulkUpdateTasksInput,
  ArchiveTaskInput,
  CreateTagInput,
  CreateTaskInput,
  CreateTaskRowInput,
  MoveTaskInput,
  RestoreTaskInput,
  TagDto,
  TaskDto,
  UpdateTagInput,
  UpdateTaskInput,
} from '@workloom/contracts';
import { useCallback, useRef } from 'react';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { invalidateTaskTimelines } from '../task-comments/queries';
import {
  bulkUpdateTasksRequest,
  TASK_PAGE_SIZE,
  archiveTaskRequest,
  createTagRequest,
  createTaskRequest,
  createTaskRowRequest,
  fetchTags,
  fetchTask,
  fetchTaskPage,
  moveTaskRequest,
  normalizeTaskFilters,
  restoreTaskRequest,
  updateTagRequest,
  updateTaskRequest,
  type TaskListFilters,
  type TaskPage,
} from './api';

export function useTagsQuery(actorId: string, workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.tags(actorId, workspaceId),
    queryFn: ({ signal }) => fetchTags(workspaceId, signal),
  });
}

export interface TaskListOptions {
  /** 1–200; defaults to `TASK_PAGE_SIZE`. */
  limit?: number | undefined;
  enabled?: boolean | undefined;
}

/**
 * One project's tasks, filtered and searched on the server, loaded page by page
 * with `meta.nextCursor`. Call `fetchNextPage()` for more; `loadedTaskScope`
 * tells how much is loaded.
 */
export function useTaskListQuery(
  actorId: string,
  workspaceId: string,
  filters: TaskListFilters,
  { limit = TASK_PAGE_SIZE, enabled = true }: TaskListOptions = {},
) {
  const normalized = normalizeTaskFilters(filters);
  return useInfiniteQuery({
    queryKey: queryKeys.taskList(actorId, workspaceId, normalized.projectId, { ...normalized, limit }),
    queryFn: ({ signal, pageParam }) => fetchTaskPage(workspaceId, normalized, { limit, cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: TaskPage) => lastPage.nextCursor,
    enabled: enabled && isUuid(normalized.projectId),
  });
}

export interface LoadedTaskScope {
  tasks: TaskDto[];
  /** Tasks loaded so far. Not the project total unless `complete`. */
  loadedCount: number;
  /** True once the server reported no further page. */
  complete: boolean;
}

/**
 * What a paged task list has actually loaded. Totals (counts, estimates) over
 * `tasks` describe only the loaded part while `complete` is false; never show
 * them as the whole project's.
 */
export function loadedTaskScope(data: InfiniteData<TaskPage> | undefined): LoadedTaskScope {
  const pages = data?.pages ?? [];
  const tasks = pages.flatMap((page) => page.tasks);
  const last = pages.at(-1);
  return { tasks, loadedCount: tasks.length, complete: last !== undefined && last.nextCursor === null };
}

export function useTaskQuery(actorId: string, workspaceId: string, taskId: string) {
  return useQuery({
    queryKey: queryKeys.task(actorId, workspaceId, taskId),
    queryFn: ({ signal }) => fetchTask(workspaceId, taskId, signal),
    enabled: isUuid(taskId),
  });
}

/** Fetches the workspace tags now, bypassing the cache, e.g. after a tag conflict. */
export function useReloadTags(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: queryKeys.tags(actorId, workspaceId),
        queryFn: ({ signal }) => fetchTags(workspaceId, signal),
        staleTime: 0,
      }),
    [actorId, workspaceId, queryClient],
  );
}

/** Fetches the task now, bypassing the cache, e.g. to review a revision conflict. */
export function useReloadTask(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (taskId: string) =>
      queryClient.fetchQuery({
        queryKey: queryKeys.task(actorId, workspaceId, taskId),
        queryFn: ({ signal }) => fetchTask(workspaceId, taskId, signal),
        staleTime: 0,
      }),
    [actorId, workspaceId, queryClient],
  );
}

export function invalidateTags(queryClient: QueryClient, actorId: string, workspaceId: string) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.tags(actorId, workspaceId), exact: true });
}

/**
 * Task lists and details. Without `projectId` it covers the whole workspace;
 * a task write may change other tasks too (a shared work package estimate).
 */
export function invalidateTasks(queryClient: QueryClient, actorId: string, workspaceId: string, projectId?: string) {
  void queryClient.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'generic-reports'] });
  if (projectId === undefined) void invalidateTaskTimelines(queryClient, actorId, workspaceId);
  return queryClient.invalidateQueries({
    queryKey: projectId
      ? queryKeys.projectTaskLists(actorId, workspaceId, projectId)
      : queryKeys.tasks(actorId, workspaceId),
  });
}

/** The exact detail plus its history stream; comment and activity sub-queries stay untouched. */
export function invalidateTask(queryClient: QueryClient, actorId: string, workspaceId: string, taskId: string) {
  void invalidateTaskTimelines(queryClient, actorId, workspaceId, [taskId]);
  return queryClient.invalidateQueries({ queryKey: queryKeys.task(actorId, workspaceId, taskId), exact: true });
}

/**
 * True when `next` would take any independently versioned part of `cached` back: the task row,
 * its work package estimate or its participant set. An idempotent replay can repeat the task
 * revision while a colleague has since changed the shared package or the participants.
 */
export function taskWouldRegress(cached: TaskDto, next: TaskDto): boolean {
  if (cached.meetingId !== undefined && next.meetingId === undefined) return true;
  if (cached.startDate !== undefined && next.startDate === undefined) return true;
  if (next.revision < cached.revision) return true;
  if (next.participantsRevision < cached.participantsRevision) return true;
  return next.workPackageId === cached.workPackageId && next.workPackageRevision < cached.workPackageRevision;
}

/**
 * True when `next` embeds a tag at an older revision than one already known. Tags are versioned
 * on their own: an idempotent replay repeats the tag as it was, after a colleague may have
 * renamed or archived it, while every task revision stays the same.
 */
export function tagsWouldRegress(next: TaskDto, known: readonly TagDto[]): boolean {
  const revisions = new Map<string, number>();
  for (const tag of known) revisions.set(tag.id, Math.max(revisions.get(tag.id) ?? tag.revision, tag.revision));
  return next.tags.some((tag) => tag.revision < (revisions.get(tag.id) ?? tag.revision));
}

/**
 * Applies a confirmed task to its cached detail unless that would regress any revision,
 * including an embedded tag against the cached detail or workspace tags, in which case the
 * newer cached data stays and the detail is refetched. Task lists refetch too.
 */
export function storeTask(queryClient: QueryClient, actorId: string, workspaceId: string, task: TaskDto) {
  void queryClient.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'schedule'] });
  // Status/archive changes affect authoritative dependency projections, including other projects.
  void queryClient.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'dependencies'] });
  const detailKey = queryKeys.task(actorId, workspaceId, task.id);
  const cached = queryClient.getQueryData<TaskDto>(detailKey);
  if (cached) {
    const workspaceTags = queryClient.getQueryData<TagDto[]>(queryKeys.tags(actorId, workspaceId)) ?? [];
    if (taskWouldRegress(cached, task) || tagsWouldRegress(task, [...cached.tags, ...workspaceTags])) {
      void invalidateTask(queryClient, actorId, workspaceId, task.id);
    } else queryClient.setQueryData(detailKey, task);
  }
  return invalidateTasks(queryClient, actorId, workspaceId);
}

export interface CreateTagVariables extends IdempotentVariables {
  input: CreateTagInput;
}

export function useCreateTagMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: CreateTagVariables) => createTagRequest(workspaceId, input),
    onSuccess: () => void invalidateTags(queryClient, actorId, workspaceId),
  });
}

export interface UpdateTagVariables extends IdempotentVariables {
  tagId: string;
  input: UpdateTagInput;
}

/** Tasks embed their tags, so task queries are refreshed too. */
export function useUpdateTagMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ tagId, input }: UpdateTagVariables) => updateTagRequest(workspaceId, tagId, input),
    onSuccess: () => {
      void invalidateTags(queryClient, actorId, workspaceId);
      void invalidateTasks(queryClient, actorId, workspaceId);
    },
  });
}

export interface CreateTaskVariables extends IdempotentVariables {
  input: CreateTaskInput;
  /**
   * First custom field values and explicit plan/actual of the new row. When present the task is
   * created atomically through `POST …/tasks/rows`; without it the legacy `POST …/tasks` is sent.
   */
  initial?: Omit<CreateTaskRowInput, 'task'> | undefined;
}

/** True when `initial` carries anything the legacy task create cannot. */
function hasInitialRowData(initial: CreateTaskVariables['initial']): initial is Omit<CreateTaskRowInput, 'task'> {
  return initial !== undefined && ((initial.fields?.length ?? 0) > 0 || initial.plan !== undefined || initial.actual !== undefined);
}

/**
 * Field values, plans and actuals of every period and project the row may touch. A confirmed
 * atomic row is never patched into them: they refetch from the server.
 */
export function invalidateTaskRowProjections(queryClient: QueryClient, actorId: string, workspaceId: string) {
  const workspace = queryKeys.workspace(actorId, workspaceId);
  void queryClient.invalidateQueries({ queryKey: queryKeys.fields(actorId, workspaceId) });
  void queryClient.invalidateQueries({ queryKey: [...workspace, 'planning'] });
  void queryClient.invalidateQueries({ queryKey: [...workspace, 'workCategories'] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.timeSummaries(actorId, workspaceId) });
}

export function useCreateTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input, initial }: CreateTaskVariables) =>
      hasInitialRowData(initial)
        ? createTaskRowRequest(workspaceId, { task: input, ...initial })
        : createTaskRequest(workspaceId, input),
    onSuccess: (task, { initial, input }, ack) => {
      if (ack.actorId !== null && ack.actorId !== actorId) return;
      if (ack.actorId === actorId && task.projectId === input.projectId && task.workspaceId === workspaceId) recordTaskUndo(queryClient, actorId, workspaceId, 'create', undefined, task, undefined, ack.receipt);
      if (hasInitialRowData(initial)) invalidateTaskRowProjections(queryClient, actorId, workspaceId);
      void storeTask(queryClient, actorId, workspaceId, task);
    },
  });
}

export interface UpdateTaskVariables extends IdempotentVariables {
  taskId: string;
  input: UpdateTaskInput;
}

export function useUpdateTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  const snapshots = useRef(new WeakMap<UpdateTaskVariables, TaskDto | undefined>()).current;
  return useIdempotentMutation({
    prepare: (variables: UpdateTaskVariables) => {
      if (!snapshots.has(variables)) snapshots.set(variables, captureTask(queryClient, actorId, workspaceId, variables.taskId, variables.input));
      return updateTaskRequest(workspaceId, variables.taskId, variables.input);
    },
    onSuccess: (task, variables, ack) => {
      if (ack.actorId !== null && ack.actorId !== actorId) return;
      if (ack.actorId === actorId) recordTaskUndo(queryClient, actorId, workspaceId, 'update', snapshots.get(variables), task, variables.input, ack.receipt);
      void storeTask(queryClient, actorId, workspaceId, task);
    },
  });
}

export interface ArchiveTaskVariables extends IdempotentVariables {
  taskId: string;
  input: ArchiveTaskInput;
}

export function useArchiveTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  const snapshots = useRef(new WeakMap<ArchiveTaskVariables, TaskDto | undefined>()).current;
  return useIdempotentMutation({
    prepare: (variables: ArchiveTaskVariables) => {
      if (!snapshots.has(variables)) snapshots.set(variables, captureTask(queryClient, actorId, workspaceId, variables.taskId, variables.input));
      return archiveTaskRequest(workspaceId, variables.taskId, variables.input);
    },
    onSuccess: (task, variables, ack) => {
      if (ack.actorId !== null && ack.actorId !== actorId) return;
      if (ack.actorId === actorId) recordTaskUndo(queryClient, actorId, workspaceId, 'archive', snapshots.get(variables), task, variables.input, ack.receipt);
      // Canonical task lists have one params object after this prefix. Placement lists share
      // the prefix but contain pages.rows; treating them as TaskPage would discard the Undo ACK.
      const listPrefix = queryKeys.projectTaskLists(actorId, workspaceId, task.projectId);
      queryClient.setQueriesData<InfiniteData<TaskPage>>({
        queryKey: listPrefix,
        predicate: query => query.queryKey.length === listPrefix.length + 1 && typeof query.queryKey[listPrefix.length] === 'object',
      }, (data) => data && Array.isArray(data.pages) && data.pages.every(page => Array.isArray(page.tasks))
        ? { ...data, pages: data.pages.map((page) => ({ ...page, tasks: page.tasks.filter((item) => item.id !== task.id && item.parentTaskId !== task.id) })) }
        : data);
      void storeTask(queryClient, actorId, workspaceId, task);
    },
  });
}

export interface MoveTaskVariables extends IdempotentVariables {
  taskId: string;
  input: MoveTaskInput;
}

/**
 * A move renumbers siblings too, so no loaded list position is patched: the confirmed task is
 * stored like any other write and every task list and head projection of the workspace refetches.
 */
export function useMoveTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: (variables: MoveTaskVariables) => {
      return moveTaskRequest(workspaceId, variables.taskId, { ...variables.input, captureUndo: true });
    },
    onSuccess: (task, variables, ack) => {
      if (ack.actorId !== null && ack.actorId !== actorId) return;
      if (ack.actorId === actorId && task.id === variables.taskId) recordMoveUndo(queryClient, actorId, workspaceId, task, variables.input.expectedRevision, ack.idempotencyKey, ack.receipt);
      void storeTask(queryClient, actorId, workspaceId, task);
    },
  });
}

export interface RestoreTaskVariables extends IdempotentVariables {
  taskId: string;
  input: RestoreTaskInput;
}

export function useRestoreTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  const snapshots = useRef(new WeakMap<RestoreTaskVariables, TaskDto | undefined>()).current;
  return useIdempotentMutation({
    prepare: (variables: RestoreTaskVariables) => {
      if (!snapshots.has(variables)) snapshots.set(variables, captureTask(queryClient, actorId, workspaceId, variables.taskId, variables.input));
      return restoreTaskRequest(workspaceId, variables.taskId, variables.input);
    },
    onSuccess: (task, variables, ack) => {
      if (ack.actorId !== null && ack.actorId !== actorId) return;
      if (ack.actorId === actorId) recordTaskUndo(queryClient, actorId, workspaceId, 'restore', snapshots.get(variables), task, variables.input, ack.receipt);
      void storeTask(queryClient, actorId, workspaceId, task);
    },
  });
}

export interface BulkUpdateTaskVariables extends IdempotentVariables { input: BulkUpdateTasksInput; undo?: BulkUndoMetadata }
export function useBulkUpdateTasksMutation(actorId: string, workspaceId: string) {
  const client = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: BulkUpdateTaskVariables) => bulkUpdateTasksRequest(workspaceId, input),
    onSuccess: async (tasks, variables, ack) => {
      if (ack.actorId !== null && ack.actorId !== actorId) return;
      if (ack.actorId === actorId) recordBulkUndo(client, actorId, workspaceId, variables.undo, tasks, variables.input, ack.receipt);
      await reconcileFieldAcks(client, actorId, workspaceId, tasks.flatMap(task => task.customFieldAck ? [task.customFieldAck] : []));
      void storeConfirmedTasks(client, actorId, workspaceId, tasks, variables.input.changes.estimateMinutes !== undefined || !!variables.input.changes.restore?.some(row => row.changes.estimateMinutes !== undefined));
      // The task projection does not carry independently revisioned custom values. Invalidate
      // their whole scoped family once, never once per selected row or with a fabricated value.
      if (variables.input.changes.customField !== undefined || variables.input.changes.restore?.some(row => row.changes.customField)) {
        void client.invalidateQueries({ queryKey: queryKeys.fieldValues(actorId, workspaceId) });
        void client.invalidateQueries({ queryKey: [...queryKeys.fields(actorId, workspaceId), 'history'] });
      }
    },
  });
}

/** An atomic batch updates detail caches without one refetch storm per returned row. */
export function storeConfirmedTasks(client: QueryClient, actorId: string, workspaceId: string, tasks: readonly TaskDto[], sharedEstimate = false) {
  const knownTags = client.getQueryData<TagDto[]>(queryKeys.tags(actorId, workspaceId)) ?? [];
  for (const task of tasks) {
    const key = queryKeys.task(actorId, workspaceId, task.id);
    const cached = client.getQueryData<TaskDto>(key);
    if (!cached) continue;
    if (taskWouldRegress(cached, task) || tagsWouldRegress(task, [...cached.tags, ...knownTags])) void client.invalidateQueries({ queryKey: key, exact: true });
    else client.setQueryData(key, task);
  }
  // Histories of all returned rows refresh in one predicate pass, cached detail or not.
  void invalidateTaskTimelines(client, actorId, workspaceId, sharedEstimate ? undefined : tasks.map(task => task.id));
  const workspace = queryKeys.workspace(actorId, workspaceId);
  void client.invalidateQueries({ queryKey: [...workspace, 'generic-reports'] });
  void client.invalidateQueries({ queryKey: [...workspace, 'schedule'] });
  void client.invalidateQueries({ queryKey: [...workspace, 'dependencies'] });
  const prefix = queryKeys.tasks(actorId, workspaceId);
  return client.invalidateQueries({ queryKey: prefix, predicate: query => query.queryKey[prefix.length] !== 'detail' });
}
