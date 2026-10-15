import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import type {
  ArchiveTaskInput,
  CreateTagInput,
  CreateTaskInput,
  RestoreTaskInput,
  TagDto,
  TaskDto,
  UpdateTagInput,
  UpdateTaskInput,
} from '@workloom/contracts';
import { useCallback } from 'react';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import {
  TASK_PAGE_SIZE,
  archiveTaskRequest,
  createTagRequest,
  createTaskRequest,
  fetchTags,
  fetchTask,
  fetchTaskPage,
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
  return queryClient.invalidateQueries({
    queryKey: projectId
      ? queryKeys.projectTaskLists(actorId, workspaceId, projectId)
      : queryKeys.tasks(actorId, workspaceId),
  });
}

export function invalidateTask(queryClient: QueryClient, actorId: string, workspaceId: string, taskId: string) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.task(actorId, workspaceId, taskId), exact: true });
}

/**
 * True when `next` would take any independently versioned part of `cached` back: the task row,
 * its work package estimate or its participant set. An idempotent replay can repeat the task
 * revision while a colleague has since changed the shared package or the participants.
 */
export function taskWouldRegress(cached: TaskDto, next: TaskDto): boolean {
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
}

export function useCreateTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: CreateTaskVariables) => createTaskRequest(workspaceId, input),
    onSuccess: (task) => void storeTask(queryClient, actorId, workspaceId, task),
  });
}

export interface UpdateTaskVariables extends IdempotentVariables {
  taskId: string;
  input: UpdateTaskInput;
}

export function useUpdateTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ taskId, input }: UpdateTaskVariables) => updateTaskRequest(workspaceId, taskId, input),
    onSuccess: (task) => void storeTask(queryClient, actorId, workspaceId, task),
  });
}

export interface ArchiveTaskVariables extends IdempotentVariables {
  taskId: string;
  input: ArchiveTaskInput;
}

export function useArchiveTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ taskId, input }: ArchiveTaskVariables) => archiveTaskRequest(workspaceId, taskId, input),
    onSuccess: (task) => void storeTask(queryClient, actorId, workspaceId, task),
  });
}

export interface RestoreTaskVariables extends IdempotentVariables {
  taskId: string;
  input: RestoreTaskInput;
}

export function useRestoreTaskMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ taskId, input }: RestoreTaskVariables) => restoreTaskRequest(workspaceId, taskId, input),
    onSuccess: (task) => void storeTask(queryClient, actorId, workspaceId, task),
  });
}
