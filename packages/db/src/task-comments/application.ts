import { createHash, randomUUID } from 'node:crypto';
import { createPlanningMutationGuard, createTaskCommentsApplication as createDomainTaskCommentsApplication, type TaskCommentsApplication, type TaskCommentsUnitOfWork } from '@workloom/domain';
import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { createTaskCommentsRepository } from './repository.js';
import { createTaskTimelineCursorCodec, type TaskTimelineCursorOptions } from './cursor.js';
export interface TaskCommentsApplicationOptions extends WorkspaceWriteOptions, TaskTimelineCursorOptions {}
export function createTaskCommentsApplication(source: Database | WorkloomExecutor, options: TaskCommentsApplicationOptions = {}): TaskCommentsApplication {
  const db = isDatabase(source) ? source.db : source, codec = createTaskTimelineCursorCodec(options);
  const runner = createWorkspaceWriteRunner(source, options), recurrence = createRecurrenceRuntime();
  const tools = { newId: () => randomUUID(), digest: (value: string) => createHash('sha256').update(value, 'utf8').digest('hex'), encodeCursor: codec.encode, decodeCursor: codec.decode };
  const unit: TaskCommentsUnitOfWork = {
    read: work => db.transaction(tx => work(createTaskCommentsRepository(tx)), { isolationLevel: 'repeatable read', accessMode: 'read only' }),
    run: (context, capability, work) => runner.run(context, capability, scope => {
      // Construct the standard guard seam; the typed comment family returns before census work.
      const census = composeRecurrenceCensusScope(scope, recurrence);
      return work({ context: scope.context, access: scope.access, barrierAt: scope.barrierAt, recordChange: scope.recordChange, repository: createTaskCommentsRepository(scope.tx), planningGuard: createPlanningMutationGuard(census, tools) });
    }),
  };
  return createDomainTaskCommentsApplication(unit, tools);
}
