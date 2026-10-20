import type { GenericComparisonDto, GenericReportCellDto, GenericReportConfig, GenericReportMeasure, GenericReportRowDto, TaskStatusGroup } from '@workloom/contracts';
import type { TranslationKey } from '../../i18n';
/** Literal catalog keys, checked exhaustively against the public response/input unions. */
export const operationLabels = {
  personal_effort: 'effortReports.personalEffort', sum: 'genericReports.operation.sum', avg: 'genericReports.operation.avg',
  min: 'genericReports.operation.min', max: 'genericReports.operation.max',
  count_values: 'genericReports.operation.count_values', count_tasks: 'genericReports.operation.count_tasks',
} satisfies Record<GenericReportMeasure['operation'], TranslationKey>;
export const groupLabels = {
  none: 'genericReports.group.none', assignee: 'genericReports.group.assignee',
  status: 'genericReports.group.status', section: 'genericReports.group.section',
} satisfies Record<Exclude<GenericReportConfig['groupBy']['kind'], 'category'>, TranslationKey>;
export const boundaryLabels = {
  from: 'genericReports.from', to: 'genericReports.to',
} satisfies Record<'from' | 'to', TranslationKey>;
export const comparisonLabels = {
  plan: 'genericReports.plan', fact: 'genericReports.fact', difference: 'genericReports.difference', ratio: 'genericReports.ratio',
} satisfies Record<'plan' | 'fact' | 'difference' | 'ratio', TranslationKey>;
export const reasonLabels = {
  no_tasks: 'genericReports.reason.no_tasks', missing_plan: 'genericReports.reason.missing_plan',
  missing_fact: 'genericReports.reason.missing_fact', zero_plan: 'genericReports.reason.zero_plan',
} satisfies Record<NonNullable<GenericComparisonDto['unavailableReason']>, TranslationKey>;
export const cellLabels = {
  missing: 'genericReports.cell.missing', null: 'genericReports.cell.null',
  value: 'genericReports.cell.value', not_in_snapshot: 'genericReports.cell.not_in_snapshot',
} satisfies Record<GenericReportCellDto['state'], TranslationKey>;
export const statusLabels = {
  todo: 'genericReports.status.todo', in_progress: 'genericReports.status.in_progress',
  done: 'genericReports.status.done', cancelled: 'genericReports.status.cancelled',
} satisfies Record<TaskStatusGroup, TranslationKey>;
export const cohortLabels = {
  current: 'genericReports.cohort.current', retained: 'genericReports.cohort.retained', added: 'genericReports.cohort.added',
} satisfies Record<GenericReportRowDto['cohort'], TranslationKey>;
