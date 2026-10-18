import { t, useTranslation, formatDate } from '../../i18n';
import { RecordedWorkLabel } from '../../shared/RecordedWorkLabel';
import type { CreateWeeklyPlanFactReportInput, MembershipDto, PlanBaselineDto, PlanningPeriodDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactRowDto, WeeklyPlanFactSummaryDto } from '@workloom/contracts';
import { Badge, Button, StateCard } from '@workloom/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { isAccessDenied } from '../../lib/api';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table';
import { CopyReportSummary } from './CopyReportSummary';
import { PlanFactChart } from './PlanFactChart';
import { ReportSnapshotHeader } from './ReportSnapshotHeader';
import { baselineActualText, hasBaselineWork, knownPlanText, matchedBaseline, savedPeopleScope, savedTime, signedMinutes, variancePercentText, varianceText, weeklyReportBrief, weeklyRunOptionLabel } from './reportSummary';
import { ReportTaskLinks } from './ReportTaskLinks';
import { WeeklyPeopleComparison } from './WeeklyPeopleComparison';
import { ReportSetupDisclosure } from './ReportSetupDisclosure';
import { weeklyReportConfigurationKey, type ReportDraft, type ReportDraftAction } from './reportSetupState';
import { useReportRowsQuery, useReportRunQuery, type PlanningCommands } from './queries';

export interface ReportSelection { baselineId: string; knownOnly: boolean; membershipIds: string[] }

interface Props {
  actorId: string;
  workspaceId: string;
  period: PlanningPeriodDto;
  /** Presentation context for the saved report identity and copied summary. */
  projectName?: string;
  baselines: readonly PlanBaselineDto[];
  runs: readonly WeeklyPlanFactReportRunDto[];
  members: readonly MembershipDto[];
  runId: string;
  draft: ReportDraft<ReportSelection> | undefined;
  onDraftAction: (action: ReportDraftAction<ReportSelection>) => void;
  mutation: PlanningCommands['createReport'];
  onSelectRun: (runId: string, periodId: string) => void;
  onCalculated: (runId: string, periodId: string, sourceRunId: string) => void;
  /** The latest-report fallback is read only while its view is shown; an explicit run is always shown. */
  active?: boolean;
}

