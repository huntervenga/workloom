import { idSchema, workspaceChangeHeadSchema } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import { notFoundError, unauthenticatedError } from '../errors.js';
import type { WorkspaceChangeHeadApplication } from './application.js';
import type { WorkspaceChangeHeadReadUnitOfWork } from './ports.js';

function canonicalContext(context: CommandContext): CommandContext {
  const workspace = idSchema.safeParse(context.workspaceId);
  if (!workspace.success) throw notFoundError();
  const actor = idSchema.safeParse(context.actor.userId);
  if (!actor.success) throw unauthenticatedError();
  return { ...context, workspaceId: workspace.data, actor: { ...context.actor, userId: actor.data } };
}
const sameId = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** An independently authorized read on every execution, with no write prerequisites. */
export function createWorkspaceChangeHeadApplication(snapshots: WorkspaceChangeHeadReadUnitOfWork): WorkspaceChangeHeadApplication {
  return {
    async getHead(context) {
      const ctx = canonicalContext(context);
      return snapshots.run(async repository => {
        const access = await authorizeWorkspace(repository.access, ctx, 'workspace.read');
        const { membership, workspace } = access;
        if (!sameId(workspace.id, ctx.workspaceId) || !sameId(membership.workspaceId, ctx.workspaceId) || !sameId(membership.userId, ctx.actor.userId) || !idSchema.safeParse(membership.id).success) {
          throw notFoundError();
        }
        const head = await repository.findHead(ctx.workspaceId);
        if (head === null || !sameId(head.workspaceId, ctx.workspaceId)) throw notFoundError();
        return workspaceChangeHeadSchema.parse({
          workspaceId: workspace.id,
          actorUserId: membership.userId,
          membershipId: membership.id,
          membershipRevision: membership.revision,
          role: membership.role,
          changeSeq: head.changeSeq.toString(),
          permissionEpoch: head.permissionEpoch.toString(),
        });
      });
    },
  };
}
