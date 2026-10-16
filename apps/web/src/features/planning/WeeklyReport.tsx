import { useTranslation, formatDate, formatNumber } from '../../i18n';
import { RecordedWorkLabel } from '../../shared/RecordedWorkLabel';
import type { MembershipDto, PlanBaselineDto, PlanningPeriodDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto, WeeklyPlanFactSummaryDto } from '@workloom/contracts';
import { Badge, Button, StateCard, inputClassName } from '@workloom/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table';
import { PlanFactChart } from './PlanFactChart';
import { ReportTaskLinks } from './ReportTaskLinks';
import { useReportRowsQuery, useReportRunQuery, type PlanningCommands } from './queries';

export interface ReportSelection { baselineId: string; knownOnly: boolean; membershipIds: string[] }

interface Props {
  actorId: string;
  workspaceId: string;
  period: PlanningPeriodDto;
  baselines: readonly PlanBaselineDto[];
  runs: readonly WeeklyPlanFactReportRunDto[];
  members: readonly MembershipDto[];
  runId: string;
  selection: ReportSelection | undefined;
  onSelectionChange: (selection: ReportSelection) => void;
  mutation: PlanningCommands['createReport'];
  onSelectRun: (runId: string, periodId: string) => void;
}

export function WeeklyReport(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const { period, mutation } = props;
  const fallback = period.projectBaselineId ?? props.baselines.find((baseline) => baseline.scope === 'project')?.id ?? props.baselines[0]?.id ?? '';
  const chosen = props.selection ?? { baselineId: fallback, knownOnly: false, membershipIds: [] };
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const shown = held?.input ?? { baselineId: chosen.baselineId, knownEstimatesOnly: chosen.knownOnly, membershipIds: chosen.membershipIds };
  const selectedBaseline = props.baselines.find((baseline) => baseline.id === shown.baselineId);
  const personalMember = selectedBaseline?.scope === 'self' ? selectedBaseline.membershipId : null;
  const setChosen = (update: Partial<ReportSelection>) => props.onSelectionChange({ ...chosen, ...update });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.pendingCommand) return;
    if (mutation.uncertain) { mutation.retryUncertain({ onSuccess: (run) => props.onSelectRun(run.id, run.periodId) }); return; }
    if (!chosen.baselineId) return;
    mutation.mutate({ periodId: period.id, input: { baselineId: chosen.baselineId, knownEstimatesOnly: chosen.knownOnly, membershipIds: chosen.membershipIds } }, { onSuccess: (run) => props.onSelectRun(run.id, run.periodId) });
  };
  return (
    <section aria-label={t('planning.weeklyReport')} className="space-y-5">
      <div className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div><h2 className="text-lg font-semibold">{t('planning.planVsActual')}</h2><p className="mt-1 text-sm leading-relaxed text-muted">{t('planning.eachReportPreservesTheBaselineAndActualHourRevisions')}</p></div>
        {props.baselines.length === 0 && held === null ? <p className="text-sm text-muted">{t('planning.saveAPersonalOrProjectBaselineBeforeCalculatingA')}</p> : <form className="space-y-4" onSubmit={submit}>
          <fieldset disabled={held !== null} className="min-w-0 space-y-4">
            <div className="space-y-1.5"><label htmlFor={`${id}-baseline`} className="text-sm font-medium">{t('planning.savedBaseline')}</label><select id={`${id}-baseline`} className={inputClassName()} value={shown.baselineId} onChange={(event) => { const baseline = props.baselines.find((item) => item.id === event.target.value); setChosen({ baselineId: event.target.value, membershipIds: baseline?.scope === 'self' ? [] : chosen.membershipIds }); }}><option value="">{t('planning.chooseABaseline')}</option>{props.baselines.map((baseline) => <option key={baseline.id} value={baseline.id}>{baseline.scope === 'project' ? t('planning.projectPlan') : t('planning.personalPlan', { person: props.members.find((member) => member.id === baseline.membershipId)?.displayName ?? t('planning.person2') })} · {dateTime(baseline.frozenAt)}</option>)}{shown.baselineId && !props.baselines.some((baseline) => baseline.id === shown.baselineId) ? <option value={shown.baselineId}>{t('planning.submittedBaselineFromAnotherPeriod')}</option> : null}</select></div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={shown.knownEstimatesOnly} onChange={(event) => setChosen({ knownOnly: event.target.checked })} /><span>{t('planning.compareOnlyKnownPersonalPlans')}<span className="mt-1 block text-xs text-muted">{t('planning.thisFiltersTheComparisonItDoesNotMeasureCompleteness')}</span></span></label>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2"><legend className="mb-2 text-sm font-medium">{personalMember ? t('planning.peopleInThePersonalBaseline') : t('planning.peopleInReportLeaveEmptyToIncludeEveryoneAvailable')}</legend>{personalMember ? <p className="text-sm text-muted">{t('planning.onlyAPersonalBaselineDoesNotIncludeOtherPeoples', { person: props.members.find((member) => member.id === personalMember)?.displayName ?? t('planning.thePersonInThisPersonalBaseline') })}</p> : props.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shown.membershipIds.includes(member.id)} onChange={(event) => setChosen({ membershipIds: event.target.checked ? [...chosen.membershipIds, member.id] : chosen.membershipIds.filter((value) => value !== member.id) })} />{member.displayName}</label>)}</fieldset>
          </fieldset>
          <SaveFeedback subject="report" error={mutation.error} uncertainError={mutation.uncertain?.error ?? null} />
          <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || !shown.baselineId}>{mutation.pendingCommand ? t('planning.calculating') : mutation.uncertain ? t('planning.retryOriginalSave') : t('planning.calculateNewReport')}</Button>
        </form>}
        {props.runs.length > 0 ? <div className="space-y-1.5 border-t border-line pt-4"><label htmlFor={`${id}-run`} className="text-sm font-medium">{t('planning.savedReport')}</label><select id={`${id}-run`} className={inputClassName()} value={props.runId} onChange={(event) => props.onSelectRun(event.target.value, period.id)}><option value="">{t('planning.chooseAReport')}</option>{props.runs.map((run) => <option key={run.id} value={run.id}>{dateTime(run.createdAt)} · {run.knownEstimatesOnly ? t('planning.knownPlansOnly') : t('planning.allSelectedPeople')}</option>)}</select></div> : null}
      </div>
      {props.runId ? <PinnedReport actorId={props.actorId} workspaceId={props.workspaceId} projectId={period.projectId} periodId={period.id} runId={props.runId} /> : null}
    </section>
  );
}

