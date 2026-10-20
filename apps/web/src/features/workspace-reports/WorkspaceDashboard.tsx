import type { ReactNode } from 'react';
import type { WorkspaceReportPersonDto, WorkspaceReportResultDto, WorkspaceReportSummaryDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { capacitySummary } from '../generic-reports/capacitySummary';
import { categoryColor, effortCategoryColor } from '../generic-reports/categoryColors';
import { reportNumber, roundedRational } from '../generic-reports/reportFormatting';

type Num = WorkspaceReportSummaryDto['plan']['value'];
type Rat = { n: bigint; d: bigint };
type Bar = { label: string; text: string; width: string; tone: string };
type Coverage = WorkspaceReportSummaryDto['plan']['coverage'];
type BucketCapacity = WorkspaceReportResultDto['buckets'][number]['capacity'];

const tones = { available: 'bg-cyan-600', plan: 'bg-muted', actual: 'bg-accent' } as const;
const panel = 'min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4';
const rat = (value: Num): Rat | null => (value ? { n: BigInt(value.numerator), d: BigInt(value.denominator) } : null);
const minutesRat = (minutes: number | null): Rat | null => (minutes === null ? null : { n: BigInt(minutes), d: 1n });
const wholeMinutes = (minutes: number) => ({ numerator: String(minutes), denominator: '1', decimal: String(minutes) });
const greater = (a: Rat, b: Rat) => a.n * b.d > b.n * a.d;
const coverage = (c: Coverage) => ({ filled: c.filled, tasks: c.tasks, missing: c.missing, nulls: c.null, zero: c.zero });
const entries = (s: WorkspaceReportSummaryDto, available: number | null): [string, Rat | null][] => [['minutes', minutesRat(available)], [s.plan.unit, rat(s.plan.value)], [s.fact.unit, rat(s.fact.value)]];

/** Largest positive value per unit, so bars of different units never share a scale. */
function scaleBy(values: readonly [string, Rat | null][]): Map<string, Rat> {
  const max = new Map<string, Rat>();
  for (const [unit, value] of values) {
    const top = max.get(unit);
    if (value && value.n > 0n && (!top || greater(value, top))) max.set(unit, value);
  }
  return max;
}
/** Exact BigInt share of the scale clamped to 0–100; authoritative decimals are never converted to Number. */
function barLength(value: Rat | null, max: Rat | undefined): string {
  if (!value || !max || value.n <= 0n || max.n <= 0n) return '0';
  return greater(value, max) ? '100' : roundedRational(value.n * max.d * 100n, value.d * max.n).width;
}
/** Paired Actual/estimate is the server ratio × 100; it is never derived from the full plan/actual sums. */
const ratioPercent = (ratio: Num) => (ratio ? `${roundedRational(BigInt(ratio.numerator) * 100n, BigInt(ratio.denominator)).text}%` : '—');

function Card({ title, value, lines, hint, action }: { title: string; value: string; lines: readonly string[]; hint?: string | undefined; action?: ReactNode }) {
  return <article aria-label={title} title={hint} className="min-w-0 space-y-1 rounded-xl border border-line bg-surface p-4">
    <h3 className="truncate text-sm font-medium text-muted">{title}</h3>
    <p className="text-2xl font-semibold tabular-nums">{value}</p>
    {lines.map(line => <p key={line} className="text-xs text-muted">{line}</p>)}{action}
  </article>;
}

function Bars({ items }: { items: readonly Bar[] }) {
  return <div className="space-y-1">{items.map(item => <div key={item.label} className="grid grid-cols-[5rem_minmax(0,1fr)_6rem] items-center gap-2 text-xs">
    <span className="text-muted">{item.label}</span>
    <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-canvas"><span className={`block h-full rounded-full ${item.tone}`} style={{ width: `${item.width}%` }}/></span>
    <span className="text-right tabular-nums">{item.text}</span>
  </div>)}</div>;
}

/** Manager overview from authoritative server aggregates only; loaded task rows are never summed into totals. */
export function WorkspaceDashboard({ result, onPersonSelect, onConfigureTypes, capacityAction, categoryFields = [] }: { result: WorkspaceReportResultDto; onPersonSelect: (membershipId: string | null) => void; onConfigureTypes?: () => void; capacityAction?: ReactNode; categoryFields?: readonly TaskFieldDefinitionDto[] }) {
  const { t } = useTranslation();
  const { summary, capacity } = result;
  const series = { available: t('workspaceReports.series.available'), plan: t('workspaceReports.series.plan'), actual: t('workspaceReports.series.actual') };
  const duration = (minutes: number | null) => (minutes === null ? '—' : reportNumber(wholeMinutes(minutes), 'minutes', true));
  const amount = (value: Num, unit: string) => reportNumber(value, unit, true);
  const reason = (s: WorkspaceReportSummaryDto) => (s.comparison.unavailableReason ? t(s.comparison.unavailableReason === 'no_tasks' ? 'workspaceReports.reason.noTasks' : s.comparison.unavailableReason === 'missing_plan' ? 'workspaceReports.reason.missingPlan' : s.comparison.unavailableReason === 'missing_fact' ? 'workspaceReports.reason.missingFact' : 'workspaceReports.reason.zeroPlan') : undefined);
  /** Preserve authoritative known capacity as an explicitly labelled subtotal when peers are unknown. */
  const known = capacitySummary(capacity), teamAvailable = known.availableMinutes;
  const hasUnassignedActual = result.people.some(person => person.fact.coverage.filled > 0 && (!person.membershipId || !capacity.members.some(member => member.membershipId === person.membershipId)));
  const teamRatioCapacity = hasUnassignedActual || !known.complete ? null : teamAvailable;
  const personAvailable = (p: WorkspaceReportPersonDto) => (capacity.settingsConfigured && p.capacity?.scheduleKnown ? p.capacity.availableMinutes : null);
  const bucketAvailable = (c: BucketCapacity) => (capacity.settingsConfigured && c.unconfiguredMembers === 0 ? c.availableMinutes : null);
  const recordedPercent = (s: WorkspaceReportSummaryDto, available: number | null) => !s.effort?.fact.coverage.unknown && available !== null && available > 0 && s.fact.unit === 'minutes' && s.fact.value && s.fact.coverage.filled > 0 ? `${roundedRational(BigInt(s.fact.value.numerator) * 100n, BigInt(s.fact.value.denominator) * BigInt(available)).text}%` : '—';
  const bars = (s: WorkspaceReportSummaryDto, available: number | null, scale: Map<string, Rat>): [Bar, Bar, Bar] => [
    { label: series.available, text: duration(available), width: barLength(minutesRat(available), scale.get('minutes')), tone: tones.available },
    { label: series.plan, text: amount(s.plan.value, s.plan.unit), width: barLength(rat(s.plan.value), scale.get(s.plan.unit)), tone: tones.plan },
    { label: series.actual, text: amount(s.fact.value, s.fact.unit), width: barLength(rat(s.fact.value), scale.get(s.fact.unit)), tone: tones.actual },
  ];
  const peopleScale = scaleBy(result.people.flatMap(p => entries(p, personAvailable(p))));
  const trendScale = scaleBy(result.buckets.flatMap(b => entries(b, bucketAvailable(b.capacity))));
  const total = rat(summary.fact.value);
  const share = (part: Num) => {
    const p = rat(part);
    if (!p || !total || total.n <= 0n || p.n < 0n) return null;
    return { text: roundedRational(p.n * total.d * 100n, p.d * total.n).text, width: barLength(p, total) };
  };
  const totalNote = !total ? t('workspaceReports.categories.totalUnknown') : total.n === 0n ? t('workspaceReports.categories.totalZero') : t('workspaceReports.categories.total', { total: amount(summary.fact.value, summary.fact.unit) });
  const capacityNote = teamAvailable !== null ? t('workspaceReports.cards.capacityBreakdown', { scheduled: duration(capacity.totals.scheduledMinutes), holidays: duration(capacity.totals.holidayMinutes), absence: duration(capacity.totals.absenceMinutes) }) : capacity.settingsConfigured ? t('workspaceReports.cards.capacityUnknownMembers', { members: capacity.totals.unconfiguredMembers }) : t('workspaceReports.cards.capacityUnconfigured');
  const paired = summary.comparison.ratio ? t(summary.effort ? 'effortReports.pairedAccuracy' : 'workspaceReports.cards.paired', { percent: ratioPercent(summary.comparison.ratio), paired: summary.comparison.pairedTasks, eligible: summary.comparison.eligibleTasks }) : t('workspaceReports.cards.pairedUnavailable', { reason: reason(summary) ?? '—' });
  const trendTitle = result.bucket === 'week' ? t('workspaceReports.trend.weekly') : t('workspaceReports.trend.monthly');
  const legend = <ul className="flex flex-wrap gap-3 text-xs text-muted">{(['available', 'plan', 'actual'] as const).map(key => <li key={key} className="flex items-center gap-1"><span aria-hidden="true" className={`h-2 w-2 rounded-full ${tones[key]}`}/>{series[key]}</li>)}</ul>;
  return <section aria-label={t('workspaceReports.overviewTitle')} className="min-w-0 space-y-4 text-ink">
    <header className="sr-only">
      <h2 className="text-base font-semibold">{t('workspaceReports.overviewTitle')}</h2>
      <p className="text-xs text-muted">{t('workspaceReports.scope', { from: result.range.from, to: result.range.to, tasks: summary.taskCount, completion: result.completion === 'done_only' ? t('workspaceReports.completion.doneOnly') : t('workspaceReports.completion.allTasks') })}</p>
    </header>
    {result.attribution === 'personal_effort' ? <div className="space-y-1 rounded-lg bg-canvas px-3 py-2 text-xs text-muted"><p className="font-medium text-ink">{t('effortReports.personalEffort')}</p><p>{t('effortReports.sourceHint')}</p><p>{t('effortReports.dateHint')}</p>{summary.effort ? <><p>{t('effortReports.measureCoverage',{tasks:summary.effort.fact.canonicalTaskCount,participations:summary.effort.fact.participationCount})}</p><p>{t('effortReports.coverage',summary.effort.fact.coverage)}</p>{summary.effort.fact.coverage.unknown>0?<p>{t('effortReports.knownSubtotal')}</p>:null}</>:null}</div> : null}
    <div className="grid gap-3 sm:grid-cols-3">
      <Card title={t('workspaceReports.cards.available')} action={!known.complete ? capacityAction : undefined} value={duration(teamAvailable)} lines={[t('workspaceReports.cards.range', { from: capacity.startDate, to: capacity.endDate }), ...(known.partial ? [t('workspaceReports.cards.capacityPartial', { known: known.knownMembers, total: known.totalMembers })] : []), capacityNote]}/>
      <Card title={t('workspaceReports.cards.plan')} value={amount(summary.plan.value, summary.plan.unit)} lines={[summary.effort ? t('effortReports.coverage',summary.effort.plan.coverage) : t('workspaceReports.cards.coverage', coverage(summary.plan.coverage))]}/>
      <Card title={t('workspaceReports.cards.actual')} hint={hasUnassignedActual ? t('workspaceReports.unassignedRatio') : undefined} value={amount(summary.fact.value, summary.fact.unit)} lines={[summary.effort ? t('effortReports.coverage',summary.effort.fact.coverage) : t('workspaceReports.cards.coverage', coverage(summary.fact.coverage)), t('workspaceReports.recordedAvailable', { percent: recordedPercent(summary, teamRatioCapacity) }), paired]}/>
    </div>
    <div className="grid gap-4 lg:grid-cols-2">
      <section aria-label={trendTitle} className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{trendTitle}</h3>{legend}</div>
        {result.buckets.length ? <ol className="flex items-end gap-2 overflow-x-auto pb-1">{result.buckets.map(b => {
          const [available, plan, actual] = bars(b, bucketAvailable(b.capacity), trendScale);
          const label = t('workspaceReports.trend.bucket', { from: b.startDate, to: b.endDate, available: available.text, plan: plan.text, actual: actual.text });
          return <li key={b.startDate} className="flex min-w-[3rem] flex-1 flex-col items-center gap-1">
            <div role="img" aria-label={label} title={label} className="flex h-36 w-full items-end justify-center gap-0.5">
              {[available, plan, actual].map(bar => <span key={bar.label} className={`w-2 rounded-t ${bar.tone}`} style={{ height: `${bar.width}%` }}/>)}
            </div>
            <span aria-hidden="true" className="text-[10px] tabular-nums text-muted">{result.bucket === 'month' ? b.startDate.slice(0, 7) : b.startDate.slice(5)}</span>
          </li>;
        })}</ol> : <p role="status" className="text-xs text-muted">{t('workspaceReports.trend.empty')}</p>}
        <p className="text-xs text-muted">{t('workspaceReports.trend.caption')}</p>
      </section>
      <section aria-label={t('workspaceReports.categories.title')} className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('workspaceReports.categories.title')}</h3>{result.sources.every(source => source.categoryFieldId === null) && onConfigureTypes ? <button type="button" className="text-xs font-medium text-accent-strong hover:underline" onClick={onConfigureTypes}>{t('workspaceReports.configureTypes')}</button> : null}</div>
        <p className="text-xs text-muted">{totalNote}</p>
        {result.categories.length ? <ul className="space-y-2">{result.categories.map(c => {
          const color = c.color && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color.toLowerCase() : effortCategoryColor(c.fact.effort??c.effort?.fact,c.fieldId,c.optionId) ?? categoryColor(categoryFields, c.projectId, c.fieldId, c.optionId);
          const portion = share(c.fact.value), value = amount(c.fact.value, c.fact.unit);
          const name = c.projectName ? t('workspaceReports.categories.name', { label: c.key === 'category_not_captured' ? t('effortReports.categoryNotCaptured') : c.optionId === null ? t('workspaceReports.uncategorized') : c.label, project: c.projectName }) : c.key === 'category_not_captured' ? t('effortReports.categoryNotCaptured') : c.optionId === null ? t('workspaceReports.uncategorized') : c.label;
          const label = portion ? t('workspaceReports.categories.share', { name, value, percent: portion.text }) : t('workspaceReports.categories.unknownShare', { name, value });
          return <li key={c.key} data-report-category-option={c.optionId ?? 'uncategorized'}><div role="img" aria-label={label} title={label} className="space-y-1">
            <span className="flex min-w-0 justify-between gap-2 text-sm"><span className="inline-flex min-w-0 items-center gap-2"><span aria-hidden="true" data-category-swatch="" className={`size-2.5 shrink-0 rounded-full border border-ink/60 ${color ? '' : 'bg-accent'}`} style={color ? { backgroundColor: color } : undefined}/><span className="truncate">{name}</span></span><span className="shrink-0 tabular-nums">{portion ? t('workspaceReports.categories.value', { value, percent: portion.text }) : value}</span></span>
            <span aria-hidden="true" className="block h-2 overflow-hidden rounded-full bg-canvas">{portion ? <span data-category-bar="" className={`block h-full rounded-full border border-ink/60 ${color ? '' : 'bg-accent'}`} style={{ width: `${portion.width}%`, ...(color ? { backgroundColor: color } : {}) }}/> : null}</span>
          </div></li>;
        })}</ul> : <p role="status" className="text-xs text-muted">{t('workspaceReports.categories.empty')}</p>}
      </section>
    </div>
    <section aria-label={t('workspaceReports.people.title')} className={panel}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t('workspaceReports.people.title')}</h3>{legend}</div>
      {result.people.length ? <div className="overflow-x-auto"><table className="w-full min-w-[40rem] text-sm"><colgroup><col className="w-48"/><col/><col className="w-48"/></colgroup>
        <thead className="text-xs text-muted"><tr>
          <th scope="col" className="py-1 pr-3 text-left font-medium">{t('workspaceReports.people.person')}</th>
          <th scope="col" className="py-1 text-left font-medium">{t('workspaceReports.people.comparison')}</th>
          <th scope="col" className="py-1 pl-3 text-right font-medium">{t('workspaceReports.people.ratio')}</th>
        </tr></thead>
        <tbody className="divide-y divide-line">{result.people.map(p => <tr key={p.membershipId ?? 'unassigned'}>
          <th scope="row" className="w-48 max-w-48 py-2 pr-3 text-left align-top font-normal">
            <span>{p.membershipId === null ? <span className="block truncate font-medium">{t('workspaceReports.people.unassigned')}</span> : <button type="button" title={p.displayName} className="block w-full min-w-0 truncate text-left font-medium text-accent-strong hover:underline" onClick={() => onPersonSelect(p.membershipId)}>{p.displayName}</button>}</span>
            <p className="text-xs text-muted">{t('workspaceReports.people.tasks', { tasks: p.taskCount })}</p>
          </th>
          <td className="py-2"><Bars items={bars(p, personAvailable(p), peopleScale)}/>{p.effort ? <p className="mt-1 text-xs text-muted">{t('effortReports.coverage',p.effort.fact.coverage)}{p.effort.fact.coverage.unknown?` · ${t('effortReports.knownSubtotal')}`:''}</p>:null}</td>
          <td className="py-2 pl-3 text-right align-top tabular-nums" title={reason(p)}>{ratioPercent(p.comparison.ratio)}<p className="text-xs text-muted">{t('workspaceReports.recordedAvailable', { percent: recordedPercent(p, personAvailable(p)) })}</p><p className="text-xs text-muted">{t('workspaceReports.people.paired', { paired: p.comparison.pairedTasks, eligible: p.comparison.eligibleTasks })}</p></td>
        </tr>)}</tbody>
      </table></div> : <p role="status" className="text-xs text-muted">{t('workspaceReports.people.empty')}</p>}
    </section>
  </section>;
}
