import {
  taskScheduleContextInputSchema, taskScheduleContextResponseSchema, taskScheduleBatchInputSchema,
  taskSchedulePreviewResponseSchema, taskScheduleApplyInputSchema, taskScheduleApplyResponseSchema,
  type TaskScheduleContextQuery, type TaskScheduleBatchInput, type TaskScheduleApplyInput,
} from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
const path = (w: string, p: string) => `${workspacePath(w)}/projects/${encodeURIComponent(p)}`;
export async function fetchScheduleContext(w: string, p: string, input: TaskScheduleContextQuery, signal?: AbortSignal) {
  const parsed = taskScheduleContextInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams({ taskIds: parsed.data.taskIds.join(',') });
  if (parsed.data.baselineId) params.set('baselineId', parsed.data.baselineId);
  const result = (await apiGet(`${path(w, p)}/schedule-context?${params}`, taskScheduleContextResponseSchema, signal)).data;
  const expected = new Set(parsed.data.taskIds);
  if (result.projectId !== p.toLowerCase() || result.rows.length !== expected.size || result.rows.some(row => !expected.delete(row.taskId)) || result.baseline?.baselineId !== parsed.data.baselineId && !(result.baseline === null && parsed.data.baselineId === undefined)) throw new ApiError({ kind: 'invalid_response', status: 200 });
  return result;
}
export async function previewSchedule(w: string, p: string, input: TaskScheduleBatchInput, signal?: AbortSignal) {
  const parsed = taskScheduleBatchInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(`${path(w, p)}/schedule-preview`, { method: 'POST', body: parsed.data, signal });
  const result = taskSchedulePreviewResponseSchema.safeParse(response.payload);
  if (!result.success || result.data.data.projectId !== p.toLowerCase() || result.data.data.rows.length !== new Set(result.data.data.rows.map(row => row.taskId)).size || result.data.data.rows.length !== parsed.data.rows.length || result.data.data.rows.some(row => { const desired = parsed.data.rows.find(item => item.taskId === row.taskId); return !desired || desired.expectedRevision !== row.expectedRevision || desired.startDate !== row.after.startDate || desired.dueDate !== row.after.dueDate; })) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return result.data.data;
}
export function applyScheduleRequest(w: string, p: string, input: TaskScheduleApplyInput) {
  const parsed = taskScheduleApplyInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const normalized = parsed.data;
  return prepareMutation({
    method: 'POST', path: `${path(w, p)}/schedule-apply`, input: normalized, inputSchema: taskScheduleApplyInputSchema,
    responseSchema: taskScheduleApplyResponseSchema.refine(result => result.data.projectId === p.toLowerCase() && result.data.tasks.length === normalized.rows.length && new Set(result.data.tasks.map(task => task.id)).size === normalized.rows.length && result.data.tasks.every(task => normalized.rows.some(row => row.taskId === task.id))),
  });
}
