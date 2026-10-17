import { t, useTranslation, formatNumber } from '../../i18n';
import { RecordedWorkLabel } from '../../shared/RecordedWorkLabel';
import { ReportTaskLinks } from '../planning/ReportTaskLinks';
import { ReportSetupDisclosure } from '../planning/ReportSetupDisclosure';
import { workTypeReportConfigurationKey, type ReportDraft, type ReportDraftAction } from '../planning/reportSetupState';
import type { CreateWorkTypeReportRunInput, MembershipDto, PlanningPeriodDto, WorkTypeBucketDto, WorkTypeReportRunDto } from '@workloom/contracts';
import { Badge, Button, StateCard } from '@workloom/ui';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { isAccessDenied } from '../../lib/api';
import { ChoicePicker } from '../../shared/ChoicePicker';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { SaveFeedback } from '../../shared/SaveFeedback';
import { formatEstimate } from '../task-table';
import { formatPeriodCutoff } from '../planning';
import { CategoryBadge } from './CategoryBadge';
import { useWorkTypeReportQuery, useWorkTypeReportRowsQuery, useWorkTypeReportRunsQuery, type WorkCategoryCommands } from './queries';

export interface WorkTypeReportSelection { membershipIds: string[] }
interface Props {
  actorId: string;
  workspaceId: string;
  period: PlanningPeriodDto;
  members: readonly MembershipDto[];
  runId: string;
  draft: ReportDraft<WorkTypeReportSelection> | undefined;
  onDraftAction: (action: ReportDraftAction<WorkTypeReportSelection>) => void;
  mutation: WorkCategoryCommands['createReport'];
  onSelectRun: (runId: string, periodId: string) => void;
  onCalculated: (runId: string, periodId: string, sourceRunId: string) => void;
  /** The latest-breakdown fallback is read only while its view is shown; an explicit run is always shown. */
  active?: boolean;
}

