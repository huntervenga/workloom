import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { authorizeWorkspace, createPlanningCheckService, createPlanningMutationGuard, notFoundError, temporarilyUnavailableError, type PlanningCheckApplication, type PlanningCheckScope, type CommandContext } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { workspaces } from '../schema.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import {createPlanningCheckRepository} from './repository.js';
import { createGenericReportRepository } from '../generic-reports/repository.js';
export function createPlanningCheckApplication(source: Database | WorkloomExecutor): PlanningCheckApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source);
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const recurrence = createRecurrenceRuntime();
  function compose(scope: DbWorkspaceWriteScope): PlanningCheckScope { return { ...scope, repository: createTaskFieldRepository(scope.tx), reports: createGenericReportRepository(scope.tx, scope.context.workspaceId), checks:createPlanningCheckRepository(scope.tx,scope.context.workspaceId), planningGuard: createPlanningMutationGuard(composeRecurrenceCensusScope(scope, recurrence), tools) }; }
  return createPlanningCheckService({ ...tools,
    write: (context, capability, work) => writer.run(context, capability, scope => work(compose(scope))),
    read: (context: CommandContext, capability, work) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='15000'`); await tx.execute(sql`set local lock_timeout='5000'`);
      // Shared barrier blocks every ordinary writer while scope, values and current permissions are read.
      // No UPDATE occurs in this transaction; FOR SHARE requires a non-read-only transaction mode.
      await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, context.workspaceId)).for('share'); if (!locked.length) throw notFoundError();
      const access = await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const value = await work(compose({ tx, context, access, barrierAt: new Date(), recordChange: async () => { throw new Error('Planning check read cannot record a change.'); } }));
      await authorizeWorkspace(createAccessRepository(tx), context, capability); return value;
    }, { isolationLevel: 'read committed' }).catch((error: unknown) => { if (isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(); throw error; }),
  });
}
