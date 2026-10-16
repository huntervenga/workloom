import { createHash, randomUUID } from 'node:crypto';
import {
  createPlanningMutationGuard,
  createTaskApplication as createDomainTaskApplication,
  type TaskApplication,
  type TaskTools,
  type TaskUnitOfWork,
} from '@workloom/domain';

import type { Database, WorkloomExecutor } from '../client.js';
import { composeRecurrenceCensusScope, createRecurrenceRuntime } from '../recurrence/census-scope.js';
import { createTaskRepository } from '../repositories/task-repository.js';
import { createWorkspaceWriteRunner, type WorkspaceWriteOptions } from '../transactions/workspace-write.js';
import { createTaskCursorCodec } from './cursor.js';

export interface TaskApplicationOptions extends WorkspaceWriteOptions {
  /**
   * HMAC key for list cursors, at least 32 bytes; intended for tests. Omitted: a random key
   * per application instance, so a restart invalidates outstanding cursors (clients refetch).
   */
  readonly cursorSecret?: string;
}

/**
 * Wires the domain task use cases to PostgreSQL. Reads use a repository over `source`;
 * every write runs inside the workspace barrier transaction with a repository bound to
 * that transaction, so state, audit and outbox commit or roll back together.
 */
export function createTaskApplication(
  source: Database | WorkloomExecutor,
  options: TaskApplicationOptions = {},
): TaskApplication {
  const { cursorSecret, ...writeOptions } = options;
  const runner = createWorkspaceWriteRunner(source, writeOptions);
  const codec = createTaskCursorCodec(cursorSecret === undefined ? {} : { secret: cursorSecret });
  const recurrence = createRecurrenceRuntime(cursorSecret === undefined ? {} : { cursorSecret });

  const writer: TaskUnitOfWork = {
    run(context, capability, work) {
      return runner.run(context, capability, (scope) => {
        // The planning guard gets the mandatory same-TX recurrence census; no bypass composition exists.
        const census = composeRecurrenceCensusScope(scope, recurrence);
        const taskScope = {
          context: scope.context,
          access: scope.access,
          barrierAt: scope.barrierAt,
          recordChange: scope.recordChange,
          repository: createTaskRepository(scope.tx),
          recurrenceCensus: census.recurrenceCensus,
          planningGuard: createPlanningMutationGuard(census, tools),
          statusTransitions:census.statusTransitions,
        };
        return work(taskScope);
      });
    },
  };

  const tools: TaskTools = {
    newId: () => randomUUID(),
    digest: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
    encodeCursor: (payload) => codec.encode(payload),
    decodeCursor: (token) => codec.decode(token),
  };

  return createDomainTaskApplication({ reader: createTaskRepository(source), writer, tools });
}
