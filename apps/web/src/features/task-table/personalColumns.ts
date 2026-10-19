import type { ColumnChoice, ProjectColumnsDto, TableColumnRef, TaskFieldDefinitionDto, TaskTableBuiltinColumn } from '@workloom/contracts';

export const BUILTIN_COLUMN_KEYS: readonly TaskTableBuiltinColumn[] = ['title', 'status', 'responsible', 'participants', 'dueDate', 'tags', 'priority', 'weeklyPlan', 'weeklyActual', 'estimate'];
const hiddenDefaults = new Set<TaskTableBuiltinColumn>(['participants', 'priority']);
export const isLegacyTimeColumn = (column: TableColumnRef): boolean => column.kind === 'builtin' && (column.key === 'weeklyPlan' || column.key === 'weeklyActual' || column.key === 'estimate');
export const columnKey = (column: TableColumnRef): string => column.kind === 'builtin' ? `builtin:${column.key}` : `field:${column.fieldId.toLowerCase()}`;
export const tableColumnId = (column: TableColumnRef): string => column.kind === 'field' ? column.fieldId.toLowerCase() : column.key === 'weeklyPlan' ? 'weekly-plan' : column.key === 'weeklyActual' ? 'weekly-fact' : column.key;
export interface ReconciledColumns {
  choices: ColumnChoice[]; effectiveVisibleRefs: TableColumnRef[]; addedRefs: TableColumnRef[];
  inactiveRefs: TableColumnRef[]; invalidRefs: TableColumnRef[]; limitExceeded: boolean;
}
/** Presentation only. No mutation, normalization of saved order or silent truncation. */
export function reconcilePersonalColumns(stored: readonly ColumnChoice[] | null, fields: readonly TaskFieldDefinitionDto[], project: ProjectColumnsDto, timeAvailable: boolean): ReconciledColumns {
  const own = fields.filter(field => field.workspaceId === project.workspaceId && field.projectId === project.projectId);
  const byId = new Map(own.map(field => [field.id.toLowerCase(), field]));
  const active = own.filter(field => field.archivedAt === null);
  const shared = [...project.columns].sort((a, b) => a.position - b.position);
  const sharedIds = new Set(shared.map(column => column.fieldId.toLowerCase()));
  const sharedChoices: ColumnChoice[] = shared.flatMap(column => {
    const field = byId.get(column.fieldId.toLowerCase());
    return field?.archivedAt === null ? [{ column: { kind: 'field' as const, fieldId: field.id }, visible: column.visible }] : [];
  });
  const builtinChoices: ColumnChoice[] = BUILTIN_COLUMN_KEYS.filter(key => key !== 'estimate').map(key => ({ column: { kind: 'builtin', key }, visible: !hiddenDefaults.has(key) }));
  const defaults: ColumnChoice[] = [...builtinChoices, ...sharedChoices, { column: { kind: 'builtin', key: 'estimate' }, visible: true }, ...active.filter(field => !sharedIds.has(field.id.toLowerCase())).map(field => ({ column: { kind: 'field' as const, fieldId: field.id }, visible: false }))];
  const known = new Set((stored ?? []).map(choice => columnKey(choice.column)));
  const added = stored === null ? [] : defaults.filter(choice => !known.has(columnKey(choice.column)));
  const choices = stored === null ? defaults : [...stored, ...added];
  const invalidRefs: TableColumnRef[] = []; const inactiveRefs: TableColumnRef[] = [];
  const effectiveVisibleRefs = choices.flatMap(choice => {
    const ref = choice.column;
    if (ref.kind === 'field') {
      const field = byId.get(ref.fieldId.toLowerCase());
      if (!field) { invalidRefs.push(ref); return []; }
      if (field.archivedAt !== null) { inactiveRefs.push(ref); return []; }
    } else if (!BUILTIN_COLUMN_KEYS.includes(ref.key)) { invalidRefs.push(ref); return []; }
    else if (isLegacyTimeColumn(ref) && !timeAvailable) return [];
    return choice.visible ? [ref] : [];
  });
  return { choices, effectiveVisibleRefs, addedRefs: added.map(choice => choice.column), inactiveRefs, invalidRefs,
    limitExceeded: choices.length > 210 || choices.filter(choice => choice.column.kind === 'field').length > 200 };
}
