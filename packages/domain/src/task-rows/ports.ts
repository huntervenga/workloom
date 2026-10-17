import type { CreateTaskRowInput, TaskRowCreatedDto } from '@workloom/contracts';

import type { Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import type { PlanningApplicationWriteScope, PlanningTools } from '../planning/ports.js';

/**
 * Atomic table-row creation. Task, custom values, explicit personal plan and explicit period actual
 * share one writer transaction and one `task.row.create` receipt; a late failure rolls back all of it.
 */
export interface TaskRowApplication {
  createRow(context: CommandContext, input: CreateTaskRowInput): Promise<TaskRowCreatedDto>;
}

/** One workspace-barrier transaction exposing the same-TX planning scope (tasks, fields, census, categories). */
export interface TaskRowUnitOfWork {
  run<T>(ctx: CommandContext, capability: Capability, work: (scope: PlanningApplicationWriteScope) => Promise<T>): Promise<T>;
}

export interface TaskRowApplicationDependencies {
  readonly writer: TaskRowUnitOfWork;
  readonly tools: Pick<PlanningTools, 'newId' | 'digest'>;
}
