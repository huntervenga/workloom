import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { authorizeWorkspace, createGenericReportService, createPlanningMutationGuard, notFoundError, temporarilyUnavailableError, type GenericReportApplication, type GenericReportScope, type CommandContext } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { workspaces } from '../schema.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createGenericReportRepository } from './repository.js';
export function createGenericReportApplication(source: Database | WorkloomExecutor): GenericReportApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source);
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const recurrence = createRecurrenceRuntime();
  function compose(scope: DbWorkspaceWriteScope): GenericReportScope { return { ...scope, repository: createTaskFieldRepository(scope.tx), reports: createGenericReportRepository(scope.tx, scope.context.workspaceId), planningGuard: createPlanningMutationGuard(composeRecurrenceCensusScope(scope, recurrence), tools) }; }
  return createGenericReportService({ ...tools,
    write: (context, capability, work) => writer.run(context, capability, scope => work(compose(scope))),
    read: (context: CommandContext, capability, work) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='15000'`); await tx.execute(sql`set local lock_timeout='5000'`);
      // Shared barrier blocks every ordinary writer while scope, values and current permissions are read.
      // No UPDATE occurs in this transaction; FOR SHARE requires a non-read-only transaction mode.
      await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, context.workspaceId)).for('share'); if (!locked.length) throw notFoundError();
      const access = await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const value = await work(compose({ tx, context, access, barrierAt: new Date(), recordChange: async () => { throw new Error('Generic report read cannot record a change.'); } }));
      await authorizeWorkspace(createAccessRepository(tx), context, capability); return value;
    }, { isolationLevel: 'read committed' }).catch((error: unknown) => { if (isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(); throw error; }),
  });
}
