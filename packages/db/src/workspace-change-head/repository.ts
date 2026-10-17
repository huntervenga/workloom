import { eq } from 'drizzle-orm';
import type { WorkspaceChangeHeadReadRepository } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { workspaces } from '../schema.js';

/** All reads use the caller-owned transaction, without locking the workspace. */
export function createWorkspaceChangeHeadReadRepository(db: WorkloomExecutor): WorkspaceChangeHeadReadRepository {
  return {
    access: createAccessRepository(db),
    async findHead(workspaceId) {
      const [row] = await db.select({ workspaceId: workspaces.id, changeSeq: workspaces.changeSeq, permissionEpoch: workspaces.permissionEpoch })
        .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      return row ?? null;
    },
  };
}