export function WeeklyReport(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const { period, mutation } = props;
  const fallback = period.projectBaselineId ?? props.baselines.find((baseline) => baseline.scope === 'project')?.id ?? props.baselines[0]?.id ?? '';
  const chosen = props.draft?.selection ?? { baselineId: fallback, knownOnly: false, membershipIds: [] };
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const shown = held?.input ?? { baselineId: chosen.baselineId, knownEstimatesOnly: chosen.knownOnly, membershipIds: chosen.membershipIds };
  const selectedBaseline = props.baselines.find((baseline) => baseline.id === shown.baselineId);
  const personalMember = selectedBaseline?.scope === 'self' ? selectedBaseline.membershipId : null;
  const setChosen = (update: Partial<ReportSelection>) => {
    const selection = { ...chosen, ...update };
    props.onDraftAction({ type: 'edit', periodId: period.id, selection, configurationKey: weeklyReportConfigurationKey({ baselineId: selection.baselineId, knownEstimatesOnly: selection.knownOnly, membershipIds: selection.membershipIds }) });
  };
  const setupError = mutation.error !== null && mutation.variables?.periodId === period.id ? mutation.error : null;
  const projectBaseline = props.baselines.find((baseline) => baseline.scope === 'project' && baseline.id === period.projectBaselineId) ?? props.baselines.find((baseline) => baseline.scope === 'project') ?? null;
  // Display-only fallback: never written to the URL, so the completion guard and an explicit choice keep priority.
  // A held calculation hides it, so Resume never brings back an old run while the original request is unresolved.
  const latestRun = projectBaseline && held === null && props.active !== false ? newestRun(props.runs.filter((run) => run.periodId === period.id && run.baselineId === projectBaseline.id)) : null;
  const shownRunId = props.runId || latestRun?.id || '';
  const send = (submittedPeriodId: string, input: CreateWeeklyPlanFactReportInput) => {
    const configurationKey = weeklyReportConfigurationKey(input);
    props.onDraftAction({ type: 'submitted', periodId: submittedPeriodId, configurationKey });
    const saved = (run: WeeklyPlanFactReportRunDto) => {
      props.onDraftAction({ type: 'confirmed', periodId: submittedPeriodId, configurationKey });
      props.onCalculated(run.id, run.periodId, props.runId);
    };
    if (mutation.uncertain) { mutation.retryUncertain({ onSuccess: saved }); return; }
    mutation.mutate({ periodId: submittedPeriodId, input }, { onSuccess: saved });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.pendingCommand) return;
    const input = held?.input ?? { baselineId: chosen.baselineId, knownEstimatesOnly: chosen.knownOnly, membershipIds: chosen.membershipIds };
    if (!input.baselineId) return;
    send(held?.periodId ?? period.id, input);
  };
  // The same immutable report command with the project baseline and everyone; an unresolved request is retried only from setup.
  const calculateCurrent = () => {
    if (held !== null || !projectBaseline) return;
    send(period.id, { baselineId: projectBaseline.id, knownEstimatesOnly: false, membershipIds: [] });
  };
  const scopeLabel = (baselineId: string) => {
    const baseline = props.baselines.find((item) => item.id === baselineId);
    if (!baseline) return t('planning.savedBaseline');
    if (baseline.scope === 'project') return t('planning.projectPlan');
    // A saved baseline names its person as captured in its own snapshot, never by a current membership name.
    const captured = baseline.membershipId ? baseline.snapshot.memberships.find((member) => member.id.toLowerCase() === baseline.membershipId?.toLowerCase())?.displayName : undefined;
    return t('planning.personalPlan', { person: captured ?? t('planning.person2') });
  };
  const runOptions = [{ value: '', label: latestRun ? t('planning.latestProjectReport') : t('planning.chooseAReport') }, ...props.runs.map(run => ({ value: run.id, label: weeklyRunOptionLabel(run, period, scopeLabel(run.baselineId)) })), ...(props.runId && !props.runs.some(run => run.id === props.runId) ? [{ value: props.runId, label: t('planning.savedReport') }] : [])];
  const runSelector = props.runs.length > 0 ? <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto"><label htmlFor={`${id}-run`} className="shrink-0 text-xs font-medium">{t('planning.savedReport')}</label><ChoicePicker compact id={`${id}-run`} label={t('planning.savedReport')} className="w-full text-xs sm:w-80" value={props.runId} options={runOptions} onValueChange={value => props.onSelectRun(value, period.id)} /></div> : null;
  const currentAction = projectBaseline ? <><Button variant="primary" size="sm" aria-describedby={`${id}-current`} title={t('planning.calculateCurrentReportHint')} disabled={held !== null} onClick={calculateCurrent}>{t('planning.calculateCurrentReport')}</Button><span id={`${id}-current`} className="sr-only">{t('planning.calculateCurrentReportHint')}</span></> : null;
  return (
    <section aria-label={t('planning.weeklyReport')} className="space-y-5">
      <ReportSetupDisclosure title={t('planning.planVsActual')} hasSavedReport={!!shownRunId} setup={props.draft?.setup} held={held !== null} failed={setupError !== null} onExpandedChange={expanded => props.onDraftAction({ type: 'expand', periodId: period.id, expanded })} selector={runSelector || currentAction ? <>{runSelector}{currentAction}</> : null}>
        <p className="text-xs leading-relaxed text-muted">{t('planning.eachReportPreservesTheBaselineAndActualHourRevisions')}</p>
        {props.baselines.length === 0 && held === null ? <p className="text-sm text-muted">{t('planning.saveAPersonalOrProjectBaselineBeforeCalculatingA')}</p> : <form className="space-y-4" onSubmit={submit}>
          <fieldset disabled={held !== null} className="min-w-0 space-y-4">
            <div className="space-y-1.5"><label htmlFor={`${id}-baseline`} className="text-sm font-medium">{t('planning.savedBaseline')}</label><ChoicePicker id={`${id}-baseline`} label={t('planning.savedBaseline')} value={shown.baselineId} options={[{ value: '', label: t('planning.chooseABaseline') }, ...props.baselines.map(baseline => ({ value: baseline.id, label: `${scopeLabel(baseline.id)} · ${dateTime(baseline.frozenAt, period.timezone)}` })), ...(shown.baselineId && !props.baselines.some(baseline => baseline.id === shown.baselineId) ? [{ value: shown.baselineId, label: t('planning.submittedBaselineFromAnotherPeriod') }] : [])]} onValueChange={value => { const baseline = props.baselines.find(item => item.id === value); setChosen({ baselineId: value, membershipIds: baseline?.scope === 'self' ? [] : chosen.membershipIds }); }} /></div>
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={shown.knownEstimatesOnly} onChange={(event) => setChosen({ knownOnly: event.target.checked })} /><span>{t('planning.compareOnlyKnownPersonalPlans')}<span className="mt-1 block text-xs text-muted">{t('planning.thisFiltersTheComparisonItDoesNotMeasureCompleteness')}</span></span></label>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2"><legend className="mb-2 text-sm font-medium">{personalMember ? t('planning.peopleInThePersonalBaseline') : t('planning.peopleInReportLeaveEmptyToIncludeEveryoneAvailable')}</legend>{personalMember ? <p className="text-sm text-muted">{t('planning.onlyAPersonalBaselineDoesNotIncludeOtherPeoples', { person: props.members.find((member) => member.id === personalMember)?.displayName ?? t('planning.thePersonInThisPersonalBaseline') })}</p> : props.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shown.membershipIds.includes(member.id)} onChange={(event) => setChosen({ membershipIds: event.target.checked ? [...chosen.membershipIds, member.id] : chosen.membershipIds.filter((value) => value !== member.id) })} />{member.displayName}</label>)}</fieldset>
          </fieldset>
          <SaveFeedback subject="report" error={setupError} uncertainError={mutation.uncertain?.error ?? null} />
          <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null || !shown.baselineId}>{mutation.pendingCommand ? t('planning.calculating') : mutation.uncertain ? t('planning.retryOriginalSave') : t('planning.calculateNewReport')}</Button>
        </form>}
      </ReportSetupDisclosure>
      {shownRunId ? <PinnedReport key={shownRunId} actorId={props.actorId} workspaceId={props.workspaceId} period={period} projectName={props.projectName} baselines={props.baselines} runId={shownRunId} latest={!props.runId} scopeLabel={scopeLabel} /> : null}
    </section>
  );
}

