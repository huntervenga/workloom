import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { authorizeWorkspace, createPlanningMutationGuard, createSharedActivityService, notFoundError, temporarilyUnavailableError, type SharedActivityApplication, type SharedActivityScope } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { workspaces } from '../schema.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';
import { createSharedActivityRepository } from './repository.js';
export function createSharedActivityApplication(source: Database | WorkloomExecutor): SharedActivityApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source), runtime = createRecurrenceRuntime();
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  function compose(scope: DbWorkspaceWriteScope): SharedActivityScope {
    const census = composeRecurrenceCensusScope(scope, runtime), repository = createTaskFieldRepository(scope.tx), planningGuard = createPlanningMutationGuard(census, tools);
    return { ...scope, repository, planningGuard, activities: createSharedActivityRepository(scope.tx, scope.context.workspaceId), taskScope: { ...scope, repository: repository.tasks, fieldRepository: repository, planningGuard, statusTransitions: census.statusTransitions } };
  }
  return createSharedActivityService({ ...tools,
    write: (context, capability, work) => writer.run(context, capability, scope => work(compose(scope))),
    read: (context, capability, work) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='15000'`); await tx.execute(sql`set local lock_timeout='5000'`);
      await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const rows = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, context.workspaceId)).for('share'); if (!rows.length) throw notFoundError();
      const access = await authorizeWorkspace(createAccessRepository(tx), context, capability);
      const result = await work(compose({ tx, context, access, barrierAt: new Date(), recordChange: async () => { throw Error('A shared activity read cannot write.'); } }));
      await authorizeWorkspace(createAccessRepository(tx), context, capability); return result;
    }, { isolationLevel: 'read committed' }).catch((error: unknown) => { if (isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(); throw error; }),
  });
}
