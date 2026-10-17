import {
  archiveTaskInputSchema,
  createTagInputSchema,
  createTaskInputSchema,
  restoreTaskInputSchema,
  tagListResponseSchema,
  tagResponseSchema,
  taskListQuerySchema,
  taskListResponseSchema,
  taskResponseSchema,
  updateTagInputSchema,
  updateTaskInputSchema,
  type ArchiveTaskInput,
  type CreateTagInput,
  type CreateTaskInput,
  type RestoreTaskInput,
  type TagDto,
  type TaskDto,
  type TaskListQuery,
  type UpdateTagInput,
  type UpdateTaskInput,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation, sendMutation, type MutationOptions } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

/** Page size for task lists; the contract allows up to 200. */
export const TASK_PAGE_SIZE = 100;

/** Server-side filters and search of a task list; paging is handled by the list query. */
export type TaskListFilters = Omit<TaskListQuery, 'limit' | 'cursor'>;

export interface TaskPage {
  tasks: TaskDto[];
  /** Cursor of the next page, null when this page is the last one. */
  nextCursor: string | null;
}

function taskPath(workspaceId: string, taskId: string): string {
  return `${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}`;
}

/** Drops empty values so equal filters share one cache entry and one request. */
export function normalizeTaskFilters(filters: TaskListFilters): TaskListFilters {
  const search = filters.search?.trim();
  const tagId = filters.tagId?.trim();
  const normalized: TaskListFilters = { projectId: filters.projectId };
  if (filters.sectionId) normalized.sectionId = filters.sectionId;
  if (filters.statusId) normalized.statusId = filters.statusId;
  if (filters.participantMembershipId) normalized.participantMembershipId = filters.participantMembershipId;
  if (tagId) normalized.tagId = tagId;
  if (search) normalized.search = search;
  if (filters.includeArchived) normalized.includeArchived = true;
  // Omitted/manual keep the legacy request and cache identity. Unsupported runtime
  // values still reach schema validation rather than silently becoming a valid sort.
  if (filters.sort !== undefined && filters.sort !== 'manual') normalized.sort = filters.sort;
  // Omitted means all tasks with the legacy identity. An explicit value is forwarded as given,
  // so an unsupported runtime string is rejected by the schema instead of reading every task.
  if (filters.completion !== undefined) normalized.completion = filters.completion;
  return normalized;
}

export function taskListSearchParams(filters: TaskListFilters, limit: number, cursor: string | null): URLSearchParams {
  const parsed = taskListQuerySchema.safeParse({ ...normalizeTaskFilters(filters), limit, ...(cursor ? { cursor } : {}) });
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

export async function fetchTaskPage(
  workspaceId: string,
  filters: TaskListFilters,
  options: { limit?: number | undefined; cursor?: string | null | undefined; signal?: AbortSignal | undefined } = {},
): Promise<TaskPage> {
  const params = taskListSearchParams(filters, options.limit ?? TASK_PAGE_SIZE, options.cursor ?? null);
  const { data, meta } = await apiGet(`${workspacePath(workspaceId)}/tasks?${params.toString()}`, taskListResponseSchema, options.signal);
  return { tasks: data, nextCursor: meta.nextCursor ?? null };
}

export async function fetchTask(workspaceId: string, taskId: string, signal?: AbortSignal): Promise<TaskDto> {
  return (await apiGet(taskPath(workspaceId, taskId), taskResponseSchema, signal)).data;
}

export async function fetchTags(workspaceId: string, signal?: AbortSignal): Promise<TagDto[]> {
  return (await apiGet(`${workspacePath(workspaceId)}/tags`, tagListResponseSchema, signal)).data;
}

export function createTagRequest(workspaceId: string, input: CreateTagInput) {
  return prepareMutation({
    method: 'POST',
    path: `${workspacePath(workspaceId)}/tags`,
    input,
    inputSchema: createTagInputSchema,
    responseSchema: tagResponseSchema,
  });
}

export function updateTagRequest(workspaceId: string, tagId: string, input: UpdateTagInput) {
  return prepareMutation({
    method: 'PATCH',
    path: `${workspacePath(workspaceId)}/tags/${encodeURIComponent(tagId)}`,
    input,
    inputSchema: updateTagInputSchema,
    responseSchema: tagResponseSchema,
  });
}

export function createTaskRequest(workspaceId: string, input: CreateTaskInput) {
  return prepareMutation({
    method: 'POST',
    path: `${workspacePath(workspaceId)}/tasks`,
    input,
    inputSchema: createTaskInputSchema,
    responseSchema: taskResponseSchema,
  });
}

export function updateTaskRequest(workspaceId: string, taskId: string, input: UpdateTaskInput) {
  return prepareMutation({
    method: 'PATCH',
    path: taskPath(workspaceId, taskId),
    input,
    inputSchema: updateTaskInputSchema,
    responseSchema: taskResponseSchema,
  });
}

export function archiveTaskRequest(workspaceId: string, taskId: string, input: ArchiveTaskInput) {
  return prepareMutation({
    method: 'POST',
    path: `${taskPath(workspaceId, taskId)}/archive`,
    input,
    inputSchema: archiveTaskInputSchema,
    responseSchema: taskResponseSchema,
  });
}

export function restoreTaskRequest(workspaceId: string, taskId: string, input: RestoreTaskInput) {
  return prepareMutation({
    method: 'POST',
    path: `${taskPath(workspaceId, taskId)}/restore`,
    input,
    inputSchema: restoreTaskInputSchema,
    responseSchema: taskResponseSchema,
  });
}

export async function createTag(workspaceId: string, input: CreateTagInput, options: MutationOptions): Promise<TagDto> {
  return (await sendMutation(createTagRequest(workspaceId, input), options)).data;
}

export async function updateTag(
  workspaceId: string,
  tagId: string,
  input: UpdateTagInput,
  options: MutationOptions,
): Promise<TagDto> {
  return (await sendMutation(updateTagRequest(workspaceId, tagId, input), options)).data;
}

export async function createTask(workspaceId: string, input: CreateTaskInput, options: MutationOptions): Promise<TaskDto> {
  return (await sendMutation(createTaskRequest(workspaceId, input), options)).data;
}

export async function updateTask(
  workspaceId: string,
  taskId: string,
  input: UpdateTaskInput,
  options: MutationOptions,
): Promise<TaskDto> {
  return (await sendMutation(updateTaskRequest(workspaceId, taskId, input), options)).data;
}

export async function archiveTask(
  workspaceId: string,
  taskId: string,
  input: ArchiveTaskInput,
  options: MutationOptions,
): Promise<TaskDto> {
  return (await sendMutation(archiveTaskRequest(workspaceId, taskId, input), options)).data;
}

export async function restoreTask(
  workspaceId: string,
  taskId: string,
  input: RestoreTaskInput,
  options: MutationOptions,
): Promise<TaskDto> {
  return (await sendMutation(restoreTaskRequest(workspaceId, taskId, input), options)).data;
}