function newestRun(runs: readonly WeeklyPlanFactReportRunDto[]): WeeklyPlanFactReportRunDto | null {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0] ?? null;
}

interface PinnedReportProps {
  actorId: string;
  workspaceId: string;
  period: PlanningPeriodDto;
  projectName: string | undefined;
  baselines: readonly PlanBaselineDto[];
  runId: string;
  latest: boolean;
  scopeLabel: (baselineId: string) => string;
}

function PinnedReport({ actorId, workspaceId, period, projectName, baselines, runId, latest, scopeLabel }: PinnedReportProps) {
  const { t } = useTranslation();
  const projectId = period.projectId;
  const periodId = period.id;
  const run = useReportRunQuery(actorId, workspaceId, runId);
  const rows = useReportRowsQuery(actorId, workspaceId, runId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [missingOnly, setMissingOnly] = useState(false);
  if (run.isPending) return <p role="status" className="text-sm text-muted">{t('planning.loadingSavedReport')}</p>;
  if (run.isError) return <QueryErrorState error={run.error} subject="report" headingLevel={3} retrying={run.isFetching} onRetry={() => void run.refetch()} />;
  if (isAccessDenied(rows.error)) return <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} />;
  if (run.data.projectId !== projectId || run.data.periodId !== periodId) return <StateCard headingLevel={3} title={t('planning.thisReportBelongsToAnotherPeriod')} description={t('planning.chooseASavedReportForTheCurrentWeek')} />;
  const report = run.data;
  const originalPeople = report.byPerson.filter((person) => person.summary.baselineCompleteness.totalItemCount > 0);
  // Saved times use the period's named zone, matching the work-type breakdown.
  const asOf = savedTime(report.factCutoffAt, period);
  const scope = scopeLabel(report.baselineId);
  const baseline = matchedBaseline(report, baselines.find((item) => item.id.toLowerCase() === report.baselineId.toLowerCase()));
  // Server coverage counts of the pinned run; a missing entry is never counted as zero hours.
  const missingCount = Math.max(0, report.summary.factCoverage.totalItemCount - report.summary.factCoverage.recordedItemCount);
  const missingPeople = report.byPerson.flatMap((person) => { const missing = Math.max(0, person.summary.factCoverage.totalItemCount - person.summary.factCoverage.recordedItemCount); return missing > 0 ? [{ id: person.membershipId, name: person.memberName, missing }] : []; });
  const loadedRows = rows.data?.pages.flatMap((page) => page.items) ?? [];
  const shownRows = missingOnly ? loadedRows.filter((row) => !row.factRecorded) : loadedRows;
  return (
    <div className="space-y-5">
      <section aria-label={t('planning.savedReport')} className="space-y-3 rounded-xl border border-line bg-canvas p-3 sm:p-4">
        {/* Saved-result identity first: as-of cutoff, baseline scope and the known-only subset are always visible. */}
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{t('planning.savedReport')}</h3><Badge tone="muted">{t('planning.reportAsOf', { time: asOf })}</Badge><Badge tone="muted">{scope}</Badge>{report.knownEstimatesOnly ? <Badge tone="warning">{t('planning.knownPlansOnly2')}</Badge> : null}{latest ? <Badge tone="muted">{t('planning.latestProjectReport')}</Badge> : null}</div>
        <ReportSnapshotHeader projectName={projectName} period={period} createdAt={report.createdAt} factCutoffAt={report.factCutoffAt} people={savedPeopleScope(report)} knownOnly={report.knownEstimatesOnly} baselineFrozenAt={baseline?.frozenAt ?? null} />
        <CopyReportSummary key={report.id} brief={() => weeklyReportBrief({ projectName, period, report, scopeLabel: scope, baseline })} />
        <Summary summary={report.summary} />
        <p className="text-xs text-muted">{t('planning.baselineRowsSelectedOfDataCoversTheAvailablePeople', { selectedItemCount: report.cohort.selectedItemCount, originalItemCount: report.cohort.originalItemCount })}</p>
        <details className="text-xs text-muted"><summary className="w-fit cursor-pointer font-medium text-accent-ink">{t('planning.aboutSavedReport')}</summary><div className="space-y-1.5 pt-2 leading-relaxed">
          <p className="font-medium text-ink-soft">{latest ? t('planning.latestReportStatus') : t('planning.chosenReportStatus')}</p>
          <p>{t('planning.calculatedActualHoursIncludedThroughLaterCorrectionsAppearIn', { createdAt: savedTime(report.createdAt, period), factCutoffAt: asOf })}</p>
          <p>{t('planning.versionsPreservedHelp')}</p>
          <p>{t('planning.barsUseServerTotalsForTheOriginalBaselineIncomplete')}</p>
          <p>{t('planning.totalsAboveComeFromTheCompleteServerCalculationRegardless')}</p>
        </div></details>
      </section>
      <PlanFactChart title={t('planning.baselineVsActualByPerson')} items={originalPeople.map((person) => ({ id: person.membershipId, label: `${person.memberName}${!person.summary.baselineCompleteness.complete || !person.summary.factCoverage.complete ? t('planning.incompleteData') : ''}`, planMinutes: person.summary.baselineCompleteness.knownItemCount === 0 ? null : person.summary.knownPlannedMinutes, factMinutes: person.summary.factCoverage.recordedItemCount === 0 ? null : person.summary.actualMinutes }))} />
      {/* Always visible next to the chart: the bars are the original-baseline known/recorded parts only, never totals. */}
      {originalPeople.length > 0 ? <p className="-mt-3 text-xs leading-relaxed text-muted">{t('reportUX.chartCaption')}</p> : null}
      {originalPeople.length === 0 ? <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{t('planning.theBaselineHasNoPersonalCommitmentsToCompareAdded')}</p> : null}
      <WeeklyPeopleComparison people={report.byPerson} />
      <section aria-label={t('planning.missingActuals.title')} className="space-y-2 rounded-xl border border-line bg-surface p-3 text-sm">
        <h3 className="text-sm font-semibold">{t('planning.missingActuals.title')}</h3>
        <p className="text-xs text-muted">{report.summary.factCoverage.totalItemCount === 0 ? t('reportUX.value.noBaselineWork') : missingCount === 0 ? t('planning.missingActuals.none', { time: asOf }) : t('planning.missingActuals.count', { time: asOf, missing: missingCount, total: report.summary.factCoverage.totalItemCount })}</p>
        {missingPeople.length ? <ul aria-label={t('planning.missingActuals.byPerson')} className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{missingPeople.map((person) => <li key={person.id}>{t('planning.missingActuals.person', { person: person.name, missing: person.missing })}</li>)}</ul> : null}
        {missingCount > 0 ? <label className="flex items-center gap-2 text-xs font-medium"><input type="checkbox" checked={missingOnly} onChange={(event) => setMissingOnly(event.target.checked)} />{t('planning.missingActuals.filter')}</label> : null}
        {missingOnly ? <p className="text-xs text-muted">{rows.hasNextPage ? t('planning.missingActuals.loadedOnlyMore') : t('planning.missingActuals.loadedOnly')}</p> : null}
      </section>
      {rows.isPending ? <p role="status" className="text-sm text-muted">{t('planning.loadingReportDetails')}</p> : rows.isError && !rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} /> : <>
        <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">{t('planning.savedPlannedAndActualHours')}</caption><thead className="border-b border-line bg-canvas text-xs text-muted"><tr><th className="px-4 py-3">{t('planning.workAndPerson')}</th><th className="px-3 py-3">{t('planning.personalPlan2')}</th><th className="px-3 py-3">{t('planning.actual')}</th><th className="px-3 py-3">{t('planning.difference')}</th><th className="px-3 py-3">{t('planning.calculationDetails')}</th></tr></thead><tbody>{shownRows.map((row) => <ReportRow key={`${runId}:${row.id}`} actorId={actorId} workspaceId={workspaceId} projectId={projectId} periodId={periodId} timezone={period.timezone} row={row} expanded={expanded === row.id} onExpand={() => setExpanded((before) => before === row.id ? null : row.id)} />)}</tbody></table>
          {report.rowCount === 0 ? <p className="p-4 text-sm text-muted">{t('planning.noRowsToCompareForTheseSelections')}</p> : missingOnly && shownRows.length === 0 ? <p className="p-4 text-sm text-muted">{t('planning.missingActuals.noneLoaded')}</p> : null}
        </div>
        {rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="report" headingLevel={3} retrying={rows.isFetchingNextPage} onRetry={() => void rows.fetchNextPage()} /> : null}
        {rows.hasNextPage ? <Button disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>{t('planning.loadMoreReportRows')}</Button> : null}
      </>}
    </div>
  );
}

