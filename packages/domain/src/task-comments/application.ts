import type { CreateTaskCommentInput, TaskActivityDto, TaskActivityQueryInput, TaskCommentDto, TaskCommentsQueryInput } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
export interface TaskCommentsApplication {
  createComment(context: CommandContext, taskId: string, input: CreateTaskCommentInput): Promise<TaskCommentDto>;
  listComments(context: CommandContext, taskId: string, query: TaskCommentsQueryInput): Promise<{ items: TaskCommentDto[]; nextCursor: string | null }>;
  listActivity(context: CommandContext, taskId: string, query: TaskActivityQueryInput): Promise<{ items: TaskActivityDto[]; nextCursor: string | null }>;
}
