import { createTaskCommentInputSchema, idSchema, taskActivityQuerySchema, taskCommentSchema, taskCommentsQuerySchema, type TaskTimelineQuery } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import type { TaskCommentsApplication } from './application.js';
import type { TaskCommentsRepository, TaskCommentsTools, TaskCommentsUnitOfWork, TaskTimelineCursor } from './ports.js';
const command = 'task.comment.create' as const;
function context(value: CommandContext): CommandContext {
  const workspace = idSchema.safeParse(value.workspaceId), actor = idSchema.safeParse(value.actor.userId);
  if (!workspace.success) throw notFoundError();
  if (!actor.success) throw unauthenticatedError();
  return { ...value, workspaceId: workspace.data, actor: { ...value.actor, userId: actor.data } };
}
function taskId(value: string): string { const result = idSchema.safeParse(value); if (!result.success) throw notFoundError(); return result.data; }
function invalid(field: string): DomainError { return new DomainError('VALIDATION_FAILED', 'The request is invalid.', { details: { fields: [field] } }); }
async function target(repo: TaskCommentsRepository, ws: string, id: string) { const row = await repo.findTarget(ws, id); if (!row || row.visibility !== 'workspace') throw notFoundError(); return row; }

/** Comments change only their append-only rows and command metadata, never task/planning state. */
export function createTaskCommentsApplication(unit: TaskCommentsUnitOfWork, tools: TaskCommentsTools): TaskCommentsApplication {
  async function read(contextValue: CommandContext, path: string, input: unknown, kind: 'task-comments' | 'task-activity') {
    const ctx = context(contextValue), id = taskId(path);
    const parsed = (kind === 'task-comments' ? taskCommentsQuerySchema : taskActivityQuerySchema).safeParse(input);
    if (!parsed.success) throw invalid('query');
    const query: TaskTimelineQuery = parsed.data;
    return unit.read(async repo => {
      const access = await authorizeWorkspace(repo.access, ctx, 'task.read');
      await target(repo, ctx.workspaceId, id);
      const permissionEpoch = await repo.permissionEpoch(ctx.workspaceId);
      const binding = { version: 1, workspaceId: ctx.workspaceId, taskId: id, actorUserId: ctx.actor.userId, membershipId: access.membership.id, permissionEpoch, limit: query.limit } as const;
      let cursor: TaskTimelineCursor | null = null;
      if (query.cursor !== undefined) {
        cursor = tools.decodeCursor(query.cursor);
        if (cursor.kind !== kind || cursor.version !== binding.version || cursor.workspaceId !== binding.workspaceId || cursor.taskId !== binding.taskId || cursor.actorUserId !== binding.actorUserId || cursor.membershipId !== binding.membershipId || cursor.permissionEpoch !== binding.permissionEpoch || cursor.limit !== binding.limit) throw invalid('cursor');
      }
      if (kind === 'task-comments') {
        const after = cursor?.kind === 'task-comments' ? { createdAt: cursor.createdAt, id: cursor.id } : null;
        const rows = await repo.listComments(ctx.workspaceId, id, after, query.limit + 1), items = rows.slice(0, query.limit), last = items.at(-1);
        return { kind, items, nextCursor: rows.length > query.limit && last ? tools.encodeCursor({ ...binding, kind, createdAt: last.createdAt, id: last.id }) : null } as const;
      }
      const after = cursor?.kind === 'task-activity' ? { changeSeq: cursor.changeSeq, eventOrdinal: cursor.eventOrdinal } : null;
      const rows = await repo.listActivity(ctx.workspaceId, id, after, query.limit + 1), items = rows.slice(0, query.limit), last = items.at(-1);
      return { kind, items, nextCursor: rows.length > query.limit && last ? tools.encodeCursor({ ...binding, kind, changeSeq: last.changeSeq, eventOrdinal: last.eventOrdinal }) : null } as const;
    });
  }
  return {
    async listComments(ctx, id, query) { const result = await read(ctx, id, query, 'task-comments'); if (result.kind !== 'task-comments') throw new Error('Wrong task timeline result.'); return { items: result.items, nextCursor: result.nextCursor }; },
    async listActivity(ctx, id, query) { const result = await read(ctx, id, query, 'task-activity'); if (result.kind !== 'task-activity') throw new Error('Wrong task timeline result.'); return { items: result.items, nextCursor: result.nextCursor }; },
    async createComment(contextValue, path, input) {
      const ctx = context(contextValue), id = taskId(path), parsed = createTaskCommentInputSchema.safeParse(input), key = ctx.idempotencyKey;
      if (!parsed.success) throw invalid('body');
      if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw invalid('Idempotency-Key');
      const payloadHash = tools.digest(canonicalJson({ command, target: id, input: parsed.data }));
      return unit.run(ctx, 'task.edit', async scope => {
        const repo = scope.repository, ws = ctx.workspaceId;
        // A stored outcome grants no access: current task scope is checked before any receipt.
        const current = await target(repo, ws, id);
        const old = await repo.findIdempotency(ws, ctx.actor.userId, command, key);
        if (old) {
          if (old.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This operation key belongs to another request.');
          const stored = taskCommentSchema.safeParse(old.result);
          if (!stored.success) throw new Error('Stored comment outcome does not match its contract.');
          return stored.data;
        }
        if (current.archivedAt || current.projectArchivedAt) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the task and project before adding a comment.');
        const rejected = await scope.planningGuard.check({ family: 'comment', command, target: { taskId: id }, input: parsed.data });
        if (rejected) throw new Error('An inert comment unexpectedly entered a planning mutation.');
        const createdAt = scope.barrierAt.toISOString();
        const comment = taskCommentSchema.parse({ id: tools.newId(), workspaceId: ws, taskId: id, authorUserId: ctx.actor.userId, authorMembershipId: scope.access.membership.id, authorDisplayNameSnapshot: scope.access.membership.displayName, createdAt, body: parsed.data.body });
        await repo.insertComment(comment);
        await scope.recordChange({ entityType: 'task_comment', entityId: comment.id, action: 'created', diff: { taskId: id, projectId: current.projectId }, outbox: { type: 'task_comment.created', payload: { workspaceId: ws, taskId: id, projectId: current.projectId, commentId: comment.id } } });
        await repo.insertIdempotency({ workspaceId: ws, actorUserId: ctx.actor.userId, command, idempotencyKey: key, payloadHash, result: comment, createdAt });
        return comment;
      });
    },
  };
}
