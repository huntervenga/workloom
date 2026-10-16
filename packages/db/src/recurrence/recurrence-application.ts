import {
  authorizeWorkspace,
  createRecurrenceApplication as createDomainRecurrenceApplication,
  isDomainError,
  temporarilyUnavailableError,
  type RecurrenceApplication,
  type RecurrenceUnitOfWork,
} from '@workloom/domain';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { createRecurrenceRepository } from '../repositories/recurrence-repository.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from './census-scope.js';

export interface RecurrenceApplicationOptions extends WorkspaceWriteOptions {
  /** HMAC key (≥32 bytes) for list and materialization cursors; omitted: a random per-instance key. */
  readonly cursorSecret?: string;
}

/**
 * Same pool and workspace barrier as every other write. Writes get the shared same-TX census scope;
 * reads are repeatable-read, read-only transactions over a repository that refuses every mutation, so
 * previews never materialize, reserve headers or invent entity IDs.
 */
export function createRecurrenceApplication(
  source: Database | WorkloomExecutor,
  options: RecurrenceApplicationOptions = {},
): RecurrenceApplication {
  const { cursorSecret, ...writeOptions } = options;
  const runner = createWorkspaceWriteRunner(source, writeOptions);
  const db = isDatabase(source) ? source.db : source;
  const runtime = createRecurrenceRuntime(cursorSecret === undefined ? {} : { cursorSecret });
  const writer: RecurrenceUnitOfWork = {
    run(ctx, cap, work) {
      return runner.run(ctx, cap, (scope) => {
        const composed = composeRecurrenceCensusScope(scope, runtime);
        return work(composed);
      });
    },
    async read(ctx, cap, work) {
      try {
        return await db.transaction(
          async (tx) => {
            const repo = createRecurrenceRepository(tx, { readOnly: true });
            await authorizeWorkspace(repo.planning.tasks.access, ctx, cap);
            return work(repo);
          },
          { isolationLevel: 'repeatable read', accessMode: 'read only' },
        );
      } catch (error) {
        if (!isDomainError(error) && isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(error);
        throw error;
      }
    },
  };
  return createDomainRecurrenceApplication({ writer, tools: runtime.tools, composer: runtime.composer });
}
