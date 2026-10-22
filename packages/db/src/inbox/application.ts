import { createInboxApplication as createDomainInboxApplication, type InboxApplication } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { createInboxReadRepository } from './repository.js';

export function createInboxApplication(source: Database | WorkloomExecutor): InboxApplication {
  const db = isDatabase(source) ? source.db : source;
  return createDomainInboxApplication({ run: read => db.transaction(tx => read(createInboxReadRepository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }) });
}
