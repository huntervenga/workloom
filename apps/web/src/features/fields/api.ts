import {
  createTaskFieldInputSchema,
  createTaskFieldOptionInputSchema,
  projectColumnsResponseSchema,
  setTaskFieldValueInputSchema,
  taskFieldBatchQuerySchema,
  taskFieldDefinitionListResponseSchema,
  taskFieldDefinitionResponseSchema,
  taskFieldHistoryQuerySchema,
  taskFieldListQuerySchema,
  taskFieldValueHistoryListResponseSchema,
  taskFieldValueListResponseSchema,
  taskFieldValueResponseSchema,
  updateProjectColumnsInputSchema,
  updateTaskFieldInputSchema,
  updateTaskFieldOptionInputSchema,
  type CreateTaskFieldInput,
  type CreateTaskFieldOptionInput,
  type ProjectColumnsDto,
  type SetTaskFieldValueInput,
  type TaskFieldDefinitionDto,
  type TaskFieldValueDto,
  type TaskFieldValueHistoryDto,
  type UpdateProjectColumnsInput,
  type UpdateTaskFieldInput,
  type UpdateTaskFieldOptionInput,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation, type ResponseParser } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { workspacePath } from '../workspace/queries';

/** Most task IDs one batch value request may carry. */
export const FIELD_VALUE_BATCH_SIZE = 200;

/** Default page size of value history; the contract allows 1–100. */
export const FIELD_HISTORY_PAGE_SIZE = 50;

export interface FieldHistoryPage {
  entries: TaskFieldValueHistoryDto[];
  /** Cursor of the next page, null when this page is the last one. */
  nextCursor: string | null;
}

function fieldPath(workspaceId: string, fieldId: string): string {
  return `${workspacePath(workspaceId)}/fields/${encodeURIComponent(fieldId)}`;
}

function projectPath(workspaceId: string, projectId: string): string {
  return `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
}

function taskValuesPath(workspaceId: string, taskId: string): string {
  return `${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}/field-values`;
}

/** Parses query parameters with the shared schema; nothing is sent when they do not pass. */
function searchParams(schema: ResponseParser<object>, input: object): URLSearchParams {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return params;
}

/**
 * Splits loaded task IDs into canonical batches: valid UUIDs only, lowercase, unique, sorted,
 * at most `FIELD_VALUE_BATCH_SIZE` each. Equal sets give equal batches, so they share cache.
 */
export function fieldValueTaskIdChunks(taskIds: readonly string[]): string[][] {
  const ids = [...new Set(taskIds.filter(isUuid).map((id) => id.toLowerCase()))].sort();
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += FIELD_VALUE_BATCH_SIZE) {
    chunks.push(ids.slice(start, start + FIELD_VALUE_BATCH_SIZE));
  }
  return chunks;
}

export async function fetchTaskFields(
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<TaskFieldDefinitionDto[]> {
  const params = searchParams(taskFieldListQuerySchema, { projectId });
  const path = `${workspacePath(workspaceId)}/fields?${params.toString()}`;
  return (await apiGet(path, taskFieldDefinitionListResponseSchema, signal)).data;
}

export async function fetchProjectColumns(
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectColumnsDto> {
  return (await apiGet(`${projectPath(workspaceId, projectId)}/columns`, projectColumnsResponseSchema, signal)).data;
}

export async function fetchTaskFieldValues(
  workspaceId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskFieldValueDto[]> {
  return (await apiGet(taskValuesPath(workspaceId, taskId), taskFieldValueListResponseSchema, signal)).data;
}

/** One batch of 1–200 task IDs; see `fieldValueTaskIdChunks` for larger sets. */
export async function fetchProjectFieldValues(
  workspaceId: string,
  projectId: string,
  taskIds: readonly string[],
  signal?: AbortSignal,
): Promise<TaskFieldValueDto[]> {
  const params = searchParams(taskFieldBatchQuerySchema, { taskIds: taskIds.join(',') });
  const path = `${projectPath(workspaceId, projectId)}/field-values?${params.toString()}`;
  return (await apiGet(path, taskFieldValueListResponseSchema, signal)).data;
}

export async function fetchTaskFieldHistoryPage(
  workspaceId: string,
  taskId: string,
  fieldId: string,
  options: { limit?: number | undefined; cursor?: string | null | undefined; signal?: AbortSignal | undefined } = {},
): Promise<FieldHistoryPage> {
  const params = searchParams(taskFieldHistoryQuerySchema, {
    limit: options.limit ?? FIELD_HISTORY_PAGE_SIZE,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  const path = `${taskValuesPath(workspaceId, taskId)}/${encodeURIComponent(fieldId)}/history?${params.toString()}`;
  const { data, meta } = await apiGet(path, taskFieldValueHistoryListResponseSchema, options.signal);
  return { entries: data, nextCursor: meta.nextCursor ?? null };
}

export function createTaskFieldRequest(workspaceId: string, input: CreateTaskFieldInput) {
  return prepareMutation({
    method: 'POST',
    path: `${workspacePath(workspaceId)}/fields`,
    input,
    inputSchema: createTaskFieldInputSchema,
    responseSchema: taskFieldDefinitionResponseSchema,
  });
}

export function updateTaskFieldRequest(workspaceId: string, fieldId: string, input: UpdateTaskFieldInput) {
  return prepareMutation({
    method: 'PATCH',
    path: fieldPath(workspaceId, fieldId),
    input,
    inputSchema: updateTaskFieldInputSchema,
    responseSchema: taskFieldDefinitionResponseSchema,
  });
}

export function createTaskFieldOptionRequest(workspaceId: string, fieldId: string, input: CreateTaskFieldOptionInput) {
  return prepareMutation({
    method: 'POST',
    path: `${fieldPath(workspaceId, fieldId)}/options`,
    input,
    inputSchema: createTaskFieldOptionInputSchema,
    responseSchema: taskFieldDefinitionResponseSchema,
  });
}

export function updateTaskFieldOptionRequest(
  workspaceId: string,
  fieldId: string,
  optionId: string,
  input: UpdateTaskFieldOptionInput,
) {
  return prepareMutation({
    method: 'PATCH',
    path: `${fieldPath(workspaceId, fieldId)}/options/${encodeURIComponent(optionId)}`,
    input,
    inputSchema: updateTaskFieldOptionInputSchema,
    responseSchema: taskFieldDefinitionResponseSchema,
  });
}

export function updateProjectColumnsRequest(workspaceId: string, projectId: string, input: UpdateProjectColumnsInput) {
  return prepareMutation({
    method: 'PATCH',
    path: `${projectPath(workspaceId, projectId)}/columns`,
    input,
    inputSchema: updateProjectColumnsInputSchema,
    responseSchema: projectColumnsResponseSchema,
  });
}

export function setTaskFieldValueRequest(workspaceId: string, taskId: string, fieldId: string, input: SetTaskFieldValueInput) {
  return prepareMutation({
    method: 'PUT',
    path: `${taskValuesPath(workspaceId, taskId)}/${encodeURIComponent(fieldId)}`,
    input,
    inputSchema: setTaskFieldValueInputSchema,
    responseSchema: taskFieldValueResponseSchema,
  });
}
