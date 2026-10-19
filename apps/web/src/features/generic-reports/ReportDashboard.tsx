import type { GenericComparisonDto, GenericMeasureResultDto, GenericReportNumberDto, GenericReportResultDto, MembershipDto, SectionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { reportGroupLabel } from './groupLabel';
import { reportNumber, roundedRational } from './reportFormatting';
import { operationLabels, reasonLabels } from './translationKeys';

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
const greater = (a: GenericReportNumberDto, b: GenericReportNumberDto) => BigInt(a.numerator) * BigInt(b.denominator) > BigInt(b.numerator) * BigInt(a.denominator);
const wholeMinutes = (minutes: number): GenericReportNumberDto => ({ numerator: String(minutes), denominator: '1', decimal: String(minutes) });

function Bar({ label, value, unit, scale, series }: { label: string; value: GenericReportNumberDto | null; unit: Unit; scale: GenericReportNumberDto | null; series: 'plan' | 'fact' }) {
  const fill = value && scale ? share(value, scale) : null;
  return <span className="flex items-center gap-2 text-xs">
    <span className="w-14 shrink-0 text-muted">{label}</span>
    <span aria-hidden="true" className="block h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">{fill ? <span data-series={series} className={`block h-full rounded-full ${series === 'plan' ? 'bg-muted' : 'bg-accent'}`} style={{ width: `${percentDigits(fill)}%` }}/> : null}</span>
    <span className="shrink-0 tabular-nums">{reportNumber(value, unit, true)}</span>
  </span>;
}

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
function CapacityCard({ capacity, result }: { capacity: Capacity; result: GenericReportResultDto }) {
  const { t } = useTranslation();
  const { totals, settingsConfigured } = capacity, title = t('genericReports.dashboard.capacityTitle');
  const ratio = recordedCapacityRatio(result);
  const duration = (minutes: number) => reportNumber(wholeMinutes(minutes), 'minutes', true);
  return <article aria-label={title} className="min-w-0 space-y-1 rounded-xl border border-line bg-surface p-4">
    <h3 className="truncate text-sm font-medium">{title}</h3>
    <p className="text-xs text-muted">{t('genericReports.dashboard.capacityRange', { from: capacity.startDate, to: capacity.endDate })}</p>
    <p className="text-xl font-semibold tabular-nums">{settingsConfigured ? duration(totals.availableMinutes) : '—'}</p>
    {settingsConfigured ? <p className="text-xs text-muted">{t('genericReports.dashboard.capacityBreakdown', { scheduled: duration(totals.scheduledMinutes), holidays: duration(totals.holidayMinutes), absence: duration(totals.absenceMinutes) })}</p> : <p role="status" className="text-xs text-muted">{t('genericReports.dashboard.capacityUnconfigured')}</p>}
    {settingsConfigured && totals.unconfiguredMembers > 0 ? <p className="text-xs text-muted">{t('genericReports.dashboard.capacityUnknownMembers', { members: totals.unconfiguredMembers })}</p> : null}
    <p className="text-sm font-medium tabular-nums" title={ratio===null?t('genericReports.dashboard.ratioUnavailable'):undefined}>{t('genericReports.dashboard.recordedCapacity', {percent:ratio===null?'—':`${ratio}%`})}</p>
    <p className="text-xs text-muted">{t('genericReports.dashboard.capacityCaveat')}</p>
  </article>;
}

/** Manager overview built only from authoritative server aggregates; never from loaded detail rows. */
export function ReportDashboard({ result, members, sections, hideSummary = false, onPersonSelect }: { result: GenericReportResultDto; members: readonly MembershipDto[]; sections: readonly SectionDto[]; hideSummary?: boolean; onPersonSelect?: (membershipId: string | null) => void }) {
  const { t } = useTranslation();
  const { comparison, groupBy, filters } = result.config;
  const fieldName = (id: string | null) => result.fields.find(field => field.id === id)?.name ?? t('genericReports.unavailableField');
  /** Only duration fields are minutes; number and other numeric fields are never shown as hours. */
  const unitOf = (id: string): Unit => result.fields.find(field => field.id === id)?.type === 'duration' ? 'minutes' : 'number';
  const fullSum = (id: string) => result.measures.find(measure => measure.operation === 'sum' && measure.fieldId === id);
  const groupName = (key: string, label: string) => reportGroupLabel(result.config, key, label, result.fields, members, sections);
  const planName = comparison ? fieldName(comparison.planFieldId) : '', factName = comparison ? fieldName(comparison.factFieldId) : '';
  const planUnit: Unit = comparison ? unitOf(comparison.planFieldId) : 'number', factUnit: Unit = comparison ? unitOf(comparison.factFieldId) : 'number';
  const deltaText = (pair: GenericComparisonDto) => {
    if (!pair.difference) return pair.unavailableReason ? t(reasonLabels[pair.unavailableReason]) : t('genericReports.dashboard.deltaUnknown');
    const sign = BigInt(pair.difference.numerator), value = reportNumber(pair.difference, factUnit, true);
    return sign < 0n ? t('genericReports.dashboard.deltaUnder', { value }) : sign === 0n ? t('genericReports.dashboard.deltaEqual') : t('genericReports.dashboard.deltaOver', { value });
  };
  const people = comparison && groupBy.kind === 'assignee' ? result.groups : null;
  const scale = people && planUnit === factUnit ? people.flatMap(group => group.comparison ? [group.comparison.plan, group.comparison.fact] : []).reduce<GenericReportNumberDto | null>((max, value) => value && BigInt(value.numerator) >= 0n && (!max || greater(value, max)) ? value : max, null) : null;
  const distribution = groupBy.kind === 'category' ? (comparison && fullSum(comparison.factFieldId)) || result.measures.find(measure => measure.operation === 'sum' && measure.unit === 'minutes') : undefined;
  const total = distribution ? reportNumber(distribution.value, distribution.unit, true) : '';
  const peopleTitle = t('genericReports.dashboard.peopleTitle'), categoryTitle = groupBy.kind === 'category' ? t('genericReports.dashboard.categoryTitle', { field: fieldName(groupBy.fieldId) }) : '';
  return <section aria-label={t('genericReports.dashboard.title')} className="min-w-0 space-y-4">
    {!hideSummary && (comparison || result.capacity) ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {comparison ? <TotalCard title={t('genericReports.dashboard.planTitle', { name: planName })} measure={fullSum(comparison.planFieldId)} unit={planUnit} comparison={result.comparison} paired={result.comparison?.plan ?? null}/> : null}
      {comparison ? <TotalCard title={t('genericReports.dashboard.factTitle', { name: factName })} measure={fullSum(comparison.factFieldId)} unit={factUnit} comparison={result.comparison} paired={result.comparison?.fact ?? null}/> : null}
      {result.capacity ? <CapacityCard capacity={result.capacity} result={result}/> : null}
    </div> : null}
    {!hideSummary && !comparison && !result.capacity && groupBy.kind !== 'category' ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{result.measures.slice(0,3).map(measure=><TotalCard key={measure.key} title={`${t(operationLabels[measure.operation])} · ${measure.fieldId?fieldName(measure.fieldId):t('genericReports.task')}`} measure={measure} unit={measure.unit} comparison={null} paired={null}/>)}</div> : null}
    {hideSummary && result.capacity && recordedCapacityRatio(result)!==null ? <p className="text-sm font-medium tabular-nums">{t('genericReports.dashboard.recordedCapacity',{percent:`${recordedCapacityRatio(result)}%`})}</p> : null}
    {people ? <section aria-label={peopleTitle} className="space-y-2 rounded-xl border border-line bg-surface p-4">
      <h3 className="text-sm font-medium">{peopleTitle}</h3>
      <p className="text-xs text-muted">{t('genericReports.dashboard.peopleHint')}</p>
      {result.comparison ? <p className="text-xs text-muted">{t('genericReports.dashboard.pairedTotal', { paired: result.comparison.pairedTasks, eligible: result.comparison.eligibleTasks })}</p> : null}
      <ul className="space-y-3">{people.map(group => {
        const name = groupName(group.key, group.label), pair = group.comparison;
        const label = pair ? t('genericReports.dashboard.personComparison', { name, planName, plan: reportNumber(pair.plan, planUnit, true), factName, fact: reportNumber(pair.fact, factUnit, true), delta: deltaText(pair), paired: pair.pairedTasks, eligible: pair.eligibleTasks }) : t('genericReports.dashboard.personUnavailable', { name });
        return <li key={group.key} className="grid items-center gap-2 sm:grid-cols-[minmax(0,12rem)_1fr]">
          {onPersonSelect ? <button type="button" aria-label={t('genericReports.dashboard.showPerson', { name })} onClick={() => onPersonSelect(group.key === 'unassigned' ? null : group.key)} className="truncate text-left text-sm font-medium text-accent hover:underline">{name}</button> : <span className="truncate text-sm font-medium">{name}</span>}
          <div role="img" aria-label={label} title={label} className="min-w-0 space-y-1">
            <Bar label={t('genericReports.plan')} value={pair?.plan ?? null} unit={planUnit} scale={scale} series="plan"/>
            <Bar label={t('genericReports.fact')} value={pair?.fact ?? null} unit={factUnit} scale={scale} series="fact"/>
            <p className="text-xs text-muted">{pair ? deltaText(pair) : '—'}</p>
            <p className="text-xs font-medium tabular-nums" title={pair?.ratio ? `${pair.ratio.numerator}/${pair.ratio.denominator}` : pair?.unavailableReason ? t(reasonLabels[pair.unavailableReason]) : t('genericReports.dashboard.deltaUnknown')}>{t('genericReports.dashboard.accuracyRatio',{percent:pair?.ratio?`${roundedRational(BigInt(pair.ratio.numerator)*100n,BigInt(pair.ratio.denominator)).text}%`:'—'})}</p>
          </div>
        </li>;
      })}</ul>
    </section> : null}
    {groupBy.kind === 'category' ? <section aria-label={categoryTitle} className="space-y-2 rounded-xl border border-line bg-surface p-4">
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
