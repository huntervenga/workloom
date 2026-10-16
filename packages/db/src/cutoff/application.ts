import { sql } from 'drizzle-orm';
import { authorizeWorkspace, isDomainError, temporarilyUnavailableError, createCutoffApplication as createDomainCutoffApplication, type CutoffApplication, type CutoffUnitOfWork } from '@workloom/domain';
import { isDatabaseUnavailableError } from '../database-errors.js';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { createCutoffRepository } from './repository.js';
export function createCutoffApplication(source: Database | WorkloomExecutor, options: WorkspaceWriteOptions = {}): CutoffApplication {
  const db = isDatabase(source) ? source.db : source, runner = createWorkspaceWriteRunner(source, options), runtime = createRecurrenceRuntime();
  const unit: CutoffUnitOfWork = {
    read: async (context, work) => { try { return await db.transaction(async tx => {
      await tx.execute(sql`select set_config('lock_timeout',${`${Math.max(1, Math.trunc(options.lockTimeoutMs ?? 5_000))}ms`},true), set_config('statement_timeout',${`${Math.max(1, Math.trunc(options.statementTimeoutMs ?? 15_000))}ms`},true)`);
      const repository = createCutoffRepository(tx, true);
      await authorizeWorkspace(repository.access, context, 'task.read');
      const [clock] = await tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
      if (!clock) throw new Error('Database clock unavailable.');
      return work({ repository, serverAt: new Date(clock.at) });
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' }); } catch (error) { throw !isDomainError(error) && isDatabaseUnavailableError(error) ? temporarilyUnavailableError(error) : error; } },
    run: (context, work) => runner.run(context, 'plan.freeze_project', scope => work(composeRecurrenceCensusScope(scope, runtime))),
  };
  return createDomainCutoffApplication(unit, runtime.tools);
}
