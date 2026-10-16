import { createHash, randomUUID } from 'node:crypto';
import { createPersonalTablePreferenceApplication as createDomainPreferenceApplication, createPlanningMutationGuard, type PersonalTablePreferenceApplication, type PersonalTablePreferenceUnitOfWork } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { createPersonalTablePreferenceRepository } from './repository.js';
export function createPersonalTablePreferenceApplication(source: Database | WorkloomExecutor, options: WorkspaceWriteOptions = {}): PersonalTablePreferenceApplication {
  const db = isDatabase(source) ? source.db : source, runner = createWorkspaceWriteRunner(source, options), runtime = createRecurrenceRuntime();
  const tools = { newId: () => randomUUID(), digest: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex') };
  const unit: PersonalTablePreferenceUnitOfWork = {
    read: work => db.transaction(tx => work(createPersonalTablePreferenceRepository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
    run: (context, capability, work) => runner.run(context, capability, scope => {
      const census = composeRecurrenceCensusScope(scope, runtime);
      return work({ context: scope.context, access: scope.access, barrierAt: scope.barrierAt, recordChange: scope.recordChange, repository: createPersonalTablePreferenceRepository(scope.tx), planningGuard: createPlanningMutationGuard(census, tools) });
    }),
  };
  return createDomainPreferenceApplication(unit, tools);
}
