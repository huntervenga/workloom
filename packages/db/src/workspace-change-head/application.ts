import { createWorkspaceChangeHeadApplication as createDomainWorkspaceChangeHeadApplication, type WorkspaceChangeHeadApplication } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { createWorkspaceChangeHeadReadRepository } from './repository.js';

/** Current access and scalar values share one read-only PostgreSQL snapshot. */
export function createWorkspaceChangeHeadApplication(source: Database | WorkloomExecutor): WorkspaceChangeHeadApplication {
  const db = isDatabase(source) ? source.db : source;
  return createDomainWorkspaceChangeHeadApplication({
    run: read => db.transaction(tx => read(createWorkspaceChangeHeadReadRepository(tx)), {
      isolationLevel: 'repeatable read', accessMode: 'read only',
    }),
  });
}
