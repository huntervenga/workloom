import * as C from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { DependencyApplication } from '../dependencies/application.js';
import { DomainError } from '../errors.js';
import type { TaskApplication } from '../tasks/application.js';
import type { TaskDefaultsApplication } from '../task-defaults/service.js';

export interface TaskContinuationApplication {
  continueTask(context: CommandContext, taskId: string, input: C.ContinueTaskInput): Promise<C.ContinueTaskResult>;
}
export interface TaskContinuationDependencies {
  readonly tasks: TaskApplication;
  readonly dependencies: DependencyApplication;
  readonly defaults: TaskDefaultsApplication;
  digest(value: string): string;
}

/**
 * Completes the task, starts its continuation in another project and links the two. The steps are the ordinary commands
 * with idempotency keys derived from the caller's key, so repeating the request resumes exactly where it stopped.
 */
export function createTaskContinuationService(deps: TaskContinuationDependencies): TaskContinuationApplication {
  return {
    async continueTask(context, taskId, rawInput) {
      const parsed = C.continueTaskInputSchema.safeParse(rawInput);
      if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid continuation request.');
      const base = context.idempotencyKey;
      if (!base || !/^[\x21-\x7e]{1,128}$/.test(base)) throw new DomainError('VALIDATION_FAILED', 'A valid Idempotency-Key is required.');
      const step = (name: string): CommandContext => ({ ...context, idempotencyKey: deps.digest(`${base}\u0000${name}`).slice(0, 64) });
      const input = parsed.data;

      let source = await deps.tasks.getTask(context, taskId);
      if (source.archivedAt !== null) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'Restore the task before continuing it.');
      const sourceStatuses = await deps.tasks.listStatuses(context, source.projectId);
      const current = sourceStatuses.find(status => status.id === source.statusId);
      if (current?.group === 'cancelled') throw new DomainError('DOMAIN_VALIDATION_FAILED', 'A cancelled task cannot be continued.');
      // Everything about the target is checked before anything changes, so a bad project closes nothing.
      const targetStatuses = await deps.tasks.listStatuses(context, input.targetProjectId);
      const configured = (await deps.defaults.getDefaults(context, input.targetProjectId)).config.statusId;
      const ordered = [...targetStatuses].sort((a, b) => a.position - b.position);
      const start = ordered.find(status => status.id === configured) ?? ordered.find(status => status.group === 'todo') ?? ordered[0];
      if (!start) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The chosen project has no statuses.');
      // Closing comes before creating: if the project requires something before completion, nothing else is created.
      if (current?.group !== 'done') {
        const done = [...sourceStatuses].filter(status => status.group === 'done').sort((a, b) => a.position - b.position)[0];
        if (!done) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The project has no completed status.');
        source = await deps.tasks.updateTask(step('close'), source.id, { expectedRevision: source.revision, statusId: done.id });
      }

      const continued = await deps.tasks.createTask(step('create'), {
        projectId: input.targetProjectId, title: input.title ?? C.nextContinuationTitle(source.title), statusId: start.id,
        ...(source.responsibleMembershipId ? { responsibleMembershipId: source.responsibleMembershipId } : {}),
      });
      const dependency = await deps.dependencies.createDependency(step('link'), { predecessorTaskId: source.id, successorTaskId: continued.id, type: 'finish_to_start', expectedAbsent: true });
      return { closed: source, continued, dependencyId: dependency.id };
    },
  };
}