/** Works before freeze. Its denominator is recorded work, including explicitly uncategorized sources. */
export function WorkTypeReport(props: Props) {
  const { t } = useTranslation();
  const id = useId();
  const runs = useWorkTypeReportRunsQuery(props.actorId, props.workspaceId, props.period.id);
  const { mutation } = props;
  const held = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables ?? null;
  const chosen = props.draft?.selection ?? { membershipIds: [] };
  const shown = held?.input.membershipIds ?? chosen.membershipIds;
  const setupError = mutation.error !== null && mutation.variables?.input.periodId === props.period.id ? mutation.error : null;
  // Display-only newest fallback, hidden while a calculation is unresolved; an explicit ?typeRun always wins.
  const latestRun = held === null && props.active !== false && runs.isSuccess ? newestRun(runs.data.filter(run => run.periodId === props.period.id)) : null;
  const shownRunId = props.runId || latestRun?.id || '';
  const send = (input: CreateWorkTypeReportRunInput) => {
    const configurationKey = workTypeReportConfigurationKey(input);
    props.onDraftAction({ type: 'submitted', periodId: input.periodId, configurationKey });
    const saved = (run: { id: string; periodId: string }) => {
      props.onDraftAction({ type: 'confirmed', periodId: input.periodId, configurationKey });
      props.onCalculated(run.id, run.periodId, props.runId);
    };
    if (mutation.uncertain) { mutation.retryUncertain({ onSuccess: saved }); return; }
    mutation.mutate({ input }, { onSuccess: saved });
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutation.pendingCommand) return;
    send(held?.input ?? { periodId: props.period.id, membershipIds: chosen.membershipIds });
  };
  const calculateCurrent = () => { if (held === null) send({ periodId: props.period.id, membershipIds: [] }); };
  if (isAccessDenied(runs.error)) return <QueryErrorState error={runs.error} subject="workTypeReport" headingLevel={2} retrying={runs.isFetching} onRetry={() => void runs.refetch()} />;
  const runOptions = runs.isSuccess ? [{ value: '', label: latestRun ? t('work-categories.latestBreakdown') : t('work-categories.chooseAReport') }, ...runs.data.map(run => ({ value: run.id, label: `${formatPeriodCutoff(run.createdAt, props.period.timezone)} · ${formatEstimate(run.totalActualMinutes)}` })), ...(props.runId && !runs.data.some(run => run.id === props.runId) ? [{ value: props.runId, label: t('work-categories.savedBreakdown') }] : [])] : [];
  const runSelector = runs.isError ? <QueryErrorState error={runs.error} subject="workTypeReport" headingLevel={3} retrying={runs.isFetching} onRetry={() => void runs.refetch()} /> : runs.isPending ? <p role="status" className="text-xs text-muted">{t('work-categories.loadingSavedBreakdowns')}</p> : runs.data.length > 0 ? <div className="flex min-w-0 basis-full items-center gap-2 sm:basis-auto"><label htmlFor={`${id}-run`} className="shrink-0 text-xs font-medium">{t('work-categories.savedBreakdown')}</label><ChoicePicker compact id={`${id}-run`} label={t('work-categories.savedBreakdown')} className="w-full text-xs sm:w-72" value={props.runId} options={runOptions} onValueChange={value => props.onSelectRun(value, props.period.id)} /></div> : null;
  const currentAction = <><Button variant="primary" size="sm" aria-describedby={`${id}-current`} title={t('work-categories.calculateCurrentBreakdownHint')} disabled={held !== null} onClick={calculateCurrent}>{t('work-categories.calculateCurrentBreakdown')}</Button><span id={`${id}-current`} className="sr-only">{t('work-categories.calculateCurrentBreakdownHint')}</span></>;
  return <section aria-label={t('work-categories.recordedHoursBreakdown')} className="space-y-5">
    <ReportSetupDisclosure title={t('work-categories.hoursByWorkType')} hasSavedReport={!!shownRunId} setup={props.draft?.setup} held={held !== null} failed={setupError !== null} onExpandedChange={expanded => props.onDraftAction({ type: 'expand', periodId: props.period.id, expanded })} selector={<>{runSelector}{currentAction}</>}>
      <p className="text-xs leading-relaxed text-muted">{t('work-categories.sharesOfRecordedHoursForTheSelectedWeekUncategorized')}</p>
      <form className="space-y-4" onSubmit={submit}>
        <fieldset disabled={held !== null} className="flex flex-wrap gap-x-4 gap-y-2"><legend className="mb-2 text-sm font-medium">{t('work-categories.peopleInBreakdownLeaveEmptyToIncludeEveryoneAvailable')}</legend>{props.members.map((member) => <label key={member.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shown.includes(member.id)} onChange={event => { const selection = { membershipIds: event.target.checked ? [...chosen.membershipIds, member.id] : chosen.membershipIds.filter(value => value !== member.id) }; props.onDraftAction({ type: 'edit', periodId: props.period.id, selection, configurationKey: workTypeReportConfigurationKey(selection) }); }} />{member.displayName}</label>)}</fieldset>
        {held && held.input.periodId !== props.period.id ? <p role="status" className="text-sm text-amber-800">{t('work-categories.showingASubmittedReportForAnotherWeekRetryingPreserves')}</p> : null}
        <SaveFeedback subject="workTypeReport" error={setupError} uncertainError={mutation.uncertain?.error ?? null} />
        <Button type="submit" variant="primary" disabled={mutation.pendingCommand !== null}>{mutation.pendingCommand ? t('work-categories.calculating') : mutation.uncertain ? t('work-categories.retryOriginalSave') : t('work-categories.calculateHoursBreakdown')}</Button>
      </form>
    </ReportSetupDisclosure>
    {shownRunId ? <PinnedWorkTypeReport key={shownRunId} actorId={props.actorId} workspaceId={props.workspaceId} period={props.period} runId={shownRunId} latest={!props.runId} /> : null}
  </section>;
}

function newestRun(runs: readonly WorkTypeReportRunDto[]): WorkTypeReportRunDto | null {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0] ?? null;
}

