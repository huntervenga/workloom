import type { GenericMeasureResultDto, GenericReportNumberDto, GenericReportResultDto } from '@workloom/contracts';
import { useTranslation } from '../../i18n';
import { isComparisonMeasure } from './effortAttribution';
import { personMetrics } from './dashboardMetrics';
import { reportNumber, roundedRational } from './reportFormatting';
import { reasonLabels } from './translationKeys';

type Unit = GenericMeasureResultDto['unit'];
const minutesValue = (value: number): GenericReportNumberDto => ({ numerator: String(value), denominator: '1', decimal: String(value) });
const greater = (a: GenericReportNumberDto, b: GenericReportNumberDto) => BigInt(a.numerator) * BigInt(b.denominator) > BigInt(b.numerator) * BigInt(a.denominator);

/** All three series use complete authoritative person totals. Accuracy is a separate paired comparison. */
export function ReportPeopleOverview({ result, nameOf, planUnit, factUnit, onPersonSelect }: { result: GenericReportResultDto; nameOf: (key: string, label: string) => string; planUnit: Unit; factUnit: Unit; onPersonSelect?: (membershipId: string | null) => void }) {
  const { t } = useTranslation();
  const rows = personMetrics(result);
  const date = result.config.filters.dateRange, capacity = result.capacity;
  const datesAligned = !capacity || !!date && date.from === capacity.startDate && date.to === capacity.endDate;
  const comparable = planUnit === factUnit;
  const scale = comparable ? rows.flatMap(row => [row.plan, row.fact, ...(planUnit === 'minutes' && row.capacityMinutes !== null ? [minutesValue(row.capacityMinutes)] : [])]).reduce<GenericReportNumberDto | null>((maximum, value) => value && BigInt(value.numerator) >= 0n && (!maximum || greater(value, maximum)) ? value : maximum, null) : null;
  const cell = (value: GenericReportNumberDto | null, unit: Unit, series: 'capacity' | 'plan' | 'fact') => {
    const width = value && scale && BigInt(scale.numerator) > 0n && BigInt(value.numerator) >= 0n && (series !== 'capacity' || planUnit === 'minutes') ? roundedRational(BigInt(value.numerator) * BigInt(scale.denominator) * 100n, BigInt(value.denominator) * BigInt(scale.numerator)).width : null;
    return <span className="block space-y-1.5"><span className="font-semibold tabular-nums">{reportNumber(value, unit, true)}</span><span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-canvas">{width !== null ? <span data-series={series} className={`block h-full rounded-full ${series === 'capacity' ? 'bg-cyan-600' : series === 'plan' ? 'bg-muted' : 'bg-accent'}`} style={{ width: `${width}%` }}/> : null}</span></span>;
  };
  return <section aria-label={t(result.config.comparison?.attribution === 'personal_effort' ? 'effortReports.personalPeopleTitle' : 'genericReports.dashboard.peopleTitle')} className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
    <div className="space-y-1 p-4"><h3 className="text-sm font-semibold">{t('genericReports.dashboard.peopleThreeTitle')}</h3><p className="text-xs text-muted">{t(result.config.comparison?.attribution === 'personal_effort' ? 'effortReports.personalFullScope' : 'genericReports.dashboard.peopleFullHint')}</p>{!datesAligned && capacity ? <p role="status" className="text-xs text-muted">{t('genericReports.dashboard.capacityDifferentDates',{from:capacity.startDate,to:capacity.endDate})}</p> : null}</div>
    <div className="max-h-[34rem] overflow-auto"><table className="w-full min-w-[36rem] text-left text-sm"><caption className="sr-only">{t(result.config.comparison?.attribution === 'personal_effort' ? 'effortReports.personalFullScope' : 'genericReports.dashboard.peopleFullHint')}</caption><thead className="sticky top-0 bg-surface text-xs text-muted"><tr><th scope="col" className="px-4 py-2 font-medium">{t('genericReports.quickPeople')}</th><th scope="col" className="w-[17%] px-3 py-2 font-medium">{t('genericReports.dashboard.availableShort')}</th><th scope="col" className="w-[17%] px-3 py-2 font-medium">{t('genericReports.plan')}</th><th scope="col" className="w-[17%] px-3 py-2 font-medium">{t('genericReports.fact')}</th><th scope="col" className="px-3 py-2 font-medium">{t('genericReports.dashboard.estimationTitle')}</th></tr></thead><tbody>{rows.map(row => {
      const effort = result.groups.find(group=>group.key===row.key)?.measures.find(measure=>isComparisonMeasure(measure,result.config,result.config.comparison?.factFieldId??''))?.effort;
      const name = nameOf(row.key, row.label), pair = row.comparison, capacity = row.capacityMinutes === null ? null : minutesValue(row.capacityMinutes);
      const ratio = pair?.ratio ? `${roundedRational(BigInt(pair.ratio.numerator) * 100n, BigInt(pair.ratio.denominator)).text}%` : '—';
      const hint = pair?.unavailableReason ? t(reasonLabels[pair.unavailableReason]) : t('genericReports.dashboard.accuracyHint');
      return <tr key={row.key} data-report-person={row.key} className="border-t border-line" aria-label={t('genericReports.dashboard.personThreeSummary', { name, available: reportNumber(capacity, 'minutes', true), plan: reportNumber(row.plan, planUnit, true), fact: reportNumber(row.fact, factUnit, true) })}>
        <th scope="row" className="max-w-56 px-4 py-3 align-top font-medium">{onPersonSelect ? <button type="button" onClick={() => onPersonSelect(row.key === 'unassigned' ? null : row.key)} aria-label={t('genericReports.dashboard.showPerson', { name })} className="max-w-full truncate text-left text-accent hover:underline">{name}</button> : <span className="block truncate">{name}</span>}<span className="block text-xs font-normal text-muted">{t('genericReports.taskCount', { count: row.taskCount })}</span></th>
        <td className="px-3 py-3 align-top" title={row.capacityMinutes === null ? t(result.capacity ? 'genericReports.dashboard.capacityHelp.personUnknown' : 'genericReports.dashboard.capacityNeedsPeriod') : undefined}>{cell(capacity, 'minutes', 'capacity')}{row.capacityMinutes === null ? <span className="mt-1 block text-xs text-muted">{row.key === 'unassigned' ? t('genericReports.capacityPeriod.unassignedShort') : !result.capacity ? t('genericReports.capacityPeriod.noPeriodShort') : !result.capacity.members.some(member => member.membershipId === row.key) ? t('genericReports.capacityPeriod.personNotSelectedShort') : t('genericReports.capacityPeriod.scheduleUnknownShort')}</span> : null}</td>
        <td className="px-3 py-3 align-top">{cell(row.plan, planUnit, 'plan')}</td><td className="px-3 py-3 align-top">{cell(row.fact, factUnit, 'fact')}{effort ? <span className="mt-1 block text-xs text-muted">{t('effortReports.coverage',effort.coverage)}{effort.coverage.unknown ? ` · ${t('effortReports.knownSubtotal')}` : ''}</span>:null}</td>
        <td className="px-3 py-3 align-top"><span className={`font-medium tabular-nums ${pair?.difference && BigInt(pair.difference.numerator) > 0n ? 'text-danger' : ''}`} title={hint}>{t('genericReports.dashboard.accuracyRatio', { percent: ratio })}</span><span className="mt-1 block text-xs text-muted">{pair ? t('genericReports.dashboard.pairedShort', { paired: pair.pairedTasks, eligible: pair.eligibleTasks }) : '—'}</span></td>
      </tr>;
    })}</tbody></table></div>
    {!rows.length ? <p className="px-4 pb-4 text-sm text-muted">{t('genericReports.dashboard.peopleEmpty')}</p> : null}
    {result.comparison ? <p className="px-4 py-3 text-xs text-muted">{t(result.config.comparison?.attribution === 'personal_effort' ? 'effortReports.paired' : 'genericReports.dashboard.pairedTotal', { paired: result.comparison.pairedTasks, eligible: result.comparison.eligibleTasks })}</p> : null}
  </section>;
}
