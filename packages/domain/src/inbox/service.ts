import { INBOX_WINDOW_DAYS, idSchema, inboxQuerySchema } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import { roleHasCapability } from '../access/capabilities.js';
import { DomainError, notFoundError, unauthenticatedError } from '../errors.js';
import type { InboxApplication } from './application.js';
import type { InboxReadUnitOfWork } from './ports.js';

/** Read only: current membership is checked first, so a removed member sees nothing. */
export function createInboxApplication(snapshots: InboxReadUnitOfWork): InboxApplication {
  return {
    async list(context, input) {
      const workspace = idSchema.safeParse(context.workspaceId);
      if (!workspace.success) throw notFoundError();
      const actor = idSchema.safeParse(context.actor.userId);
      if (!actor.success) throw unauthenticatedError();
      const parsed = inboxQuerySchema.safeParse(input);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'The request is invalid.', { details: { fields: [...new Set(parsed.error.issues.map(issue => issue.path.map(String).join('.') || '(root)'))] } });
      const ctx = { ...context, workspaceId: workspace.data, actor: { ...context.actor, userId: actor.data } };
      return snapshots.run(async repository => {
        const access = await authorizeWorkspace(repository.access, ctx, 'task.read');
        return repository.list(ctx.workspaceId, access.membership.id, { windowDays: INBOX_WINDOW_DAYS, take: parsed.data.limit, includePendingLeave: roleHasCapability(access.membership.role, 'leave.approve') });
      });
    },
  };
}
