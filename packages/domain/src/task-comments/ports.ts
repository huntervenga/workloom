import type { TaskActivityDto, TaskCommentDto, TaskTimelineItemDto } from '@workloom/contracts';
import type { AccessRepository } from '../access/ports.js';
import type { CommandContext } from '../access/context.js';
import type { Capability } from '../access/capabilities.js';
import type { IdempotencyRecord } from '../tasks/ports.js';
import type { WorkspaceWriteScope } from '../transactions/ports.js';
import type { PlanningMutationGuard } from '../planning/ports.js';

export interface TaskCommentAnchor { readonly createdAt: string; readonly id: string }
export interface TaskActivityAnchor { readonly changeSeq: string; readonly eventOrdinal: number }
interface CursorBinding {
  readonly version: 1; readonly workspaceId: string; readonly taskId: string;
  readonly actorUserId: string; readonly membershipId: string; readonly permissionEpoch: string; readonly limit: number;
}
export type TaskTimelineCursor = (CursorBinding & TaskCommentAnchor & { readonly kind: 'task-comments' }) | (CursorBinding & TaskActivityAnchor & { readonly kind: 'task-activity' }) | (CursorBinding & TaskActivityAnchor & { readonly kind: 'task-timeline' });
export interface CommentTarget { readonly id: string; readonly projectId: string; readonly visibility: 'workspace'; readonly archivedAt: string | null; readonly projectArchivedAt: string | null }
export interface TaskCommentsRepository {
  readonly access: AccessRepository;
  permissionEpoch(workspaceId: string): Promise<string>;
  findTarget(workspaceId: string, taskId: string): Promise<CommentTarget | null>;
  listComments(workspaceId: string, taskId: string, after: TaskCommentAnchor | null, take: number): Promise<TaskCommentDto[]>;
  listActivity(workspaceId: string, taskId: string, after: TaskActivityAnchor | null, take: number): Promise<TaskActivityDto[]>;
  /** One bounded keyset statement over comments and typed activity, `(changeSeq, eventOrdinal)` DESC, at most 101 rows. */
  listTimeline(workspaceId: string, taskId: string, after: TaskActivityAnchor | null, take: number): Promise<TaskTimelineItemDto[]>;
  insertComment(comment: TaskCommentDto): Promise<void>;
  findIdempotency(workspaceId: string, actorUserId: string, command: string, key: string): Promise<IdempotencyRecord | null>;
  insertIdempotency(receipt: IdempotencyRecord): Promise<void>;
}
export interface TaskCommentsWriteScope extends WorkspaceWriteScope { readonly repository: TaskCommentsRepository; readonly planningGuard: PlanningMutationGuard }
export interface TaskCommentsUnitOfWork {
  read<R>(work: (repository: TaskCommentsRepository) => Promise<R>): Promise<R>;
  run<R>(context: CommandContext, capability: Capability, work: (scope: TaskCommentsWriteScope) => Promise<R>): Promise<R>;
}
export interface TaskCommentsTools {
  newId(): string; digest(value: string): string;
  encodeCursor(cursor: TaskTimelineCursor): string; decodeCursor(token: string): TaskTimelineCursor;
}
