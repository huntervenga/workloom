import type { GenericComparisonDto, GenericMeasureResultDto, GenericReportNumberDto, GenericReportResultDto, MembershipDto, SectionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { reportGroupLabel } from './groupLabel';
import { reportNumber, roundedRational } from './reportFormatting';
import { operationLabels } from './translationKeys';
import { ReportPeopleOverview } from './ReportPeopleOverview';

type Unit = GenericMeasureResultDto['unit'];
type Share = { exact: boolean; basisPoints: bigint };
type Capacity = NonNullable<GenericReportResultDto['capacity']>;

/** Exact part/whole as half-up basis points (0–10000). Only this bounded integer becomes text, so huge rationals never lose precision. */
function share(part: GenericReportNumberDto, whole: GenericReportNumberDto): Share | null {
  const numerator = BigInt(part.numerator) * BigInt(whole.denominator), denominator = BigInt(part.denominator) * BigInt(whole.numerator);
  if (numerator < 0n || denominator <= 0n || numerator > denominator) return null;
  const scaled = numerator * 10000n;
  return { exact: scaled % denominator === 0n, basisPoints: (scaled * 2n + denominator) / (denominator * 2n) };
}
function percentDigits({ basisPoints }: Share): string {
  const fraction = (basisPoints % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${basisPoints / 100n}${fraction ? `.${fraction}` : ''}`;
}
const percentText = (value: Share) => `${value.exact ? '' : '≈'}${percentDigits(value)}`;
const wholeMinutes = (minutes: number): GenericReportNumberDto => ({ numerator: String(minutes), denominator: '1', decimal: String(minutes) });

/** Headline is the full-scope SUM measure; the paired comparison value is shown only as a labelled subset. */
function TotalCard({ title, measure, unit, comparison, paired }: { title: string; measure: GenericMeasureResultDto | undefined; unit: Unit; comparison: GenericComparisonDto | null; paired: GenericReportNumberDto | null }) {
  const { t } = useTranslation();
  return <article aria-label={title} className="min-w-0 space-y-1 rounded-xl border border-line bg-surface p-4">
    <h3 className="truncate text-sm font-medium">{title}</h3>
    <p className="text-xs text-muted">{t('genericReports.dashboard.fullScope')}</p>
    <p className="text-xl font-semibold tabular-nums">{reportNumber(measure?.value ?? null, measure?.unit ?? unit, true)}</p>
    <p className="text-xs text-muted">{measure ? t('genericReports.coverage', { filled: measure.coverage.filled, tasks: measure.coverage.tasks, missing: measure.coverage.missing, nulls: measure.coverage.null, zero: measure.coverage.zero }) : t('genericReports.dashboard.noFullSum')}</p>
    {comparison ? <p className="text-xs text-muted">{t('genericReports.dashboard.pairedValue', { value: reportNumber(paired, unit, true), paired: comparison.pairedTasks, eligible: comparison.eligibleTasks })}</p> : null}
  </article>;
}

/** Compare recorded task-date cohorts with capacity only when people and boundaries can be proved aligned. */
export function recordedCapacityRatio(result: GenericReportResultDto): string | null {
  const capacity=result.capacity,comparison=result.config.comparison,date=result.config.filters.dateRange;
  if(!capacity||!comparison||!date||date.from!==capacity.startDate||date.to!==capacity.endDate||!capacity.settingsConfigured||capacity.totals.unconfiguredMembers!==0||capacity.members.length===0||capacity.members.some(member=>!member.scheduleKnown)||capacity.totals.availableMinutes<=0)return null;
  const assignee=result.config.filters.assignee,ids=new Set(capacity.members.map(member=>member.membershipId));
  const peopleAligned=assignee.kind==='member'?capacity.members.length===1&&ids.has(assignee.membershipId):assignee.kind==='all'&&result.config.groupBy.kind==='assignee'&&result.groups.every(group=>group.taskCount===0||ids.has(group.key));
  if(!peopleAligned)return null;
  const actual=result.measures.find(measure=>measure.operation==='sum'&&measure.fieldId===comparison.factFieldId&&measure.unit==='minutes');
  if(!actual?.value||actual.coverage.filled===0||BigInt(actual.value.numerator)<0n)return null;
  return roundedRational(BigInt(actual.value.numerator)*100n,BigInt(actual.value.denominator)*BigInt(capacity.totals.availableMinutes)).text;
}

/** Capacity is compared with recorded task-date cohorts only when people, dates and schedules align. */
function CapacityCard({ capacity, result, onChoosePeriod }: { capacity: Capacity; result: GenericReportResultDto; onChoosePeriod?: () => void }) {
  const { t } = useTranslation();
  const { totals, settingsConfigured } = capacity, title = t('genericReports.dashboard.capacityTitle');
  const ratio = recordedCapacityRatio(result);
  const date = result.config.filters.dateRange, datesAligned = !!date && date.from === capacity.startDate && date.to === capacity.endDate;
  const duration = (minutes: number) => reportNumber(wholeMinutes(minutes), 'minutes', true);
  return <article aria-label={title} className="min-w-0 space-y-1 rounded-xl border border-line bg-surface p-4">
    <h3 className="truncate text-sm font-medium">{title}</h3>
    <p className="text-xs text-muted">{t('genericReports.dashboard.capacityRange', { from: capacity.startDate, to: capacity.endDate })}</p>
    <p className="text-xl font-semibold tabular-nums">{settingsConfigured ? duration(totals.availableMinutes) : '—'}</p>
    {settingsConfigured ? <p className="text-xs text-muted">{t('genericReports.dashboard.capacityBreakdown', { scheduled: duration(totals.scheduledMinutes), holidays: duration(totals.holidayMinutes), absence: duration(totals.absenceMinutes) })}</p> : <p role="status" className="text-xs text-muted">{t('genericReports.dashboard.capacityUnconfigured')}</p>}
    {settingsConfigured && totals.unconfiguredMembers > 0 ? <p className="text-xs text-muted">{t('genericReports.dashboard.capacityUnknownMembers', { members: totals.unconfiguredMembers })}</p> : null}
    <p className="text-sm font-medium tabular-nums" title={ratio===null?t('genericReports.dashboard.ratioUnavailable'):t('genericReports.dashboard.capacityCaveat')}>{t('genericReports.dashboard.recordedCapacity', {percent:ratio===null?'—':`${ratio}%`})}</p>
    <p className="sr-only">{t('genericReports.dashboard.capacityCaveat')}</p>
    {!datesAligned && onChoosePeriod && result.config.filters.assignee.kind !== 'unassigned' ? <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={onChoosePeriod}>{t(date?'genericReports.dashboard.useSelectedDates':'genericReports.dashboard.showThisWeek')}</button> : null}
  </article>;
}

/** Manager overview built only from authoritative server aggregates; never from loaded detail rows. */
export function ReportDashboard({ result, members, sections, hideSummary = false, summaryOnly = false, onChoosePeriod, onPersonSelect }: { result: GenericReportResultDto; members: readonly MembershipDto[]; sections: readonly SectionDto[]; hideSummary?: boolean; summaryOnly?: boolean; onChoosePeriod?: () => void; onPersonSelect?: (membershipId: string | null) => void }) {
  const { t } = useTranslation();
  const { comparison, groupBy, filters } = result.config;
  const fieldName = (id: string | null) => result.fields.find(field => field.id === id)?.name ?? t('genericReports.unavailableField');
  /** Only duration fields are minutes; number and other numeric fields are never shown as hours. */
  const unitOf = (id: string): Unit => result.fields.find(field => field.id === id)?.type === 'duration' ? 'minutes' : 'number';
  const fullSum = (id: string) => result.measures.find(measure => measure.operation === 'sum' && measure.fieldId === id);
  const groupName = (key: string, label: string) => !result.groups.some(group => group.key === key) ? result.capacity?.members.find(member => member.membershipId === key)?.displayName ?? reportGroupLabel(result.config, key, label, result.fields, members, sections) : reportGroupLabel(result.config, key, label, result.fields, members, sections);
  const planName = comparison ? fieldName(comparison.planFieldId) : '', factName = comparison ? fieldName(comparison.factFieldId) : '';
  const planUnit: Unit = comparison ? unitOf(comparison.planFieldId) : 'number', factUnit: Unit = comparison ? unitOf(comparison.factFieldId) : 'number';
  const people = comparison && groupBy.kind === 'assignee';
  const distribution = groupBy.kind === 'category' ? (comparison && fullSum(comparison.factFieldId)) || result.measures.find(measure => measure.operation === 'sum' && measure.unit === 'minutes') : undefined;
  const total = distribution ? reportNumber(distribution.value, distribution.unit, true) : '';
  const categoryTitle = groupBy.kind === 'category' ? t('genericReports.dashboard.categoryTitle', { field: fieldName(groupBy.fieldId) }) : '';
  return <section aria-label={t('genericReports.dashboard.title')} className="min-w-0 space-y-4">
    {!hideSummary && (comparison || result.capacity) ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {result.capacity ? <CapacityCard capacity={result.capacity} result={result} {...(onChoosePeriod ? {onChoosePeriod} : {})}/> : comparison ? <article aria-label={t('genericReports.dashboard.capacityTitle')} className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4"><h3 className="text-sm font-medium">{t('genericReports.dashboard.capacityTitle')}</h3><p className="text-xl font-semibold">—</p><p className="text-xs text-muted">{t(result.config.filters.assignee.kind==='unassigned'?'genericReports.dashboard.capacityUnassigned':'genericReports.dashboard.capacityNeedsPeriod')}</p>{onChoosePeriod && result.config.filters.assignee.kind !== 'unassigned' ? <button type="button" className="text-xs font-medium text-accent hover:underline" onClick={onChoosePeriod}>{t(result.config.filters.dateRange?'genericReports.dashboard.useSelectedDates':'genericReports.dashboard.showThisWeek')}</button> : null}</article> : null}
      {comparison ? <TotalCard title={t('genericReports.dashboard.planTitle', { name: planName })} measure={fullSum(comparison.planFieldId)} unit={planUnit} comparison={result.comparison} paired={result.comparison?.plan ?? null}/> : null}
      {comparison ? <TotalCard title={t('genericReports.dashboard.factTitle', { name: factName })} measure={fullSum(comparison.factFieldId)} unit={factUnit} comparison={result.comparison} paired={result.comparison?.fact ?? null}/> : null}
    </div> : null}
    {!hideSummary && !comparison && !result.capacity && groupBy.kind !== 'category' ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{result.measures.slice(0,3).map(measure=><TotalCard key={measure.key} title={`${t(operationLabels[measure.operation])} · ${measure.fieldId?fieldName(measure.fieldId):t('genericReports.task')}`} measure={measure} unit={measure.unit} comparison={null} paired={null}/>)}</div> : null}
    {!summaryOnly && people ? <ReportPeopleOverview result={result} nameOf={groupName} planUnit={planUnit} factUnit={factUnit} {...(onPersonSelect ? {onPersonSelect} : {})}/> : null}
    {!summaryOnly && groupBy.kind === 'category' ? <section aria-label={categoryTitle} className="space-y-2 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-medium">{categoryTitle}</h3>
      {distribution ? <>
        <p className="text-xs text-muted">{t('genericReports.dashboard.categoryTotal', { measure: fieldName(distribution.fieldId), total })}</p>
        <ul className="space-y-2">{result.groups.map(group => {
          const part = group.measures.find(measure => measure.key === distribution.key && measure.operation === 'sum' && measure.fieldId === distribution.fieldId);
          const portion = part?.value && distribution.value && part.coverage.filled > 0 && distribution.coverage.filled > 0 ? share(part.value, distribution.value) : null;
          const name = groupName(group.key, group.label), value = reportNumber(part?.value ?? null, distribution.unit, true);
          const label = portion ? t('genericReports.dashboard.categoryShare', { name, value, total, percent: percentText(portion) }) : t('genericReports.dashboard.categoryUnknown', { name, value });
          return <li key={group.key}><div role="img" aria-label={label} title={label} className="space-y-1">
            <span className="flex min-w-0 justify-between gap-2 text-sm"><span className="truncate">{name}</span><span className="shrink-0 tabular-nums">{value} · {portion ? `${percentText(portion)}%` : '—'}</span></span>
            <span aria-hidden="true" className="block h-2 overflow-hidden rounded-full bg-canvas">{portion ? <span className="block h-full rounded-full bg-accent" style={{ width: `${percentDigits(portion)}%` }}/> : null}</span>
          </div></li>;
        })}</ul>
      </> : <p role="status" className="text-xs text-muted">{t('genericReports.dashboard.noDistributionMeasure')}</p>}
      <p className="text-xs text-muted">{t('genericReports.dashboard.categoryHint')}</p>
      {filters.tagIds.length ? <p className="text-xs text-muted">{t('genericReports.dashboard.categoryTags')}</p> : null}
    </section> : null}
  </section>;
}
