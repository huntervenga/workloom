import { idSchema, myTasksQuerySchema } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import type { MyTasksApplication } from './application.js';
import type { MyTasksAnchor, MyTasksReadUnitOfWork, MyTasksTools } from './ports.js';

function contextWithCanonicalIds(context: CommandContext): CommandContext {
  const workspace = idSchema.safeParse(context.workspaceId);
  if (!workspace.success) throw notFoundError();
  const actor = idSchema.safeParse(context.actor.userId);
  if (!actor.success) throw unauthenticatedError();
  return { ...context, workspaceId: workspace.data, actor: { ...context.actor, userId: actor.data } };
}
function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', 'Reload the personal task list.', { details: { fields: ['cursor'] } });
}

/** Read only: no mutation runner, planning guard, cutoff or materialization is invoked. */
export function createMyTasksApplication(snapshots: MyTasksReadUnitOfWork, tools: MyTasksTools): MyTasksApplication {
  return {
    async list(context, input) {
      const ctx = contextWithCanonicalIds(context);
      const parsed = myTasksQuerySchema.safeParse(input);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'The request is invalid.', { details: { fields: [...new Set(parsed.error.issues.map(issue => issue.path.map(String).join('.') || '(root)'))] } });
      const { cursor, ...filters } = parsed.data;
      return snapshots.run(async repository => {
        // Even an opaque cursor grants nothing: current membership is always checked first.
        const access = await authorizeWorkspace(repository.access, ctx, 'task.read');
        const membershipId = access.membership.id;
        const permissionEpoch = await repository.permissionEpoch(ctx.workspaceId);
        const queryHash = tools.digest(JSON.stringify({ relation: filters.relation, completion: filters.completion, includeArchived: filters.includeArchived, search: filters.search ?? '', limit: filters.limit }));
        const binding = { kind: 'my-tasks', version: 1, workspaceId: ctx.workspaceId, actorUserId: ctx.actor.userId, membershipId, permissionEpoch, queryHash } as const;
        let after: MyTasksAnchor | null = null;
        if (cursor !== undefined) {
          const stored = tools.decodeCursor(cursor);
          if (stored.kind !== binding.kind || stored.version !== binding.version || stored.workspaceId !== binding.workspaceId || stored.actorUserId !== binding.actorUserId || stored.membershipId !== binding.membershipId || stored.permissionEpoch !== binding.permissionEpoch || stored.queryHash !== binding.queryHash) throw invalidCursor();
          after = { dueDate: stored.dueDate, id: stored.id };
        }
        const rows = await repository.list(ctx.workspaceId, membershipId, filters, after, filters.limit + 1);
        const items = rows.slice(0, filters.limit);
        const last = items.at(-1);
        const nextCursor = rows.length > filters.limit && last ? tools.encodeCursor({ ...binding, dueDate: last.task.dueDate, id: last.task.id }) : null;
        return { items, nextCursor };
      });
    },
  };
}
