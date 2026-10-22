import type { TaskDto, TaskFieldData, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';

/**
 * A parent's empty number or duration cell shows the sum of its subtasks' values, like Asana. The sum is only a
 * display aid: it is never stored, never exported and never feeds column or section totals, which already count
 * the subtasks themselves.
 */
export const ROLLUP_FIELD_TYPES = ['number', 'duration'] as const;

export function isRollupField(field: Pick<TaskFieldDefinitionDto, 'type'>): boolean {
  return (ROLLUP_FIELD_TYPES as readonly string[]).includes(field.type);
}

const scalar = (data: TaskFieldData | null | undefined): number | null => {
  if (!data || (data.type !== 'number' && data.type !== 'duration')) return null;
  return typeof data.value === 'number' && Number.isFinite(data.value) ? data.value : null;
};
const clean = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/**
 * Task id → rolled-up value, for loaded tasks whose own value is unset and that have at least one descendant with a
 * value. An explicit 0 counts as a set value, so it is never replaced and does stop a parent from rolling up.
 * Callers must pass every loaded task of the project; with only part of the tree loaded a sum would be misleading.
 */
export function fieldRollups(
  field: TaskFieldDefinitionDto,
  tasks: readonly Pick<TaskDto, 'id' | 'parentTaskId' | 'archivedAt'>[],
  valueOf: (taskId: string) => TaskFieldValueDto | null | undefined,
): Map<string, TaskFieldData> {
  const result = new Map<string, TaskFieldData>();
  if (!isRollupField(field)) return result;
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentTaskId === null || task.archivedAt !== null) continue;
    const key = task.parentTaskId.toLowerCase();
    children.set(key, [...(children.get(key) ?? []), task.id]);
  }
  if (children.size === 0) return result;
  const memo = new Map<string, number | null>();
  const effective = (taskId: string, seen: ReadonlySet<string>): number | null => {
    const id = taskId.toLowerCase();
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const own = scalar(valueOf(taskId)?.value);
    let total: number | null = own;
    if (own === null && !seen.has(id)) {
      const next = new Set(seen).add(id);
      for (const child of children.get(id) ?? []) {
        const part = effective(child, next);
        if (part !== null) total = (total ?? 0) + part;
      }
    }
    const value = total === null ? null : clean(total);
    memo.set(id, value);
    if (own === null && value !== null) result.set(taskId, { type: field.type as 'number' | 'duration', value } as TaskFieldData);
    return value;
  };
  for (const task of tasks) effective(task.id, new Set());
  return result;
}
