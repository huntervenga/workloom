import type { BulkUpdateTasksInput, TaskDto } from '@workloom/contracts';
import { DomainError, notFoundError } from '../errors.js';
import { preflightTaskFieldValueInScope, setTaskFieldValueInScope } from '../fields/service.js';
import type { TaskFieldWriteScope } from '../fields/ports.js';
import type { TaskTools, TaskWriteScope, WorkPackageRecord } from './ports.js';

function fieldScope(scope: TaskWriteScope): TaskFieldWriteScope {
  if (!scope.fieldRepository) throw new Error('Bulk custom fields require the same-transaction field repository.');
  return { ...scope, repository: scope.fieldRepository };
}
/** Current custom-field visibility is checked before a receipt is replayed; old revision guards are not. */
export async function authorizeBulkFieldTarget(scope: TaskWriteScope, input: BulkUpdateTasksInput) {
  const change = input.changes.customField;
  if (!change) return;
  const field = await fieldScope(scope).repository.findField(scope.context.workspaceId, change.fieldId);
  if (!field) throw notFoundError();
  if (field.projectId !== input.projectId) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The field belongs to another project.', { details: { fields: ['customField.fieldId'] } });
}

export interface PreparedBulkExtras {
  readonly packages: ReadonlyMap<string, { before: WorkPackageRecord; after: WorkPackageRecord }>;
}
/** All read-only checks finish before the aggregate planning guard or any user proposal. */
export async function prepareBulkExtras(scope: TaskWriteScope, input: BulkUpdateTasksInput, tasks: readonly TaskDto[]): Promise<PreparedBulkExtras> {
  const ws = scope.context.workspaceId;
  const packages = new Map<string, { before: WorkPackageRecord; after: WorkPackageRecord }>();
  if (input.changes.estimateMinutes !== undefined) {
    for (const [index, task] of tasks.entries()) {
      const before = packages.get(task.workPackageId)?.before ?? await scope.repository.findWorkPackage(ws, task.workPackageId);
      if (!before) throw new Error('Task work package is missing.');
      if (before.projectId !== input.projectId) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The work package belongs to another project.');
      if (before.revision !== input.tasks[index]?.expectedWorkPackageRevision) throw new DomainError('REVISION_CONFLICT', 'The work package changed. Reload and retry.', { details: { fields: ['expectedWorkPackageRevision'] } });
      if (!packages.has(before.id) && before.estimateMinutes !== input.changes.estimateMinutes) packages.set(before.id, {
        before,
        after: { ...before, estimateMinutes: input.changes.estimateMinutes, revision: before.revision + 1, updatedAt: scope.barrierAt.toISOString() },
      });
    }
  }
  const change = input.changes.customField;
  if (change) {
    const shared = fieldScope(scope);
    const definition = await shared.repository.findField(ws, change.fieldId);
    if (!definition) throw notFoundError();
    if (definition.projectId !== input.projectId) throw new DomainError('DOMAIN_VALIDATION_FAILED', 'The field belongs to another project.');
    // A manual definition lock has the same committed rejection precedence as the row composer.
    // The aggregate guard handles it after any due freeze; no custom value is proposed here.
    if (!definition.locked) for (const [index, task] of tasks.entries()) await preflightTaskFieldValueInScope(shared, task.id, change.fieldId, {
      expectedRevision: input.tasks[index]?.expectedFieldValueRevision ?? -1,
      expectedDefinitionRevision: change.expectedDefinitionRevision,
      value: change.value,
    }, {deferPolicy:true});
  }
  return { packages };
}
/** Called only after the aggregate guard allowed the whole command; every write shares its transaction. */
export async function applyBulkExtras(scope: TaskWriteScope, input: BulkUpdateTasksInput, tasks: readonly TaskDto[], prepared: PreparedBulkExtras, tools: Pick<TaskTools, 'newId'>): Promise<void> {
  for (const { after } of prepared.packages.values()) await scope.repository.saveWorkPackage(after);
  const change = input.changes.customField;
  if (change) for (const [index, task] of tasks.entries()) await setTaskFieldValueInScope(fieldScope(scope), task.id, change.fieldId, {
    expectedRevision: input.tasks[index]?.expectedFieldValueRevision ?? -1,
    expectedDefinitionRevision: change.expectedDefinitionRevision,
    value: change.value,
  }, tools);
}