function PinnedReport({ actorId, workspaceId, projectId, periodId, runId }: { actorId: string; workspaceId: string; projectId: string; periodId: string; runId: string }) {
  const { t } = useTranslation();
  const run = useReportRunQuery(actorId, workspaceId, runId);
  const rows = useReportRowsQuery(actorId, workspaceId, runId);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (run.isPending) return <p role="status" className="text-sm text-muted">{t('planning.loadingSavedReport')}</p>;
  if (run.isError) return <QueryErrorState error={run.error} subject="report" headingLevel={3} retrying={run.isFetching} onRetry={() => void run.refetch()} />;
  if (isAccessDenied(rows.error)) return <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} />;
  if (run.data.projectId !== projectId || run.data.periodId !== periodId) return <StateCard headingLevel={3} title={t('planning.thisReportBelongsToAnotherPeriod')} description={t('planning.chooseASavedReportForTheCurrentWeek')} />;
  const report = run.data;
  const originalPeople = report.byPerson.filter((person) => person.summary.baselineCompleteness.totalItemCount > 0);
  return (
    <div className="space-y-5">
      <section aria-label={t('planning.savedReport')} className="space-y-3 rounded-xl border border-line bg-canvas p-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{t('planning.savedReport')}</h3><Badge tone="muted">{t('planning.versionsPreserved')}</Badge>{report.knownEstimatesOnly ? <Badge tone="muted">{t('planning.knownPlansOnly2')}</Badge> : null}</div>
        <p className="text-xs leading-relaxed text-muted">{t('planning.calculatedActualHoursIncludedThroughLaterCorrectionsAppearIn', { createdAt: dateTime(report.createdAt), factCutoffAt: dateTime(report.factCutoffAt) })}</p>
        <p className="text-xs text-muted">{t('planning.baselineRowsSelectedOfDataCoversTheAvailablePeople', { selectedItemCount: report.cohort.selectedItemCount, originalItemCount: report.cohort.originalItemCount })}</p>
        <Summary summary={report.summary} />
      </section>
      <PlanFactChart title={t('planning.baselineVsActualByPerson')} items={originalPeople.map((person) => ({ id: person.membershipId, label: `${person.memberName}${!person.summary.baselineCompleteness.complete || !person.summary.factCoverage.complete ? t('planning.incompleteData') : ''}`, planMinutes: person.summary.baselineCompleteness.knownItemCount === 0 ? null : person.summary.knownPlannedMinutes, factMinutes: person.summary.factCoverage.recordedItemCount === 0 ? null : person.summary.actualMinutes }))} />
      {originalPeople.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{t('planning.theBaselineHasNoPersonalCommitmentsToCompareAdded')}</p> : null}
      <p className="text-xs leading-relaxed text-muted">{t('planning.barsUseServerTotalsForTheOriginalBaselineIncomplete')}</p>
      {rows.isPending ? <p role="status" className="text-sm text-muted">{t('planning.loadingReportDetails')}</p> : rows.isError && !rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} /> : <>
        <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">{t('planning.savedPlannedAndActualHours')}</caption><thead className="border-b border-line bg-canvas text-xs text-muted"><tr><th className="px-4 py-3">{t('planning.workAndPerson')}</th><th className="px-3 py-3">{t('planning.personalPlan2')}</th><th className="px-3 py-3">{t('planning.actual')}</th><th className="px-3 py-3">{t('planning.difference')}</th><th className="px-3 py-3">{t('planning.calculationDetails')}</th></tr></thead><tbody>{rows.data?.pages.flatMap((page) => page.items).map((row) => <ReportRow key={`${runId}:${row.id}`} actorId={actorId} workspaceId={workspaceId} projectId={projectId} periodId={periodId} row={row} expanded={expanded === row.id} onExpand={() => setExpanded((before) => before === row.id ? null : row.id)} />)}</tbody></table>
          {report.rowCount === 0 ? <p className="p-4 text-sm text-muted">{t('planning.noRowsToCompareForTheseSelections')}</p> : null}
        </div>
        <p className="text-xs text-muted">{t('planning.totalsAboveComeFromTheCompleteServerCalculationRegardless')}</p>
        {rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetchingNextPage} onRetry={() => void rows.fetchNextPage()} /> : null}
        {rows.hasNextPage ? <Button disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>{t('planning.loadMoreReportRows')}</Button> : null}
      </>}
    </div>
  );
}