/** Every value is a direct server field of the saved summary; nothing is summed from people or loaded rows. */
function Summary({ summary }: { summary: WeeklyPlanFactSummaryDto }) {
  const { t } = useTranslation();
  // Zero known/recorded items is missing data, not a confirmed 0m; a partial count covers only the known/recorded part.
  const { knownItemCount, totalItemCount: planItems } = summary.baselineCompleteness;
  const { recordedItemCount, totalItemCount: factItems } = summary.factCoverage;
  const planNote = planItems === 0 ? undefined : knownItemCount === 0 ? t('reportUX.summary.planNotKnown') : knownItemCount < planItems ? t('reportUX.summary.planPartial') : undefined;
  const actualNote = factItems === 0 ? undefined : recordedItemCount === 0 ? t('reportUX.summary.actualNotRecorded') : recordedItemCount < factItems ? t('reportUX.summary.actualPartial') : undefined;
  const baselineWork = hasBaselineWork(summary);
  return <>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Metric label={t('planning.knownPlannedHours')} value={knownPlanText(summary)} hint={t('planning.knownOf', { knownItemCount, totalItemCount: planItems })} note={planNote} />
      <Metric label={t('planning.actualHoursForBaselineWork')} value={baselineActualText(summary)} hint={t('planning.recordedOf', { recordedItemCount, totalItemCount: factItems })} note={actualNote} />
      <Metric label={t('planning.baselineDifference')} value={varianceText(summary)} hint={!baselineWork ? t('reportUX.summary.noBaselineWork') : summary.totalVariancePercent === null ? t('planning.percentageUnavailableForIncompleteDataOrAZeroPlan') : variancePercentText(summary)} />
    </dl>
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Metric label={t('reportUX.summary.added')} value={formatEstimate(summary.addedActualMinutes)} hint={t('reportUX.summary.addedHint')} />
      <Metric label={t('reportUX.summary.unplanned')} value={formatEstimate(summary.unplannedActualMinutes)} hint={t('reportUX.summary.unplannedHint')} />
      <Metric label={t('reportUX.summary.total')} value={formatEstimate(summary.totalActualMinutes)} hint={t('reportUX.summary.totalHint')} />
    </dl>
    <p className="text-xs leading-relaxed text-muted">{t('reportUX.summary.disjoint')}</p>
  </>;
}
function Metric({ label, value, hint, note }: { label: string; value: string; hint: string; note?: string }) {
  return <div className="rounded-lg border border-line bg-surface p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-lg font-semibold [overflow-wrap:anywhere] text-ink">{value}</dd><p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>{note ? <p className="mt-1 text-xs leading-relaxed text-muted">{note}</p> : null}</div>;
}
/** Why a saved row has no difference; never a bare dash. */
function rowVarianceReason(row: WeeklyPlanFactRowDto): string {
  if (row.scope !== 'original') return t('reportUX.row.varianceNotBaseline');
  if (row.plannedMinutes === null) return t('reportUX.row.varianceMissingPlan');
  if (!row.factRecorded) return t('reportUX.row.varianceMissingActual');
  return t('reportUX.row.varianceInsufficient');
}
function ReportRow({ actorId, workspaceId, projectId, periodId, timezone, row, expanded, onExpand }: { actorId: string; workspaceId: string; projectId: string; periodId: string; timezone: string; row: WeeklyPlanFactRowDto; expanded: boolean; onExpand: () => void }) {
  const { t } = useTranslation();
  return <><tr className="border-b border-line"><td className="max-w-xs px-4 py-3"><p className="mb-1 text-xs text-muted">{t('planning.savedReportTitle')}</p><p className="font-medium [overflow-wrap:anywhere]">{row.title}</p><p className="mt-1 text-xs text-muted">{row.memberName} · {row.scope === 'original' ? t('planning.baselineWork') : row.scope === 'added_scope' ? t('planning.addedWork3') : t('planning.unplannedWork2')}</p><ReportTaskLinks actorId={actorId} workspaceId={workspaceId} projectId={projectId} periodId={periodId} membershipId={row.membershipId} taskIds={row.taskIds} /></td><td className="px-3 py-3 tabular-nums">{row.plannedMinutes === null ? t('planning.notSet2') : formatEstimate(row.plannedMinutes)}</td><td className="px-3 py-3 tabular-nums">{row.factRecorded ? formatEstimate(row.actualMinutes) : t('planning.notRecorded')}</td><td className="px-3 py-3 tabular-nums">{row.varianceMinutes === null ? <span className="text-xs text-muted">{rowVarianceReason(row)}</span> : signedMinutes(row.varianceMinutes)}</td><td className="px-3 py-3"><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={onExpand}>{expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{t('planning.viewCalculation')}</Button></td></tr>{expanded ? <tr className="border-b border-line bg-canvas"><td colSpan={5} className="space-y-2 px-4 py-4"><p className="text-xs text-muted">{t('planning.originalSharedTaskEstimatePersonalWeeklyPlansAreCompared', { hours: row.packageEstimateMinutes === null ? t('planning.unknown') : formatEstimate(row.packageEstimateMinutes) })}</p>{row.workLogs.length === 0 ? <p className="text-sm text-muted">{t('planning.thisSavedReportHasNoTimeEntriesForThis')}</p> : <ul className="space-y-2">{row.workLogs.map((log) => <li key={log.revisionId} className="text-sm"><Badge tone="muted"><RecordedWorkLabel log={log}/></Badge> {formatEstimate(log.minutes)} {t('planning.revision')}{log.revision}{log.state === 'void' ? t('planning.voided') : ''}<span className="block text-xs text-muted">{dateTime(log.recordedAt, timezone)}{log.reason ? ` · ${log.reason}` : ''}</span></li>)}</ul>}</td></tr> : null}</>;
}
/** Backward compatible: without a zone it keeps the viewer's zone; saved report times pass the period zone. */
export function dateTime(value: string, timeZone?: string): string { return formatDate(new Date(value), { dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }); }
