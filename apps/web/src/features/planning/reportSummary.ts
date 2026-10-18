import { formatDate, formatNumber, t } from '../../i18n';
import type { PlanBaselineDto, PlanningPeriodDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactSummaryDto, WorkTypeBucketDto, WorkTypeReportRunDto } from '@workloom/contracts';
import { formatEstimate } from '../task-table';
import { formatPeriodCutoff } from './dates';

/** Pure presentation of saved report DTOs. Nothing here sums people, rows or pages: every number is a server field. */

type SavedPerson = { membershipId: string; memberName: string };
type SavedPeople = { membershipIds: readonly string[]; byPerson: readonly SavedPerson[] };

/** The last included calendar day; the period end is exclusive. */
export function inclusiveWeekEnd(localEndExclusive: string): string {
  const date = new Date(`${localEndExclusive}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function weekRangeLabel(period: Pick<PlanningPeriodDto, 'localStart' | 'localEndExclusive'>): string {
  return t('reportUX.header.weekRange', {
    start: formatDate(period.localStart, { dateStyle: 'medium' }),
    end: formatDate(inclusiveWeekEnd(period.localEndExclusive), { dateStyle: 'medium' }),
  });
}

/** Saved timestamps are always shown in the period's named zone, never the viewer's. */
export function savedTime(timestamp: string, period: Pick<PlanningPeriodDto, 'timezone'>): string {
  return formatPeriodCutoff(timestamp, period.timezone);
}

/** Stable display order by saved name, then ID. Never by variance, hours or any productivity signal. */
export function sortPeopleByName<T extends SavedPerson>(people: readonly T[]): T[] {
  return [...people].sort((a, b) => a.memberName.localeCompare(b.memberName) || (a.membershipId < b.membershipId ? -1 : a.membershipId > b.membershipId ? 1 : 0));
}

export interface SavedPeopleScope {
  /** Number of people captured by the saved run. */
  count: number;
  /** Snapshot names in display order; saved IDs absent from the saved results keep a neutral label. */
  names: string[];
}

/**
 * People come only from the saved run (membershipIds and byPerson snapshot names), never current memberships.
 * membershipIds is the effective list the server stored, so it says nothing about how people were chosen;
 * the saved results are used only if that list is empty.
 */
export function savedPeopleScope(run: SavedPeople): SavedPeopleScope {
  if (run.membershipIds.length === 0) return { count: run.byPerson.length, names: sortPeopleByName(run.byPerson).map((person) => person.memberName) };
  const named = run.membershipIds.map((id) => ({ membershipId: id, memberName: run.byPerson.find((person) => person.membershipId.toLowerCase() === id.toLowerCase())?.memberName ?? null }));
  const known = sortPeopleByName(named.flatMap((person) => person.memberName === null ? [] : [{ membershipId: person.membershipId, memberName: person.memberName }]));
  const unnamed = named.filter((person) => person.memberName === null).length;
  return { count: run.membershipIds.length, names: [...known.map((person) => person.memberName), ...Array.from({ length: unnamed }, () => t('reportUX.people.notInResults'))] };
}

export function peopleScopeLabel(scope: SavedPeopleScope): string {
  return t('reportUX.people.saved', { count: scope.count });
}

export function knownOnlyLabel(knownOnly: boolean): string {
  return knownOnly ? t('reportUX.knownOnly.on') : t('reportUX.knownOnly.off');
}

/** Saved-run picker label: time in the period zone, effective people, baseline scope and the unchanged known-only segment. */
export function weeklyRunOptionLabel(run: WeeklyPlanFactReportRunDto, period: Pick<PlanningPeriodDto, 'timezone'>, scope: string): string {
  return t('reportUX.runOption', { time: savedTime(run.createdAt, period), timezone: period.timezone, people: peopleScopeLabel(savedPeopleScope(run)), scope, knownOnly: run.knownEstimatesOnly ? t('planning.knownPlansOnly') : t('planning.allSelectedPeople') });
}

/** Saved breakdown picker label: time in the period zone, saved people count and the server total, so same-time runs differ. */
export function workTypeRunOptionLabel(run: WorkTypeReportRunDto, period: Pick<PlanningPeriodDto, 'timezone'>): string {
  return t('reportUX.workTypeRunOption', { time: savedTime(run.createdAt, period), timezone: period.timezone, people: peopleScopeLabel(savedPeopleScope(run)), total: formatEstimate(run.totalActualMinutes) });
}

export function signedMinutes(minutes: number): string { return `${minutes > 0 ? '+' : minutes < 0 ? '−' : ''}${formatEstimate(Math.abs(minutes))}`; }

/** A summary with no original baseline rows has no baseline comparison at all. */
export function hasBaselineWork(summary: WeeklyPlanFactSummaryDto): boolean {
  return summary.baselineCompleteness.totalItemCount > 0 || summary.factCoverage.totalItemCount > 0;
}

/** Known baseline plan; zero known items is Not known, never 0m. A known active zero stays 0m. */
export function knownPlanText(summary: WeeklyPlanFactSummaryDto): string {
  if (summary.baselineCompleteness.totalItemCount === 0) return t('reportUX.value.noBaselineWork');
  return summary.baselineCompleteness.knownItemCount === 0 ? t('reportUX.value.notKnown') : formatEstimate(summary.knownPlannedMinutes);
}

/** Actual hours for baseline work; zero recorded items is Not recorded, never 0m. */
export function baselineActualText(summary: WeeklyPlanFactSummaryDto): string {
  if (summary.factCoverage.totalItemCount === 0) return t('reportUX.value.noBaselineWork');
  return summary.factCoverage.recordedItemCount === 0 ? t('reportUX.value.notRecorded') : formatEstimate(summary.actualMinutes);
}

export function varianceText(summary: WeeklyPlanFactSummaryDto): string {
  if (!hasBaselineWork(summary)) return t('reportUX.value.varianceUnavailable');
  return summary.totalVarianceMinutes === null ? t('reportUX.value.insufficientData') : signedMinutes(summary.totalVarianceMinutes);
}

/** A null server percentage is never shown as 0%; a known zero plan has no defined percentage. */
export function variancePercentText(summary: WeeklyPlanFactSummaryDto): string {
  if (summary.totalVariancePercent !== null) return formatNumber(summary.totalVariancePercent / 100, { style: 'percent', maximumFractionDigits: 1 });
  return summary.baselineCompleteness.knownItemCount > 0 && summary.knownPlannedMinutes === 0 ? t('reportUX.value.percentZeroPlan') : t('reportUX.value.percentUnavailable');
}

/** Server coverage counts over original baseline rows only. */
export function coverageText(summary: WeeklyPlanFactSummaryDto): string {
  if (!hasBaselineWork(summary)) return t('reportUX.value.noBaselineWork');
  return t('reportUX.coverage', {
    known: summary.baselineCompleteness.knownItemCount, plans: summary.baselineCompleteness.totalItemCount,
    recorded: summary.factCoverage.recordedItemCount, facts: summary.factCoverage.totalItemCount,
  });
}

export interface WeeklyBriefContext {
  projectName?: string;
  period: PlanningPeriodDto;
  report: WeeklyPlanFactReportRunDto;
  scopeLabel: string;
  /** Used only when it is the report's own baseline. */
  baseline?: PlanBaselineDto | null;
}

function identityLines(projectName: string | undefined, period: PlanningPeriodDto, createdAt: string, factCutoffAt: string, people: SavedPeopleScope): string[] {
  return [
    ...(projectName ? [t('reportUX.brief.project', { project: projectName })] : []),
    t('reportUX.brief.week', { period: period.name, range: weekRangeLabel(period), timezone: period.timezone }),
    t('reportUX.brief.times', { createdAt: savedTime(createdAt, period), asOf: savedTime(factCutoffAt, period), timezone: period.timezone }),
    t('reportUX.brief.people', { people: peopleScopeLabel(people), names: people.names.length ? people.names.join(', ') : t('reportUX.people.none') }),
  ];
}

export function matchedBaseline(report: { baselineId: string }, baseline: PlanBaselineDto | null | undefined): PlanBaselineDto | null {
  return baseline && baseline.id.toLowerCase() === report.baselineId.toLowerCase() ? baseline : null;
}

/** Plain-text brief of one saved weekly report, built only from the saved run DTO. */
export function weeklyReportBrief({ projectName, period, report, scopeLabel, baseline }: WeeklyBriefContext): string {
  const summary = report.summary;
  const frozen = matchedBaseline(report, baseline);
  const people = sortPeopleByName(report.byPerson);
  return [
    t('reportUX.brief.weeklyTitle'),
    ...identityLines(projectName, period, report.createdAt, report.factCutoffAt, savedPeopleScope(report)),
    frozen ? t('reportUX.brief.baselineFrozen', { scope: scopeLabel, time: savedTime(frozen.frozenAt, period) }) : t('reportUX.brief.baseline', { scope: scopeLabel }),
    t('reportUX.brief.knownOnly', { knownOnly: knownOnlyLabel(report.knownEstimatesOnly) }),
    t('reportUX.brief.plan', { value: knownPlanText(summary) }),
    t('reportUX.brief.actual', { value: baselineActualText(summary) }),
    t('reportUX.brief.variance', { value: varianceText(summary), percent: variancePercentText(summary) }),
    t('reportUX.brief.coverage', { value: coverageText(summary) }),
    t('reportUX.brief.added', { value: formatEstimate(summary.addedActualMinutes) }),
    t('reportUX.brief.unplanned', { value: formatEstimate(summary.unplannedActualMinutes) }),
    t('reportUX.brief.total', { value: formatEstimate(summary.totalActualMinutes) }),
    t('reportUX.brief.disjoint'),
    t('reportUX.brief.byPerson'),
    ...(people.length ? people.map((person) => t('reportUX.brief.personLine', {
      person: person.memberName, plan: knownPlanText(person.summary), actual: baselineActualText(person.summary), variance: varianceText(person.summary),
      added: formatEstimate(person.summary.addedActualMinutes), unplanned: formatEstimate(person.summary.unplannedActualMinutes), total: formatEstimate(person.summary.totalActualMinutes),
    })) : [t('reportUX.people.none')]),
    t('reportUX.brief.missingIsNotZero'),
  ].join('\n');
}

export function workTypeBucketLabel(bucket: WorkTypeBucketDto): string {
  return bucket.fieldId === null && bucket.optionId === null ? t('work-categories.uncategorized') : bucket.label;
}

export function shareText(value: number | null): string {
  return value === null ? t('work-categories.shareUndefined') : formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 });
}

/** Plain-text brief of one saved work-type breakdown; shares use the server denominator, including uncategorized. */
export function workTypeReportBrief({ projectName, period, report }: { projectName?: string; period: PlanningPeriodDto; report: WorkTypeReportRunDto }): string {
  const people = sortPeopleByName(report.byPerson);
  return [
    t('reportUX.brief.workTypeTitle'),
    ...identityLines(projectName, period, report.createdAt, report.factCutoffAt, savedPeopleScope(report)),
    t('reportUX.brief.workTypeTotals', { total: formatEstimate(report.totalActualMinutes), count: report.activeSourceCount, categorized: formatEstimate(report.categorizedMinutes), uncategorized: formatEstimate(report.uncategorizedMinutes) }),
    t('reportUX.brief.byWorkType'),
    ...(report.byCategory.length ? report.byCategory.map((bucket) => t('reportUX.brief.bucketLine', { category: workTypeBucketLabel(bucket), hours: formatEstimate(bucket.minutes), share: shareText(bucket.sharePercent) })) : [t('reportUX.brief.noBuckets')]),
    t('reportUX.brief.byPerson'),
    ...(people.length ? people.map((person) => t('reportUX.brief.workTypePersonLine', { person: person.memberName, hours: formatEstimate(person.totalActualMinutes), count: person.activeSourceCount })) : [t('reportUX.people.none')]),
    t('reportUX.brief.workTypeDisclaimer'),
  ].join('\n');
}
