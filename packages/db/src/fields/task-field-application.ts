import { createHash, randomUUID } from 'node:crypto';
import {
  createPlanningMutationGuard,
  createTaskFieldApplication as createDomainTaskFieldApplication,
  type TaskFieldApplication,
  type TaskFieldTools,
  type TaskFieldUnitOfWork,
} from '@workloom/domain';

import type { Database, WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createTaskFieldRepository } from '../repositories/task-field-repository.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { createTaskFieldHistoryCursorCodec } from './history-cursor.js';

export interface TaskFieldApplicationOptions extends WorkspaceWriteOptions {
  /** Tests may inject a key of at least 32 bytes; the local default lasts for this instance. */
  readonly cursorSecret?: string;
}

/** Wires the shared field commands to the existing workspace transaction and PostgreSQL pool. */
export function createTaskFieldApplication(
  source: Database | WorkloomExecutor,
  options: TaskFieldApplicationOptions = {},
): TaskFieldApplication {
  const { cursorSecret, ...writeOptions } = options;
  const runner = createWorkspaceWriteRunner(source, writeOptions);
  const codec = createTaskFieldHistoryCursorCodec(cursorSecret === undefined ? {} : { secret: cursorSecret });
  const recurrence = createRecurrenceRuntime(cursorSecret === undefined ? {} : { cursorSecret });
  const writer: TaskFieldUnitOfWork = {
    run(context, capability, work) {
      return runner.run(context, capability, (scope) => {
        // The planning guard gets the mandatory same-TX recurrence census; no bypass composition exists.
        const census = composeRecurrenceCensusScope(scope, recurrence);
        const fieldScope = {
          context: scope.context,
          access: scope.access,
          barrierAt: scope.barrierAt,
          recordChange: scope.recordChange,
          repository: createTaskFieldRepository(scope.tx),
          recurrenceCensus: census.recurrenceCensus,
          planningGuard: createPlanningMutationGuard(census, tools),
        };
        return work(fieldScope);
      });
    },
  };
  const tools: TaskFieldTools = {
    newId: () => randomUUID(),
    digest: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
    encodeHistoryCursor: (payload) => codec.encode(payload),
    decodeHistoryCursor: (token) => codec.decode(token),
  };
  return createDomainTaskFieldApplication({ reader: createTaskFieldRepository(source), writer, tools });
}
