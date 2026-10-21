import { and, asc, eq } from 'drizzle-orm';
import { createWorkspaceSlugService, DomainError, type WorkspaceSlugApplication, type WorkspaceSlugRepository } from '@workloom/domain';
import { type Database, type WorkloomExecutor } from '../client.js';
import { workspaces, workspaceSlugAliases } from '../schema.js';
import { createWorkspaceWriteRunner } from '../transactions/workspace-write.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { digest } from '../local-mcp/credentials.js';

export function createWorkspaceSlugApplication(source: Database | WorkloomExecutor): WorkspaceSlugApplication {
  const writer = createWorkspaceWriteRunner(source);
  return createWorkspaceSlugService({ digest, writer: { run(context, capability, work) {
    return writer.run(context, capability, async scope => {
      const tx = scope.tx, tasks = createTaskRepository(tx);
      const repository: WorkspaceSlugRepository = {
        receipt: (actor, key) => tasks.findIdempotency(context.workspaceId, actor, 'workspace.slug.update', key),
        saveReceipt: (actor, key, payloadHash, result, at) => tasks.insertIdempotency({ workspaceId: context.workspaceId,
          actorUserId: actor, command: 'workspace.slug.update', idempotencyKey: key, payloadHash, result, createdAt: at.toISOString() }),
        async aliases() { return (await tx.select({ slug: workspaceSlugAliases.slug }).from(workspaceSlugAliases)
          .where(eq(workspaceSlugAliases.workspaceId, context.workspaceId)).orderBy(asc(workspaceSlugAliases.slug)).limit(101)).map(row => row.slug); },
        async claimAlias(slug, at) {
          await tx.insert(workspaceSlugAliases).values({ slug, workspaceId: context.workspaceId, createdAt: at }).onConflictDoNothing();
          const [claimed] = await tx.select({ workspaceId: workspaceSlugAliases.workspaceId }).from(workspaceSlugAliases)
            .where(eq(workspaceSlugAliases.slug, slug)).limit(1);
          return claimed?.workspaceId === context.workspaceId;
        },
        async setCurrent(slug, expectedRevision, at) {
          const [changed] = await tx.update(workspaces).set({ slug, slugRevision: expectedRevision + 1, updatedAt: at })
            .where(and(eq(workspaces.id, context.workspaceId), eq(workspaces.slugRevision, expectedRevision))).returning({ revision: workspaces.slugRevision });
          if (!changed) throw new DomainError('REVISION_CONFLICT', 'The company address changed.');
          return changed.revision;
        },
      };
      return work({ ...scope, repository });
    });
  } } });
}
