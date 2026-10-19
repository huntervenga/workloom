import { ReportCapacityResults } from '../time-off/ReportCapacityResults';
import { operationLabels, groupLabels, comparisonLabels, reasonLabels, cellLabels, statusLabels, cohortLabels } from './translationKeys';
import { reportGroupLabel } from './groupLabel';
import type { MembershipDto, SectionDto, TagDto, GenericComparisonDto, GenericCoverageDto, GenericMeasureResultDto, GenericReportCellDto, GenericReportNumberDto, GenericReportResultDto } from '@workloom/contracts';
import { Link } from 'react-router';
import { t, useTranslation } from '../../i18n';
import { formatEstimate } from '../task-table';
/** Half-up display rounding uses the authoritative rational, including values beyond Number precision. */
function roundedRational(numerator: bigint, denominator: bigint): { text: string; width: string } {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const scaled = magnitude * 100n, remainder = scaled % denominator;
  const hundredths = scaled / denominator + (remainder * 2n >= denominator ? 1n : 0n);
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  const width = `${hundredths / 100n}${fraction ? `.${fraction}` : ''}`;
  return { text: `${remainder !== 0n ? '≈' : ''}${numerator < 0n && hundredths !== 0n ? '-' : ''}${width}`, width };
}
function exactTitle(value: GenericReportNumberDto | null): string | undefined {
  return value ? `${value.numerator}/${value.denominator} (${value.decimal})` : undefined;
}
/** Never rebuild an authoritative aggregate from loaded detail rows or convert its exact decimal to float. */
export function reportNumber(value: GenericReportNumberDto | null, unit: string, compact = false): string {
  if (value === null) return '—';
  if (unit === 'minutes' && value.denominator === '1') {
    const signed = BigInt(value.numerator), minutes = signed < 0n ? -signed : signed;
    const hours = minutes / 60n, rest = minutes % 60n;
    const shown = hours === 0n ? t('genericReports.durationMinutes', { minutes: rest.toString() }) : rest === 0n ? t('genericReports.durationHours', { hours: hours.toString() }) : t('genericReports.durationHoursMinutes', { hours: hours.toString(), minutes: rest.toString() });
    return signed < 0n ? `-${shown}` : shown;
  }
  const rounded = compact ? roundedRational(BigInt(value.numerator), BigInt(value.denominator)).text : value.decimal;
  return unit === 'minutes' ? `${rounded} ${t('genericReports.minutes')}` : rounded;
}
export function Coverage({ coverage }: { coverage: GenericCoverageDto }) {
  const { t } = useTranslation();
  return <p className="text-xs text-muted">{t('genericReports.coverage', { filled: coverage.filled, tasks: coverage.tasks, missing: coverage.missing, nulls: coverage.null, zero: coverage.zero })}</p>;
}
export function Measure({ measure, result }: { measure: GenericMeasureResultDto; result: Pick<GenericReportResultDto, 'fields'> }) {
  const { t } = useTranslation();
  const field = result.fields.find(item => item.id === measure.fieldId);
  return <div className="min-w-0 space-y-1"><p className="truncate text-xs text-muted">{t(operationLabels[measure.operation])}{field ? ` · ${field.name}` : ''}</p><p className="text-xl font-semibold tabular-nums" title={exactTitle(measure.value)}>{reportNumber(measure.value, measure.unit, true)}</p><Coverage coverage={measure.coverage}/></div>;
}
export function Comparison({ comparison, initial = false }: { comparison: GenericComparisonDto; initial?: boolean }) {
  const { t } = useTranslation();
  return <div className="space-y-2 rounded-lg border border-line p-3"><h3 className="text-sm font-medium">{t(initial ? 'genericReports.initialComparison' : 'genericReports.comparison')}</h3><dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">{(['plan', 'fact', 'difference', 'ratio'] as const).map(key => <div key={key}><dt className="text-xs text-muted">{t(comparisonLabels[key])}</dt><dd title={exactTitle(comparison[key])} className={`font-semibold tabular-nums ${key === 'difference' && comparison.difference && !comparison.difference.numerator.startsWith('-') && comparison.difference.numerator !== '0' ? 'text-danger' : ''}`}>{reportNumber(comparison[key], key === 'ratio' ? 'number' : 'minutes', true)}</dd></div>)}</dl>{comparison.unavailableReason ? <p role="status" className="text-xs text-muted">{t(reasonLabels[comparison.unavailableReason])}</p> : null}<p className="text-xs text-muted">{t('genericReports.paired', { paired: comparison.pairedTasks, eligible: comparison.eligibleTasks })}</p><Coverage coverage={comparison.planCoverage}/><Coverage coverage={comparison.factCoverage}/></div>;
}
/** Shares use matching full-scope SUM measures, never detail-page rows or comparison pairs. */
function RecordedShare({ measure, whole, name }: { measure: GenericMeasureResultDto; whole: GenericMeasureResultDto | undefined; name: string }) {
  const { t } = useTranslation();
  let share: { numerator: bigint; denominator: bigint; text: string; width: string } | null = null;
  if (measure.value && whole?.value && measure.coverage.filled > 0 && whole.coverage.filled > 0) {
    const numerator = BigInt(measure.value.numerator) * BigInt(whole.value.denominator);
    const denominator = BigInt(measure.value.denominator) * BigInt(whole.value.numerator);
    if (numerator >= 0n && denominator > 0n && numerator <= denominator) {
      const percentNumerator = numerator * 100n;
      share = { numerator: percentNumerator, denominator, ...roundedRational(percentNumerator, denominator) };
    }
  }
  const label = share ? t('genericReports.recordedShareValue', { name, percent: share.text, numerator: share.numerator.toString(), denominator: share.denominator.toString() }) : t('genericReports.recordedShareUnknown', { name });
  return <span role="img" aria-label={label} title={label} className="block min-w-0 space-y-1">
    <span className="flex min-w-0 justify-between gap-2 text-xs font-normal text-muted"><span className="truncate">{name} · {t('genericReports.recordedShare')}</span><strong className="shrink-0 font-semibold tabular-nums text-ink">{share ? `${share.text}%` : '—'}</strong></span>
    <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-canvas">{share ? <span className="block h-full rounded-full bg-accent" style={{ width: `${share.width}%` }}/>: null}</span>
  </span>;
}
export function ReportResults({ result, workspaceId, members, sections, tags = [] }: { result: GenericReportResultDto; workspaceId: string; members: readonly MembershipDto[]; sections: readonly SectionDto[]; tags?: readonly TagDto[] }) {
  const { t } = useTranslation();
  const groupLabel = (key: string, label: string) => reportGroupLabel(result.config, key, label, result.fields, members, sections);
  const cell = (entry: GenericReportCellDto | undefined, fieldId: string) => {
    if (!entry || entry.state !== 'value') return t(cellLabels[entry?.state ?? 'missing']);
    return result.fields.find(field => field.id === fieldId)?.type === 'duration' && entry.value !== null ? formatEstimate(entry.value) : String(entry.value);
  };
  const filters = result.config.filters;
  const dateSource = filters.dateRange?.source;
  const dateName = dateSource?.kind === 'field' ? result.fields.find(field => field.id === dateSource.fieldId)?.name ?? t('genericReports.unavailableField') : t('genericReports.dueDate');
  const grouping = result.config.groupBy;
  const groupingName = grouping.kind === 'category' ? result.fields.find(field => field.id === grouping.fieldId)?.name ?? t('genericReports.unavailableField') : t(groupLabels[grouping.kind]);
  const selectedAssignee = filters.assignee;
  const fields = result.fields.filter(field => field.type === 'number' || field.type === 'duration');
  const capacityComparison = result.config.groupBy.kind === 'assignee' && result.config.comparison ? { planName: result.fields.find(field => field.id === result.config.comparison?.planFieldId)?.name ?? t('genericReports.planField'), factName: result.fields.find(field => field.id === result.config.comparison?.factFieldId)?.name ?? t('genericReports.factField'), values: new Map(result.groups.map(group => [group.key, { plan: reportNumber(group.comparison?.plan ?? null, 'minutes', true), fact: reportNumber(group.comparison?.fact ?? null, 'minutes', true) }])) } : undefined;
  return <section aria-label={t('genericReports.results')} className="min-w-0 space-y-4">
    <div><h2 className="text-lg font-semibold">{t('genericReports.results')}</h2><p className="text-xs text-muted">{t('genericReports.authoritative', { count: result.totalTasks })}</p><p className="text-xs text-muted">{t('genericReports.roundedHint')}</p></div>
    <section aria-label={t('genericReports.reportScope')} className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-canvas p-3 text-xs text-muted"><span>{filters.dateRange ? t('genericReports.dateScope', { field: dateName, from: filters.dateRange.from, to: filters.dateRange.to }) : t('genericReports.allTime')}</span><span>{t(result.hierarchy === 'root_tasks' ? 'genericReports.rootTasks' : 'genericReports.allTasks')}</span><span>{t('genericReports.currentGroupScope', { group: groupingName })}</span>{result.config.comparison ? <span>{t('genericReports.comparisonScopeLabel', { scope: t(result.config.comparison.completion === 'done_only' ? 'genericReports.completedOnly' : 'genericReports.allTasks') })}</span> : null}{filters.statusGroups.length ? <span>{t('genericReports.completionScope', { statuses: filters.statusGroups.map(status => t(statusLabels[status])).join(', ') })}</span> : null}{selectedAssignee.kind !== 'all' ? <span>{t('genericReports.assigneeScope', { name: selectedAssignee.kind === 'unassigned' ? t('genericReports.unassigned') : members.find(member => member.id === selectedAssignee.membershipId)?.displayName ?? t('genericReports.formerMember') })}</span> : null}{filters.tagIds.length ? <span>{t('genericReports.tagScope', { tags: filters.tagIds.map(id => tags.find(tag => tag.id === id)?.name ?? t('genericReports.unavailableTag')).join(', ') })}</span> : null}</section>
    <div className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-2 xl:grid-cols-3">{result.measures.map(measure => <Measure key={measure.key} measure={measure} result={result}/>)}</div>
    {result.capacity ? <ReportCapacityResults capacity={result.capacity} comparison={capacityComparison}/> : null}
    {result.initialCapacity ? <ReportCapacityResults capacity={result.initialCapacity} initial/> : null}
    {result.initialMeasures ? <section aria-label={t('genericReports.originalTotals')} className="space-y-2"><h3 className="text-sm font-medium">{t('genericReports.originalTotals')}</h3><p className="text-xs text-muted">{t('genericReports.originalTotalsHint')}</p><div className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2">{result.initialMeasures.map(measure => <Measure key={measure.key} measure={measure} result={result.initialSnapshot ?? result}/>)}</div></section> : null}
    {result.config.comparison ? <p className="text-xs text-muted">{t('genericReports.comparisonSources', { plan: result.fields.find(field => field.id === result.config.comparison?.planFieldId)?.name ?? t('genericReports.unavailableField'), fact: result.fields.find(field => field.id === result.config.comparison?.factFieldId)?.name ?? t('genericReports.unavailableField') })}</p> : null}
    {result.comparison ? <Comparison comparison={result.comparison}/> : null}
    {result.initialSnapshot ? <div className="space-y-2 rounded-lg bg-canvas p-3"><h3 className="text-sm font-semibold">{t('genericReports.snapshotSummary', { name: result.initialSnapshot.name })}</h3><p className="text-xs text-muted">{t('genericReports.snapshotCaptured', { time: result.initialSnapshot.capturedAt, revision: result.initialSnapshot.definitionRevision })}</p>{result.cohorts ? <p className="text-sm">{t('genericReports.cohorts', result.cohorts)}</p> : null}{result.initialComparison ? <Comparison comparison={result.initialComparison} initial/> : null}<p className="text-xs text-muted">{t('genericReports.snapshotHint')}</p></div> : null}
    {result.config.groupBy.kind !== 'none' ? <section aria-label={t('genericReports.breakdown')} className="space-y-2"><h3 className="font-medium">{t('genericReports.breakdown')}</h3>{result.measures.some(measure => measure.operation === 'sum' && measure.unit === 'minutes') ? <p className="text-xs text-muted">{t('genericReports.recordedShareHint')}</p> : null}{result.groups.map(group => <details key={group.key} className="rounded-lg border border-line bg-surface p-3"><summary className="cursor-pointer text-sm font-medium"><span>{groupLabel(group.key, group.label)} · {t('genericReports.taskCount', { count: group.taskCount })}</span><span className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs font-normal text-muted">{group.measures.slice(0, 2).map(measure => <span key={measure.key}>{result.fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.task')} · {t(operationLabels[measure.operation])}: <strong title={exactTitle(measure.value)} className="font-semibold text-ink tabular-nums">{reportNumber(measure.value, measure.unit, true)}</strong></span>)}</span><span className="mt-2 grid gap-2 sm:grid-cols-2">{group.measures.filter(measure => measure.operation === 'sum' && measure.unit === 'minutes').map(measure => <RecordedShare key={measure.key} measure={measure} whole={result.measures.find(whole => whole.key === measure.key && whole.fieldId === measure.fieldId && whole.operation === measure.operation && whole.unit === measure.unit)} name={result.fields.find(field => field.id === measure.fieldId)?.name ?? t('genericReports.unavailableField')}/>)}</span></summary><div className="mt-3 grid gap-3 sm:grid-cols-2">{group.measures.map(measure => <Measure key={measure.key} measure={measure} result={result}/>)}</div>{group.comparison ? <div className="mt-3"><Comparison comparison={group.comparison}/></div> : null}{group.initialComparison ? <div className="mt-3"><Comparison comparison={group.initialComparison} initial/></div> : null}</details>)}</section> : null}
    {result.totalTasks === 0 ? <p role="status" className="rounded-lg border border-line p-4 text-sm text-muted">{t('genericReports.empty')}</p> : <div className="overflow-x-auto rounded-lg border border-line"><table className="w-full whitespace-nowrap text-left text-sm"><caption className="sr-only">{t('genericReports.detail')}</caption><thead className="bg-canvas text-xs text-muted"><tr><th className="px-3 py-2">{t('genericReports.task')}</th><th className="px-3 py-2">{t('genericReports.groupBy')}</th><th className="px-3 py-2">{t('genericReports.taskStatus')}</th>{result.comparison ? <th className="px-3 py-2">{t('genericReports.difference')}</th> : null}{result.initialSnapshot ? <th className="px-3 py-2">{t('genericReports.membership')}</th> : null}{fields.map(field => <th key={field.id} className="px-3 py-2">{field.name}{result.initialSnapshot ? ` · ${t('genericReports.currentInitial')}` : ''}</th>)}</tr></thead><tbody>{result.rows.map(row => <tr key={row.taskId} className="border-t border-line"><th scope="row" className="max-w-72 truncate px-3 py-2 font-medium"><Link to={`/w/${workspaceId}/projects/${row.homeProjectId}?task=${row.taskId}`} title={row.title} className="text-accent hover:underline">{row.title}</Link></th><td className="px-3 py-2 text-muted">{groupLabel(row.groupKey, row.groupLabel)}</td><td className="px-3 py-2">{t(statusLabels[row.statusGroup])}</td>{result.comparison ? <td className="px-3 py-2 tabular-nums">{result.config.comparison?.completion === 'done_only' && row.statusGroup !== 'done' ? t('genericReports.notCompleted') : reportNumber(row.comparison?.difference ?? null, 'minutes')}</td> : null}{result.initialSnapshot ? <td className="px-3 py-2">{t(cohortLabels[row.cohort])}</td> : null}{fields.map(field => <td key={field.id} className="px-3 py-2 tabular-nums">{cell(row.values.find(value => value.fieldId === field.id), field.id)}{row.initialValues ? ` / ${cell(row.initialValues.find(value => value.fieldId === field.id), field.id)}` : null}</td>)}</tr>)}</tbody></table></div>}
  </section>;
}
