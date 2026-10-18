import {
  createTaskCommentInputSchema, taskCommentResponseSchema, taskCommentsQuerySchema,
  taskCommentsResponseSchema, taskActivityQuerySchema, taskActivityResponseSchema,
  taskTimelineQuerySchema, taskTimelineResponseSchema,
  type CreateTaskCommentInput, type TaskCommentDto, type TaskActivityDto, type TaskTimelineItemDto,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export interface TimelinePage<T> { rows: T[]; nextCursor: string | null }
export const TIMELINE_PAGE_SIZE = 50;
const inContext = (row: { workspaceId: string; taskId: string }, workspaceId: string, taskId: string) => row.workspaceId === workspaceId.toLowerCase() && row.taskId === taskId.toLowerCase();
const path = (workspaceId: string, taskId: string) => `${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}`;
const querySchemas = { comments: taskCommentsQuerySchema, activity: taskActivityQuerySchema, timeline: taskTimelineQuerySchema };
function params(kind: keyof typeof querySchemas, cursor: string | null) {
  const result = querySchemas[kind].safeParse({ limit: TIMELINE_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
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
/** Every unified row, and an embedded comment, must belong to the requested workspace and task. */
export const timelineRowsInContext = (rows: readonly TaskTimelineItemDto[], workspaceId: string, taskId: string) =>
  rows.every(row => inContext(row, workspaceId, taskId) && (row.type !== 'comment' || inContext(row.comment, workspaceId, taskId)));
/** One server-ordered page (changeSeq, eventOrdinal DESC) of comments and activity under a single cursor. */
export async function fetchTimeline(workspaceId: string, taskId: string, cursor: string | null, signal?: AbortSignal): Promise<TimelinePage<TaskTimelineItemDto>> {
  const result = await apiGet(`${path(workspaceId, taskId)}/timeline?${params('timeline', cursor)}`, taskTimelineResponseSchema.refine(result => timelineRowsInContext(result.data, workspaceId, taskId)), signal);
  return { rows: result.data, nextCursor: result.meta.nextCursor };
}
export function createCommentRequest(workspaceId: string, taskId: string, input: CreateTaskCommentInput) {
  return prepareMutation({ method: 'POST', path: `${path(workspaceId, taskId)}/comments`, input, inputSchema: createTaskCommentInputSchema, responseSchema: taskCommentResponseSchema.refine(result => inContext(result.data, workspaceId, taskId)) });
}
