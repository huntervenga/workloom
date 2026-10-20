import {sharedActivityTaskIds} from '../shared-activities/repository.js';
import {createSummaryTemplateRepository} from '../summary-templates/repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { authorizeWorkspace, createDuplicationApplication as createDomainDuplicationApplication, notFoundError, temporarilyUnavailableError, type DuplicationApplication, type DuplicationScope, type CommandContext } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { workspaces } from '../schema.js';
import { createAccessRepository } from '../repositories/access-repository.js';
import { createWorkspaceWriteRunner, type DbWorkspaceWriteScope } from '../transactions/workspace-write.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createPlanningCheckRepository } from '../planning-checks/repository.js';
import { createGenericReportRepository } from '../generic-reports/repository.js';
import { createTaskProjectPlacementRepository } from '../repositories/task-project-placement-repository.js';

/** One shared-barrier TX carries tasks, values, copied metadata, mandatory census and one receipt. No nested public writer. */
export function createDuplicationApplication(source: Database | WorkloomExecutor): DuplicationApplication {
  const db = isDatabase(source) ? source.db : source, writer = createWorkspaceWriteRunner(source), runtime = createRecurrenceRuntime();
  const tools = { newId: randomUUID, digest: (value: string) => createHash('sha256').update(value).digest('hex') };
  const compose = (scope: DbWorkspaceWriteScope): DuplicationScope => ({ ...composeRecurrenceCensusScope(scope, runtime), sharedActivityTaskIds:ids=>sharedActivityTaskIds(scope.tx,scope.context.workspaceId,ids), templates:createSummaryTemplateRepository(scope.tx,scope.context.workspaceId), reports: createGenericReportRepository(scope.tx, scope.context.workspaceId), checks: createPlanningCheckRepository(scope.tx, scope.context.workspaceId), placements: createTaskProjectPlacementRepository(scope.tx) });
  return createDomainDuplicationApplication({ ...tools,
    write: (ctx, capability, work) => writer.run(ctx, capability, scope => work(compose(scope))),
    read: (ctx: CommandContext, capability, work) => db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='15000'`); await tx.execute(sql`set local lock_timeout='5000'`);
      const accessRepo = createAccessRepository(tx);
      await authorizeWorkspace(accessRepo, ctx, capability);
      const locked = await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).for('share');
      if (!locked.length) throw notFoundError();
      const access = await authorizeWorkspace(accessRepo, ctx, capability);
      const result = await work(compose({ tx, context: ctx, access, barrierAt: new Date(), recordChange: async () => { throw new Error('Duplication preview cannot write.'); } }));
      await authorizeWorkspace(accessRepo, ctx, capability);
      return result;
    }, { isolationLevel: 'read committed' }).catch((error: unknown) => { if (isDatabaseUnavailableError(error)) throw temporarilyUnavailableError(); throw error; }),
  });
}
