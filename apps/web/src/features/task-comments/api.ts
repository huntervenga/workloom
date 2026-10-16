import {
  createTaskCommentInputSchema, taskCommentResponseSchema, taskCommentsQuerySchema,
  taskCommentsResponseSchema, taskActivityQuerySchema, taskActivityResponseSchema,
  type CreateTaskCommentInput, type TaskCommentDto, type TaskActivityDto,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export interface TimelinePage<T> { rows: T[]; nextCursor: string | null }
export const TIMELINE_PAGE_SIZE = 50;
const inContext = (row: { workspaceId: string; taskId: string }, workspaceId: string, taskId: string) => row.workspaceId === workspaceId.toLowerCase() && row.taskId === taskId.toLowerCase();
const path = (workspaceId: string, taskId: string) => `${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}`;
function params(kind: 'comments' | 'activity', cursor: string | null) {
  const result = (kind === 'comments' ? taskCommentsQuerySchema : taskActivityQuerySchema).safeParse({ limit: TIMELINE_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
  if (!result.success) throw new ApiError({ kind: 'invalid_input', status: null });
  return new URLSearchParams(Object.entries(result.data).map(([key, value]) => [key, String(value)]));
}
export async function fetchComments(workspaceId: string, taskId: string, cursor: string | null, signal?: AbortSignal): Promise<TimelinePage<TaskCommentDto>> {
  const result = await apiGet(`${path(workspaceId, taskId)}/comments?${params('comments', cursor)}`, taskCommentsResponseSchema.refine(result => result.data.every(row => inContext(row, workspaceId, taskId))), signal);
  return { rows: result.data, nextCursor: result.meta.nextCursor };
}
export async function fetchActivity(workspaceId: string, taskId: string, cursor: string | null, signal?: AbortSignal): Promise<TimelinePage<TaskActivityDto>> {
  const result = await apiGet(`${path(workspaceId, taskId)}/activity?${params('activity', cursor)}`, taskActivityResponseSchema.refine(result => result.data.every(row => inContext(row, workspaceId, taskId))), signal);
  return { rows: result.data, nextCursor: result.meta.nextCursor };
}
export function createCommentRequest(workspaceId: string, taskId: string, input: CreateTaskCommentInput) {
  return prepareMutation({ method: 'POST', path: `${path(workspaceId, taskId)}/comments`, input, inputSchema: createTaskCommentInputSchema, responseSchema: taskCommentResponseSchema.refine(result => inContext(result.data, workspaceId, taskId)) });
}
