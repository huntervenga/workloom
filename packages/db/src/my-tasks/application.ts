import { createHash } from 'node:crypto';
import { createMyTasksApplication as createDomainMyTasksApplication, type MyTasksApplication } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { createMyTasksReadRepository } from './repository.js';
import { createMyTasksCursorCodec, type MyTasksCursorOptions } from './cursor.js';

/** A repeatable-read, read-only transaction owns all authorization and page/decorating reads. */
export function createMyTasksApplication(source: Database | WorkloomExecutor, options: MyTasksCursorOptions = {}): MyTasksApplication {
  const db = isDatabase(source) ? source.db : source;
  const codec = createMyTasksCursorCodec(options);
  return createDomainMyTasksApplication({ run: read => db.transaction(tx => read(createMyTasksReadRepository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }) }, { digest: value => createHash('sha256').update(value, 'utf8').digest('hex'), encodeCursor: codec.encode, decodeCursor: codec.decode });
}
