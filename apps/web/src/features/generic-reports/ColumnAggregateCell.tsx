import * as Menu from '@radix-ui/react-dropdown-menu';
import type { GenericMeasureResultDto, GenericReportMeasure } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { operationLabels } from './translationKeys';
import { reportNumber } from './ReportResults';
export type ColumnOperation = Exclude<GenericReportMeasure['operation'], 'count_tasks'>;
export const columnOperations: readonly ColumnOperation[] = ['sum', 'avg', 'min', 'max', 'count_values'];
export function replaceColumnOperation(measures: readonly GenericReportMeasure[], fieldId: string, operation: ColumnOperation | null, measureKey?: string): GenericReportMeasure[] {
  const first = measures.findIndex(measure => 'fieldId' in measure && measure.fieldId === fieldId && (measureKey === undefined || measure.key === measureKey));
  if (first < 0) { const prefix = `col_${fieldId.replaceAll('-', '')}`.slice(0, 36); let key = prefix; for (let suffix = 2; measures.some(measure => measure.key === key); suffix++) { const ending = `_${suffix}`; key = `${prefix.slice(0, 40 - ending.length)}${ending}`; } return operation === null ? [...measures] : [...measures, { key, operation, fieldId }]; }
  return measures.flatMap((measure, index) => index === first ? operation === null ? [] : [{ ...measure, operation, fieldId }] : [measure]);
}
export function ColumnAggregateCell({ fieldName, operation, result, writable, disabled, state, onChange }: { fieldName: string; operation: ColumnOperation | null; result: GenericMeasureResultDto | undefined; writable: boolean; disabled: boolean; state: 'ready' | 'loading' | 'unavailable'; onChange: (operation: ColumnOperation | null) => void }) {
  const { t } = useTranslation();
  const label = operation === null ? t('genericReports.tableAggregates.add') : t(operationLabels[operation]);
  const value = state === 'loading' ? '…' : state === 'unavailable' ? '—' : result ? reportNumber(result.value, result.unit) : '—';
  const content = <><span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>{operation !== null ? <strong className="font-medium tabular-nums text-ink">{value}</strong> : null}</>;
  const coverage = result ? t('genericReports.coverage', { filled: result.coverage.filled, tasks: result.coverage.tasks, missing: result.coverage.missing, nulls: result.coverage.null, zero: result.coverage.zero }) : undefined;
  if (!writable) return operation === null ? null : <span className="flex items-center justify-end gap-2" title={coverage}>{content}</span>;
  return <Menu.Root modal={false}><Menu.Trigger asChild><button type="button" disabled={disabled} aria-label={t('genericReports.tableAggregates.choose', { field: fieldName })} title={coverage} className="inline-flex min-h-7 max-w-full items-center justify-end gap-2 rounded px-1 text-xs outline-none hover:bg-canvas focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50">{content}</button></Menu.Trigger><Menu.Portal><Menu.Content align="end" sideOffset={4} aria-label={t('genericReports.tableAggregates.choose', { field: fieldName })} className="z-50 min-w-44 rounded-lg border border-line bg-surface p-1 text-xs text-ink shadow-lg"><Menu.RadioGroup value={operation ?? 'none'} onValueChange={next => onChange(next === 'none' ? null : next as ColumnOperation)}>{columnOperations.map(item => <Menu.RadioItem key={item} value={item} className="cursor-pointer rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas data-[state=checked]:font-semibold">{t(operationLabels[item])}</Menu.RadioItem>)}<Menu.Separator className="my-1 h-px bg-line"/><Menu.RadioItem value="none" className="cursor-pointer rounded px-3 py-2 outline-none data-[highlighted]:bg-canvas">{t('genericReports.tableAggregates.none')}</Menu.RadioItem></Menu.RadioGroup></Menu.Content></Menu.Portal></Menu.Root>;
}
