import {
  projectWorkCategoryBindingResponseSchema, updateProjectWorkCategoryBindingInputSchema,
  categorizedWorkLogResponseSchema, recategorizeWorkLogInputSchema,
  createWorkTypeReportRunInputSchema, workTypeReportRunListQuerySchema,
  workTypeReportRunResponseSchema, workTypeReportRunListResponseSchema,
  workTypeReportRowListResponseSchema, taskTimeSummaryQuerySchema, taskTimeSummaryResponseSchema,
  planningPageQuerySchema,
  type UpdateProjectWorkCategoryBindingInput, type RecategorizeWorkLogInput,
  type CreateWorkTypeReportRunInput, type WorkTypeReportRunDto, type WorkTypeReportRowDto,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation, type ResponseParser } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { workspacePath } from '../workspace/queries';

const part = (id: string) => encodeURIComponent(id);
const path = (workspaceId: string, suffix: string) => `${workspacePath(workspaceId)}${suffix}`;
const bindingPath = (workspaceId: string, projectId: string) => path(workspaceId, `/projects/${part(projectId)}/work-category-binding`);

function queryParams(schema: ResponseParser<object>, input: object): string {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(result.data)) {
    if (value !== undefined) params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return params.toString();
}

export async function fetchWorkCategoryBinding(workspaceId: string, projectId: string, signal?: AbortSignal) {
  return (await apiGet(bindingPath(workspaceId, projectId), projectWorkCategoryBindingResponseSchema, signal)).data;
}
export function updateWorkCategoryBindingRequest(workspaceId: string, projectId: string, input: UpdateProjectWorkCategoryBindingInput) {
  return prepareMutation({ method: 'PATCH', path: bindingPath(workspaceId, projectId), input, inputSchema: updateProjectWorkCategoryBindingInputSchema, responseSchema: projectWorkCategoryBindingResponseSchema });
}
export function recategorizeWorkLogRequest(workspaceId: string, workLogId: string, input: RecategorizeWorkLogInput) {
  return prepareMutation({ method: 'POST', path: path(workspaceId, `/worklogs/${part(workLogId)}/recategorize`), input, inputSchema: recategorizeWorkLogInputSchema, responseSchema: categorizedWorkLogResponseSchema });
}
export function createWorkTypeReportRequest(workspaceId: string, input: CreateWorkTypeReportRunInput) {
  return prepareMutation({ method: 'POST', path: path(workspaceId, '/work-type-report-runs'), input, inputSchema: createWorkTypeReportRunInputSchema, responseSchema: workTypeReportRunResponseSchema });
}
export async function fetchWorkTypeReportRuns(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<WorkTypeReportRunDto[]> {
  const items: WorkTypeReportRunDto[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const query = queryParams(workTypeReportRunListQuerySchema, { periodId, limit: 100, ...(cursor ? { cursor } : {}) });
    const result = await apiGet(path(workspaceId, `/work-type-report-runs?${query}`), workTypeReportRunListResponseSchema, signal);
    items.push(...result.data);
    cursor = result.meta.nextCursor ?? null;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new ApiError({ kind: 'invalid_response', status: 200 });
      seen.add(cursor);
    }
  } while (cursor !== null);
  return items;
}
export async function fetchWorkTypeReport(workspaceId: string, runId: string, signal?: AbortSignal) {
  return (await apiGet(path(workspaceId, `/work-type-report-runs/${part(runId)}`), workTypeReportRunResponseSchema, signal)).data;
}
export async function fetchWorkTypeReportRows(workspaceId: string, runId: string, cursor: string | null, signal?: AbortSignal): Promise<{ items: WorkTypeReportRowDto[]; nextCursor: string | null }> {
  const query = queryParams(planningPageQuerySchema, { limit: 50, ...(cursor ? { cursor } : {}) });
  const response = await apiGet(path(workspaceId, `/work-type-report-runs/${part(runId)}/rows?${query}`), workTypeReportRowListResponseSchema, signal);
  return { items: response.data, nextCursor: response.meta.nextCursor ?? null };
}

/** Canonical disjoint batches, preserving the contract's explicit maximum of 100 visible IDs. */
export function taskTimeChunks(taskIds: readonly string[]): string[][] {
  const ids = [...new Set(taskIds.filter(isUuid).map((id) => id.toLowerCase()))].sort();
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += 100) chunks.push(ids.slice(start, start + 100));
  return chunks;
}
export async function fetchTaskTimeSummary(workspaceId: string, projectId: string, periodId: string, taskIds: readonly string[], membershipId: string, signal?: AbortSignal) {
  const query = queryParams(taskTimeSummaryQuerySchema, { taskIds: taskIds.join(','), membershipId });
  return (await apiGet(path(workspaceId, `/projects/${part(projectId)}/periods/${part(periodId)}/task-time-summary?${query}`), taskTimeSummaryResponseSchema, signal)).data;
}