function PinnedWorkTypeReport({ actorId, workspaceId, period, runId, latest }: { actorId: string; workspaceId: string; period: PlanningPeriodDto; runId: string; latest: boolean }) {
  const { t } = useTranslation();
  const run = useWorkTypeReportQuery(actorId, workspaceId, runId);
  const rows = useWorkTypeReportRowsQuery(actorId, workspaceId, runId);
  if (run.isPending) return <p role="status" className="text-sm text-muted">{t('work-categories.loadingSavedBreakdown')}</p>;
  if (run.isError) return <QueryErrorState error={run.error} subject="workTypeReport" headingLevel={3} retrying={run.isFetching} onRetry={() => void run.refetch()} />;
  if (isAccessDenied(rows.error)) return <QueryErrorState error={rows.error} subject="workTypeReport" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} />;
  const report = run.data;
  if (report.projectId !== period.projectId || report.periodId !== period.id) return <StateCard headingLevel={3} title={t('work-categories.thisReportBelongsToAnotherWeek')} description={t('work-categories.chooseASavedBreakdownForTheCurrentPeriod')} />;
  return <div className="space-y-5">
    <section aria-label={t('work-categories.savedBreakdown')} className="space-y-3 rounded-xl border border-line bg-canvas p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{t('work-categories.savedBreakdown')}</h3><Badge tone="muted">{t('planning.reportAsOf', { time: formatPeriodCutoff(report.factCutoffAt, period.timezone) })}</Badge><Badge tone="muted">{t('work-categories.peopleInBreakdown', { count: report.membershipIds.length })}</Badge>{latest ? <Badge tone="muted">{t('work-categories.latestBreakdown')}</Badge> : null}</div>
      <p className="text-xs font-medium text-ink-soft">{t('work-categories.savedReportTotals')}</p>
      <dl className="grid gap-3 sm:grid-cols-3"><SummaryMetric label={t('work-categories.totalRecorded')} value={formatEstimate(report.totalActualMinutes)} /><SummaryMetric label={t('work-categories.categorized')} value={formatEstimate(report.categorizedMinutes)} /><SummaryMetric label={t('work-categories.uncategorized')} value={formatEstimate(report.uncategorizedMinutes)} /></dl>
      <p className="text-xs leading-relaxed text-muted">{t('work-categories.activeEntriesTheseAreRecordedHoursTheyDoNot', { activeSourceCount: report.activeSourceCount })}</p>
      <details className="text-xs text-muted"><summary className="w-fit cursor-pointer font-medium text-accent-ink">{t('planning.aboutSavedReport')}</summary><div className="space-y-1.5 pt-2 leading-relaxed">
        <p className="font-medium text-ink-soft">{latest ? t('work-categories.latestBreakdownStatus') : t('work-categories.pinnedBreakdownStatus')}</p>
        <p>{t('work-categories.calculatedActualHourRevisionsIncludedThroughLaterChangesTo', { createdAt: formatPeriodCutoff(report.createdAt, period.timezone), timezone: period.timezone, factCutoffAt: formatPeriodCutoff(report.factCutoffAt, period.timezone) })}</p>
        <p>{t('planning.versionsPreservedHelp')}</p>
      </div></details>
    </section>
    <SavedDistributionLens key={report.id} report={report} />
    {report.byPerson.length > 0 ? <section aria-label={t('work-categories.breakdownByPerson')} className="space-y-3"><h3 className="font-semibold">{t('work-categories.byPerson')}</h3>{report.byPerson.map((person) => <details key={person.membershipId} className="rounded-xl border border-line bg-surface p-4"><summary className="cursor-pointer text-sm font-medium">{t('work-categories.entries2', { memberName: person.memberName, totalActualMinutes: formatEstimate(person.totalActualMinutes), activeSourceCount: person.activeSourceCount })}</summary><p className="mt-2 text-xs text-muted">{t('work-categories.eachWorkTypesShareUsesThisPersonsRecordedHours')}</p><dl className="mt-3 space-y-2">{person.byCategory.map((bucket) => <div key={bucket.key} className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><dt className="[overflow-wrap:anywhere]">{bucketLabel(bucket)}</dt><dd className="tabular-nums text-muted">{formatEstimate(bucket.minutes)} · {percentage(bucket.sharePercent)}</dd></div>)}</dl>{person.activeSourceCount === 0 ? <p className="mt-2 text-xs text-muted">{t('work-categories.thisPersonHasNoActiveEntries')}</p> : null}</details>)}</section> : null}
    <section aria-label={t('work-categories.breakdownSources')} className="space-y-3"><h3 className="font-semibold">{t('work-categories.entriesIncludedInThisReport')}</h3><p className="text-xs text-muted">{t('work-categories.sourcesRemainReportWide')}</p><p className="text-xs text-muted">{t('work-categories.historicalNamesAndCategoriesArePreservedWithTheTime')}</p>
      {rows.isPending ? <p role="status" className="text-sm text-muted">{t('work-categories.loadingReportSources')}</p> : rows.isError && !rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="workTypeReport" headingLevel={3} retrying={rows.isFetching} onRetry={() => void rows.refetch()} /> : <>
        <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface"><table className="w-full min-w-[660px] text-left text-sm"><caption className="sr-only">{t('work-categories.historicalEntriesInHoursBreakdown')}</caption><thead className="border-b border-line bg-canvas text-xs text-muted"><tr><th className="px-4 py-3">{t('work-categories.taskAndPerson')}</th><th className="px-4 py-3">{t('work-categories.categoryForThisRevision')}</th><th className="px-4 py-3">{t('work-categories.hours')}</th><th className="px-4 py-3">{t('work-categories.state')}</th></tr></thead><tbody>{rows.data?.pages.flatMap((page) => page.items).map((row) => <tr key={row.id} className="border-b border-line last:border-0"><td className="max-w-xs px-4 py-3 [overflow-wrap:anywhere]"><p className="mb-1 text-xs text-muted">{t('work-categories.savedReportTitle')}</p><p className="font-medium">{row.taskTitle}</p><p className="mt-1 text-xs text-muted">{row.memberName} · <RecordedWorkLabel log={row.workLog}/> {t('work-categories.revision')}{row.workLog.revision}</p>{row.workLog.reason ? <p className="mt-1 text-xs text-muted">{row.workLog.reason}</p> : null}<ReportTaskLinks key={`${runId}:${row.id}`} actorId={actorId} workspaceId={workspaceId} projectId={period.projectId} periodId={period.id} membershipId={row.workLog.membershipId} taskIds={[row.workLog.taskId]} /></td><td className="px-4 py-3"><CategoryBadge category={row.workLog.category} /></td><td className="px-4 py-3 tabular-nums">{formatEstimate(row.workLog.minutes)}</td><td className="px-4 py-3 text-xs text-muted">{row.excluded ? t('work-categories.voidedExcludedFromShares') : t('work-categories.included')}</td></tr>)}</tbody></table></div>
        {report.rowCount === 0 ? <p className="text-sm text-muted">{t('work-categories.thisReportHasNoTimeEntries')}</p> : null}
        {rows.isFetchNextPageError ? <QueryErrorState error={rows.error} subject="workTypeReport" headingLevel={3} retrying={rows.isFetchingNextPage} onRetry={() => void rows.fetchNextPage()} /> : null}
        {rows.hasNextPage ? <Button disabled={rows.isFetchingNextPage} onClick={() => void rows.fetchNextPage()}>{t('work-categories.loadMoreSourceEntries')}</Button> : null}
      </>}
    </section>
  </div>;
}

