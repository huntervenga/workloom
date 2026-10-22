import type { CreateTaskInput, TaskFieldData } from '@workloom/contracts';
import type { TaskFieldRepository } from '../fields/ports.js';
import { requireAssignableReferences } from '../fields/service.js';
import type { TaskRepository } from '../tasks/ports.js';

export interface DefaultFieldValue {
  readonly fieldId: string;
  readonly expectedDefinitionRevision: number;
  readonly value: TaskFieldData;
}

/**
 * Fills in what the caller left out. Nothing is overridden: an explicit priority, estimate or field value always wins,
 * and a default that no longer fits (archived or locked field, removed option, former member) is skipped, never an error.
 */
export async function resolveTaskDefaults(
  repository: TaskRepository,
  fields: TaskFieldRepository | undefined,
  workspaceId: string,
  input: CreateTaskInput,
  suppliedFieldIds: ReadonlySet<string>,
): Promise<{ input: CreateTaskInput; fields: DefaultFieldValue[] }> {
  const defaults = await repository.findTaskDefaults?.(workspaceId, input.projectId);
  if (!defaults || defaults.revision === 0) return { input, fields: [] };
  const config = defaults.config;
  const next: CreateTaskInput = { ...input };
  if (next.priority === undefined && config.priority !== null) next.priority = config.priority;
  // A detail subtask shares its parent's package, so a team estimate default only fits top-level tasks and added scope.
  const ownsPackage = !input.parentTaskId || input.workScope === 'added_scope';
  if (next.estimateMinutes === undefined && config.estimateMinutes !== null && ownsPackage) next.estimateMinutes = config.estimateMinutes;
  const values: DefaultFieldValue[] = [];
  if (fields) {
    const supplied = new Set([...suppliedFieldIds].map(id => id.toLowerCase()));
    for (const item of config.fieldValues) {
      if (supplied.has(item.fieldId.toLowerCase())) continue;
      const field = await fields.findField(workspaceId, item.fieldId);
      if (!field || field.projectId.toLowerCase() !== input.projectId.toLowerCase() || field.archivedAt !== null || field.locked || field.type !== item.value.type) continue;
      try { await requireAssignableReferences(fields, workspaceId, field, item.value, null); } catch { continue; }
      values.push({ fieldId: field.id, expectedDefinitionRevision: field.revision, value: item.value });
    }
  }
  return { input: next, fields: values };
}
