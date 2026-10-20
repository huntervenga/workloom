import type * as C from '@workloom/contracts';
import { calculatePersonalEffort, summarizePersonalEffort } from '../shared-activities/effort.js';
import type { GenericReportSource } from './ports.js';
import { comparison } from './engine.js';
export const effortNumber = (minutes: number | null): C.GenericReportNumberDto | null => minutes === null ? null : ({ numerator: String(minutes), denominator: '1', decimal: String(minutes) });
export function effortMeasure(key: string, fieldId: string | null, result: C.PersonalEffortResultDto): C.GenericMeasureResultDto {
  return { key, operation: 'personal_effort', fieldId, unit: 'minutes', value: effortNumber(result.minutes),
    coverage: { tasks: result.coverage.sources, filled: result.coverage.known, missing: result.coverage.unknown + result.coverage.void, null: 0, zero: result.coverage.zero }, effort: result };
}
export function personalEffortComparison(plan: C.PersonalEffortResultDto, fact: C.PersonalEffortResultDto, rows: readonly C.GenericReportRowDto[], config: C.GenericReportConfig): C.GenericComparisonDto | null {
  if (!config.comparison) return null;
  const taskMap = new Map(rows.map(row => [row.taskId, row])), pair = (row: C.PersonalEffortContributionDto) => row.taskId + ':' + (row.membershipId ?? 'unassigned');
  const plans = new Map(plan.contributions.map(row => [pair(row), row])), facts = new Map(fact.contributions.map(row => [pair(row), row]));
  const cell = (fieldId: string, row: C.PersonalEffortContributionDto | undefined): C.GenericReportCellDto => ({ fieldId, state: row?.state === 'value' ? 'value' : row?.state === 'null' ? 'null' : 'missing', value: row?.state === 'value' ? row.minutes : null, valueRevision: row?.sourceRevision ?? null, definitionVersionId: null });
  const expanded: C.GenericReportRowDto[] = [];
  for (const key of new Set([...plans.keys(), ...facts.keys()])) { const p = plans.get(key), f = facts.get(key), original = taskMap.get((p ?? f)?.taskId ?? ''); if (!original) continue; expanded.push({ ...original, primaryAssigneeId: (p ?? f)?.membershipId ?? null, values: [cell(config.comparison.planFieldId, p), cell(config.comparison.factFieldId, f)] }); }
  const result = comparison(expanded, config); return result ? { ...result, attribution: 'personal_effort', effort: { plan, fact } } : null;
}
export function effortGroup(source: GenericReportSource, config: C.GenericReportConfig, contribution: C.PersonalEffortContributionDto): { key: string; label: string } {
  const task = source.tasks.find(task => task.id === contribution.taskId);
  if (config.groupBy.kind === 'assignee') return { key: contribution.membershipId ?? 'unassigned', label: contribution.membershipId ? source.memberLabels[contribution.membershipId] ?? 'Former member' : 'Unassigned' };
  if (config.groupBy.kind === 'status') return { key: task?.statusGroup ?? 'todo', label: task?.statusGroup ?? 'todo' };
  if (config.groupBy.kind === 'section') return { key: task?.sectionId ?? 'no_section', label: task?.sectionId ? source.sectionLabels[task.sectionId] ?? 'Archived section' : 'No section' };
  if (config.groupBy.kind === 'category') {
    const fieldId = config.groupBy.fieldId;
    if (contribution.sourceKind === 'shared_attendance') {
      if (!contribution.category || contribution.category.fieldId !== fieldId) return { key: 'category_not_captured', label: 'Category not captured' };
      return { key: contribution.category.optionId ?? 'uncategorized', label: contribution.category.label ?? 'Uncategorized' };
    }
    const value = source.values.find(value => value.taskId === contribution.taskId && value.fieldId === fieldId), optionId = value?.value.type === 'single_select' ? value.value.value : null;
    return { key: optionId ?? 'uncategorized', label: optionId ? source.fields.find(field => field.id === fieldId)?.options.find(option => option.id === optionId)?.name ?? 'Unavailable category' : 'Uncategorized' };
  }
  return { key: 'all', label: 'All tasks' };
}
export function reportPersonalEffort(source: GenericReportSource, config: C.GenericReportConfig, fieldId: string, groupKey?: string): C.PersonalEffortResultDto {
  const result = calculatePersonalEffort(source, { fieldId, ...(config.filters.assignee.kind === 'member' ? { membershipId: config.filters.assignee.membershipId } : {}) });
  return summarizePersonalEffort(result.contributions.filter(row => (config.filters.assignee.kind !== 'unassigned' || row.membershipId === null) && (groupKey === undefined || effortGroup(source, config, row).key === groupKey)));
}