/** A display lens over one immutable saved report; it never changes the report cohort. */
function SavedDistributionLens({ report }: { report: WorkTypeReportRunDto }) {
  const { t } = useTranslation();
  const id = useId();
  const [selection, setSelection] = useState({ membershipId: '', unavailable: false });
  const person = report.byPerson.find(entry => entry.membershipId === selection.membershipId);
  const missing = selection.membershipId !== '' && person === undefined;
  useEffect(() => {
    if (missing) setSelection({ membershipId: '', unavailable: true });
  }, [missing]);

  const scopeName = person?.memberName ?? t('work-categories.allSelectedPeople');
  const buckets = person?.byCategory ?? report.byCategory;
  const totalMinutes = person?.totalActualMinutes ?? report.totalActualMinutes;
  const activeSourceCount = person?.activeSourceCount ?? report.activeSourceCount;

  return (
    <section aria-label={t('work-categories.distributionHeading')} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">{t('work-categories.distributionHeading')}</h3>
        <label htmlFor={id} className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium">
          {t('work-categories.distributionFor')}
          <ChoicePicker compact id={id} label={t('work-categories.distributionFor')} className="w-64 max-w-full text-xs" value={person?.membershipId ?? ''} options={[{ value: '', label: t('work-categories.allSelectedPeople') }, ...report.byPerson.map(entry => ({ value: entry.membershipId, label: entry.memberName, avatarName: entry.memberName }))]} onValueChange={value => setSelection({ membershipId: value, unavailable: false })} />
        </label>
      </div>
      <p className="text-sm font-medium [overflow-wrap:anywhere]">{t('work-categories.distributionScope', { name: scopeName })}</p>
      <p className="text-xs text-muted">{t('work-categories.distributionDenominator', { hours: formatEstimate(totalMinutes), count: activeSourceCount })}</p>
      {missing || selection.unavailable ? <p role="status" className="text-xs text-muted">{t('work-categories.distributionPersonUnavailable')}</p> : null}
      {activeSourceCount === 0 ? <p className="text-xs text-muted">{t('work-categories.distributionNoActiveEntries')}</p> : totalMinutes === 0 ? <p className="text-xs text-muted">{t('work-categories.theTotalIs0PercentagesAreUndefinedEvenWhen')}</p> : null}
      <CategoryDistribution buckets={buckets} />
      <div className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full min-w-[420px] text-left text-sm">
          <caption className="px-4 py-3 text-left font-semibold">{t('work-categories.shareOfRecordedHours')}</caption>
          <thead className="border-y border-line bg-canvas text-xs text-muted"><tr><th className="px-4 py-3">{t('work-categories.workType')}</th><th className="px-4 py-3">{t('work-categories.hours')}</th><th className="px-4 py-3">{t('work-categories.share')}</th></tr></thead>
          <tbody>{buckets.map(bucket => <tr key={bucket.key} className="border-b border-line last:border-0"><td className="px-4 py-3 [overflow-wrap:anywhere]">{bucketLabel(bucket)}</td><td className="px-4 py-3 tabular-nums">{formatEstimate(bucket.minutes)}</td><td className="px-4 py-3 tabular-nums">{percentage(bucket.sharePercent)}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function CategoryDistribution({ buckets }: { buckets: readonly WorkTypeBucketDto[] }) {
  const { t } = useTranslation();
  const id = useId();
  if (buckets.length === 0) return <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{t('work-categories.distributionNoBuckets')}</p>;
  return (
    <figure aria-labelledby={id} className="space-y-4 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <figcaption id={id} className="text-sm font-semibold">{t('work-categories.shareOfRecordedHours')}</figcaption>
      {buckets.map(bucket => (
        <div key={bucket.key} className="space-y-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span className="min-w-0 font-medium [overflow-wrap:anywhere]">{bucketLabel(bucket)}</span><span className="shrink-0 tabular-nums text-muted">{formatEstimate(bucket.minutes)} · {percentage(bucket.sharePercent)}</span></div>
          <svg viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label={t('work-categories.distributionBarLabel', { category: bucketLabel(bucket), hours: formatEstimate(bucket.minutes), share: percentage(bucket.sharePercent) })} className="h-3 w-full">
            <rect width={100} height={12} rx={2} fill="#f1f5f9" />
            {bucket.sharePercent !== null ? <rect width={bucket.sharePercent} height={12} rx={2} fill={bucket.color && /^#[0-9a-f]{6}$/i.test(bucket.color) ? bucket.color : '#94a3b8'} /> : null}
          </svg>
        </div>
      ))}
    </figure>
  );
}
function SummaryMetric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border border-line bg-surface p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 text-lg font-semibold">{value}</dd></div>; }
function bucketLabel(bucket: WorkTypeBucketDto): string { return bucket.fieldId === null && bucket.optionId === null ? t('work-categories.uncategorized') : bucket.label; }
function percentage(value: number | null): string { return value === null ? t('work-categories.shareUndefined') : formatNumber(value / 100, { style: 'percent', maximumFractionDigits: 1 }); }
