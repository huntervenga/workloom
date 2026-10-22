import * as C from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
import type { DependencyApplication } from '../dependencies/application.js';
import { DomainError } from '../errors.js';
import type { TaskFieldApplication } from '../fields/application.js';
import type { TaskApplication } from '../tasks/application.js';
import type { TaskDefaultsApplication } from '../task-defaults/service.js';

export interface TaskContinuationApplication {
  continueTask(context: CommandContext, taskId: string, input: C.ContinueTaskInput): Promise<C.ContinueTaskResult>;
}
export interface TaskContinuationDependencies {
  readonly tasks: TaskApplication;
  readonly fields: Pick<TaskFieldApplication, 'listFields' | 'listTaskValues' | 'setTaskValue'>;
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
      // A section belongs to one project, so it is carried over by name: the same-named section of the chosen project, if any.
      let sectionId: string | null = null;
      if (source.sectionId !== null) {
        if (input.targetProjectId === source.projectId) sectionId = source.sectionId;
        else {
          const sourceName = (await deps.tasks.listSections(context, source.projectId)).find(section => section.id === source.sectionId)?.name;
          const wanted = sourceName?.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
          if (wanted) sectionId = (await deps.tasks.listSections(context, input.targetProjectId)).find(section => section.archivedAt === null && section.name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() === wanted)?.id ?? null;
        }
      }
      // Closing comes before creating: if the project requires something before completion, nothing else is created.
      if (current?.group !== 'done') {
        const done = [...sourceStatuses].filter(status => status.group === 'done').sort((a, b) => a.position - b.position)[0];
        if (!done) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The project has no completed status.');
        source = await deps.tasks.updateTask(step('close'), source.id, { expectedRevision: source.revision, statusId: done.id });
      }

      const continued = await deps.tasks.createTask(step('create'), {
        projectId: input.targetProjectId, title: input.title ?? C.nextContinuationTitle(source.title), statusId: start.id,
        ...(source.responsibleMembershipId ? { responsibleMembershipId: source.responsibleMembershipId } : {}),
        ...(source.priority !== 'none' ? { priority: source.priority } : {}),
        ...(source.tags.length > 0 ? { tagIds: source.tags.filter(tag => tag.archivedAt === null).map(tag => tag.id) } : {}),
        ...(sectionId !== null ? { sectionId } : {}),
      });
      // Choice fields (a project's own "Priority", "Type"…) carry over by field name and option name. Any other field starts
      // from the new project's defaults unless the caller asked for its value to be copied.
      const copy = new Set((input.carryFieldIds ?? []).map(id => id.toLowerCase()));
      const sourceValues = (await deps.fields.listTaskValues(context, source.id)).filter(value => (value.value.type === 'single_select' || value.value.type === 'multi_select' || copy.has(value.fieldId.toLowerCase())) && !isEmptyValue(value.value.value));
      if (sourceValues.length > 0 && input.targetProjectId !== source.projectId) {
        const key = (name: string) => name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
        const sourceFields = await deps.fields.listFields(context, source.projectId);
        const targetFields = (await deps.fields.listFields(context, input.targetProjectId)).filter(field => field.archivedAt === null);
        const existing = new Map((await deps.fields.listTaskValues(context, continued.id)).map(value => [value.fieldId, value]));
        for (const [index, value] of sourceValues.entries()) {
          const from = sourceFields.find(field => field.id === value.fieldId);
          const to = from && targetFields.find(field => field.type === from.type && key(field.name) === key(from.name));
          if (!from || !to) continue;
          if (value.value.type !== 'single_select' && value.value.type !== 'multi_select') {
            if (to.type === 'person') continue;
            try {
              await deps.fields.setTaskValue(step(`field:${index}`), continued.id, to.id, { expectedRevision: existing.get(to.id)?.revision ?? 0, expectedDefinitionRevision: to.revision, value: value.value });
            } catch (error) {
              if (!(error instanceof DomainError)) throw error;
            }
            continue;
          }
          const wanted = value.value.type === 'single_select' ? [value.value.value] : value.value.type === 'multi_select' ? value.value.value : [];
          if (wanted === null) continue;
          const mapped = wanted.flatMap(id => {
            if (id === null) return [];
            const name = from.options.find(option => option.id === id)?.name;
            const match = name === undefined ? undefined : to.options.find(option => option.archivedAt === null && key(option.name) === key(name));
            return match ? [match.id] : [];
          });
          if (mapped.length === 0) continue;
          const data: C.TaskFieldData = to.type === 'single_select' ? { type: 'single_select', value: mapped[0] ?? null } : { type: 'multi_select', value: mapped };
          try {
            await deps.fields.setTaskValue(step(`field:${index}`), continued.id, to.id, { expectedRevision: existing.get(to.id)?.revision ?? 0, expectedDefinitionRevision: to.revision, value: data });
          } catch (error) {
            // A locked or since-changed field must not undo a continuation that has already been created.
            if (!(error instanceof DomainError)) throw error;
          }
        }
      }
      const dependency = await deps.dependencies.createDependency(step('link'), { predecessorTaskId: source.id, successorTaskId: continued.id, type: 'finish_to_start', expectedAbsent: true });
      return { closed: source, continued, dependencyId: dependency.id };
    },
  };
}

function isEmptyValue(value: unknown): boolean { return value === null || (Array.isArray(value) && value.length === 0); }