function Summary({ summary }: { summary: WeeklyPlanFactSummaryDto }) {
  const { t } = useTranslation();
  return <>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3"><Metric label={t('planning.knownPlannedHours')} value={formatEstimate(summary.knownPlannedMinutes)} hint={t('planning.knownOf', { knownItemCount: summary.baselineCompleteness.knownItemCount, totalItemCount: summary.baselineCompleteness.totalItemCount })} /><Metric label={t('planning.actualHoursForBaselineWork')} value={formatEstimate(summary.actualMinutes)} hint={t('planning.recordedOf', { recordedItemCount: summary.factCoverage.recordedItemCount, totalItemCount: summary.factCoverage.totalItemCount })} /><Metric label={t('planning.baselineDifference')} value={summary.totalVarianceMinutes === null ? t('planning.insufficientData') : signedMinutes(summary.totalVarianceMinutes)} hint={summary.totalVariancePercent === null ? t('planning.percentageUnavailableForIncompleteDataOrAZeroPlan') : formatNumber(summary.totalVariancePercent / 100, { style: 'percent', maximumFractionDigits: 1 })} /></dl>
    <p className="text-xs leading-relaxed text-muted">{t('planning.addedWorkUnplannedWorkAllRecordedHoursAMissing', { addedActualMinutes: formatEstimate(summary.addedActualMinutes), unplannedActualMinutes: formatEstimate(summary.unplannedActualMinutes), totalActualMinutes: formatEstimate(summary.totalActualMinutes) })}</p>
  </>;
}
function Metric({ label, value, hint }: { label: string; value: string; hint: string }) { return <div className="rounded-lg border border-line bg-surface p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-lg font-semibold [overflow-wrap:anywhere] text-ink">{value}</dd><p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p></div>; }
function ReportRow({ actorId, workspaceId, projectId, periodId, row, expanded, onExpand }: { actorId: string; workspaceId: string; projectId: string; periodId: string; row: WeeklyPlanFactRowDto; expanded: boolean; onExpand: () => void }) {
  const { t } = useTranslation();
  return <><tr className="border-b border-line"><td className="max-w-xs px-4 py-3"><p className="mb-1 text-xs text-muted">{t('planning.savedReportTitle')}</p><p className="font-medium [overflow-wrap:anywhere]">{row.title}</p><p className="mt-1 text-xs text-muted">{row.memberName} · {row.scope === 'original' ? t('planning.baselineWork') : row.scope === 'added_scope' ? t('planning.addedWork3') : t('planning.unplannedWork2')}</p><ReportTaskLinks actorId={actorId} workspaceId={workspaceId} projectId={projectId} periodId={periodId} membershipId={row.membershipId} taskIds={row.taskIds} /></td><td className="px-3 py-3 tabular-nums">{row.plannedMinutes === null ? t('planning.notSet2') : formatEstimate(row.plannedMinutes)}</td><td className="px-3 py-3 tabular-nums">{row.factRecorded ? formatEstimate(row.actualMinutes) : t('planning.notRecorded')}</td><td className="px-3 py-3 tabular-nums">{row.varianceMinutes === null ? '—' : signedMinutes(row.varianceMinutes)}</td><td className="px-3 py-3"><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onExpand}>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{t('planning.viewCalculation')}</Button></td></tr>{expanded ? <tr className="border-b border-line bg-canvas"><td colSpan={5} className="space-y-2 px-4 py-4"><p className="text-xs text-muted">{t('planning.originalSharedTaskEstimatePersonalWeeklyPlansAreCompared', { hours: row.packageEstimateMinutes === null ? t('planning.unknown') : formatEstimate(row.packageEstimateMinutes) })}</p>{row.workLogs.length === 0 ? <p className="text-sm text-muted">{t('planning.thisSavedReportHasNoTimeEntriesForThis')}</p> : <ul className="space-y-2">{row.workLogs.map((log) => <li key={log.revisionId} className="text-sm"><Badge tone="muted"><RecordedWorkLabel log={log}/></Badge> {formatEstimate(log.minutes)} {t('planning.revision')}{log.revision}{log.state === 'void' ? t('planning.voided') : ''}<span className="block text-xs text-muted">{dateTime(log.recordedAt)}{log.reason ? ` · ${log.reason}` : ''}</span></li>)}</ul>}</td></tr> : null}</>;
}
function signedMinutes(minutes: number): string { return `${minutes > 0 ? '+' : minutes < 0 ? '−' : ''}${formatEstimate(Math.abs(minutes))}`; }
export function dateTime(value: string): string { return formatDate(new Date(value), { dateStyle: 'short', timeStyle: 'short' }); }
