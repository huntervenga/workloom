import type { TaskDefaultsConfig, TaskDto, TaskFieldData, TaskFieldDefinitionDto } from '@workloom/contracts';
import { draftFromFieldValue } from '../fields/valueDraft';
import type { InitialFieldEntry } from '../tasks/InitialTaskCells';
import { formatEstimateInput } from '../task-table/estimate';
import type { CreateStartValues } from '../tasks/useTaskCommands';

function plusDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * What a new row would get from the project's task defaults, mirroring the server so the person sees it before saving:
 * the rules that copy the task above, today's date, and the fixed priority and estimate. A rule with nothing to copy
 * sets nothing. The server still decides at save time; a value typed in the row always wins there.
 */
export function startValuesFromDefaults(config: TaskDefaultsConfig, above: TaskDto | null, options: { today: string | undefined; subtask: boolean }): CreateStartValues {
  const start: CreateStartValues = {};
  if (config.assignee?.kind === 'fixed') start.responsibleMembershipId = config.assignee.membershipId;
  else if (config.assignee?.kind === 'above' && above?.responsibleMembershipId) start.responsibleMembershipId = above.responsibleMembershipId;
  if (config.tags?.kind === 'fixed' && config.tags.tagIds.length > 0) start.tagIds = [...config.tags.tagIds];
  else if (config.tags?.kind === 'above' && above) {
    const held = above.tags.filter(tag => tag.archivedAt === null).map(tag => tag.id);
    if (held.length > 0) start.tagIds = held;
  }
  if (config.dueDate?.kind === 'today' && options.today) start.dueDate = plusDays(options.today, config.dueDate.offsetDays);
  else if (config.dueDate?.kind === 'above' && above?.dueDate) start.dueDate = above.dueDate;
  const priority = config.fromAbove?.priority && above ? above.priority : config.priority;
  if (priority && priority !== 'none') start.priority = priority;
  if (!options.subtask) {
    const minutes = config.fromAbove?.estimate && above?.estimateMinutes !== undefined && above.estimateMinutes !== null ? above.estimateMinutes : config.estimateMinutes;
    if (minutes !== null && minutes !== undefined) start.estimate = formatEstimateInput(minutes);
  }
  return start;
}

/**
 * Ordinary (custom) field values a new row would get, in the server's order of preference: the task above, then today,
 * then the fixed default; the first usable one wins. Locked, archived and type-mismatched fields are skipped, as on the
 * server. `valueOf` reads a loaded value of the task above; an unloaded one is simply left to the server.
 */
export function startFieldsFromDefaults(config: TaskDefaultsConfig, above: TaskDto | null, options: {
  today: string | undefined;
  fields: readonly TaskFieldDefinitionDto[];
  valueOf: (taskId: string, fieldId: string) => TaskFieldData | null | undefined;
}): Record<string, InitialFieldEntry> {
  const candidates: { fieldId: string; value: TaskFieldData }[] = [];
  if (above) for (const fieldId of config.fromAbove?.fieldIds ?? []) {
    const value = options.valueOf(above.id, fieldId);
    if (value && value.value !== null) candidates.push({ fieldId, value });
  }
  if (options.today) for (const item of config.todayFields ?? []) candidates.push({ fieldId: item.fieldId, value: { type: 'date', value: plusDays(options.today, item.offsetDays) } });
  for (const item of config.fieldValues) candidates.push({ fieldId: item.fieldId, value: item.value });
  const result: Record<string, InitialFieldEntry> = {};
  for (const candidate of candidates) {
    const field = options.fields.find(item => item.id.toLowerCase() === candidate.fieldId.toLowerCase());
    if (!field || field.archivedAt !== null || field.locked || field.type !== candidate.value.type || field.id in result) continue;
    result[field.id] = { field, draft: draftFromFieldValue(field, candidate.value) };
  }
  return result;
}
