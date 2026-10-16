import { CutoffPanel, CutoffRecovery, useCutoffWorkspace } from '../features/cutoff';
import { useTaskCommentsWorkspace, CommentCommandRecovery } from '../features/task-comments';
import { message, useTranslation, type TranslationMessage } from '../i18n';
import { EdgeDialog } from '../features/dependencies/EdgeDialog';
import { DependencyNotices } from '../features/dependencies/DependencyNotices';
import { useDependencyWorkspace } from '../features/dependencies/useDependencyWorkspace';
import { meetingTime } from '../features/meetings/time';
import { MeetingDrawer, MeetingCommandNotices } from '../features/meetings/MeetingDrawer';
import { useMeetingWorkspace } from '../features/meetings/useMeetingWorkspace';
import { useMeetingsQuery, useRecordedWorkQuery } from '../features/meetings/queries';
import { CreateMeetingDialog } from '../features/meetings/CreateMeetingDialog';
import { RecurrencePanel } from '../features/recurrence/RecurrencePanel';
import { recurrenceKeys } from '../features/recurrence/queries';
import { useRecurrenceWorkspace } from '../features/recurrence/useRecurrenceWorkspace';
import { useQueryClient } from '@tanstack/react-query';
import { useSectionsQuery, useStatusesQuery } from '../features/projects/queries';
import { RecordedWorkLabel } from '../shared/RecordedWorkLabel';
import type { PeriodCommitmentDto, ProjectDto, WorkspaceDto } from '@workloom/contracts';
import { Button, Skeleton, StateCard, inputClassName } from '@workloom/ui';
import { ArrowLeft, CalendarDays, Lock, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useCurrentSearchParams } from '../lib/useCurrentSearchParams';
import { useTaskFieldsQuery } from '../features/fields';
import { CommitmentDialog, commitmentSession, type CommitmentSession } from '../features/planning/CommitmentDialog';
import { FactDialog, factSession, type FactSession } from '../features/planning/FactDialog';
import { FreezeDialog, type FreezeRequest } from '../features/planning/FreezeDialog';
import { PeriodDialog } from '../features/planning/PeriodDialog';
import { PersonalPlanList } from '../features/planning/PersonalPlanList';
import { WeeklyReport, type ReportSelection } from '../features/planning/WeeklyReport';
import { updateReportDraft, type ReportDraft } from '../features/planning/reportSetupState';
import {
  usePlanningCommands, usePlanningPeriodsQuery, usePlanningPackagesQuery, usePlanningPeriodQuery,
  usePeriodCommitmentsQuery, usePlanBaselinesQuery, useReportRunsQuery,
} from '../features/planning/queries';
import { fetchPeriodCommitments, fetchPeriodWorkLogs } from '../features/planning/api';
import { projectTimeHref } from '../features/planning/navigation';
import { selectPlanningPeriodId, sortPlanningPeriods } from '../features/planning/periodSelection';
import { WorkTypeReport, useWorkCategoryCommands, type WorkTypeReportSelection } from '../features/work-categories';
import { useProjectQuery } from '../features/projects/queries';
import { dedupeTasks, formatEstimate } from '../features/task-table';
import { loadedTaskScope, useTaskListQuery } from '../features/tasks/queries';
import { useMembershipsQuery } from '../features/workspace/queries';
import { isAccessDenied } from '../lib/api';
import { isUuid } from '../lib/format';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useUnsavedChangesWarning } from '../lib/useUnsavedChangesWarning';
import { QueryErrorState } from '../shared/QueryErrorState';
import { useWorkspaceContext } from './WorkspaceLayout';

type PlanCommandKind = 'createCommitment' | 'updateCommitment' | 'freeze' | 'setFact' | 'createReport';

export function WeeklyPage() {
  const { t } = useTranslation();
  const { actorId, workspace } = useWorkspaceContext();
  const { projectId = '' } = useParams();
  const project = useProjectQuery(actorId, workspace.id, projectId);
  useDocumentTitle(t('planning.week', { name: project.data?.name ?? workspace.name }));
  if (!isUuid(projectId)) return <StateCard headingLevel={1} title={t('planning.projectUnavailable')} description={t('planning.chooseAnAvailableProject')} />;
  if (project.isPending) return <div role="status"><span className="sr-only">{t('planning.loadingWeek')}</span><Skeleton className="h-64 rounded-xl" /></div>;
  if (project.isError) return <QueryErrorState error={project.error} subject="project" headingLevel={1} retrying={project.isFetching} onRetry={() => void project.refetch()} />;
  return <WeeklyContent key={`${actorId}:${workspace.id}:${project.data.id}`} actorId={actorId} workspace={workspace} project={project.data} />;
}

function WeeklyContent({ actorId, workspace, project }: { actorId: string; workspace: WorkspaceDto; project: ProjectDto }) {
  const { t } = useTranslation();
  const [params, setParams] = useCurrentSearchParams();
  const periods = usePlanningPeriodsQuery(actorId, workspace.id, project.id);
  const packages = usePlanningPackagesQuery(actorId, workspace.id, project.id);
  const members = useMembershipsQuery(actorId, workspace.id);
  const fields = useTaskFieldsQuery(actorId, workspace.id, project.id);
  const tasks = useTaskListQuery(actorId, workspace.id, { projectId: project.id, includeArchived: true });
  // Every command and draft outlives period query changes and hidden dialogs.
  const commands = usePlanningCommands(actorId, workspace.id, project.id);
  const categoryCommands = useWorkCategoryCommands(actorId, workspace.id, project.id);
  const cutoffController = useCutoffWorkspace(actorId, workspace.id, project.id);
  const dependencies = useDependencyWorkspace(actorId, workspace.id, project.id);
  const recurrenceController = useRecurrenceWorkspace(actorId, workspace.id, project.id);
  const recurrenceRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [planDrafts, setPlanDrafts] = useState<Record<string, CommitmentSession>>({});
  const [factDrafts, setFactDrafts] = useState<Record<string, FactSession>>({});
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [factKey, setFactKey] = useState<string | null>(null);
  const planKeyRef = useRef(planKey);
  planKeyRef.current = planKey;
  const factKeyRef = useRef(factKey);
  factKeyRef.current = factKey;
  const [planOpen, setPlanOpen] = useState(false);
  const [factOpen, setFactOpen] = useState(false);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [freezeRequest, setFreezeRequest] = useState<FreezeRequest | null>(null);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const freezeNonce = useRef(0);
  const [announcement, setAnnouncement] = useState<TranslationMessage | null>(null);
  const [reportSelections, setReportSelections] = useState<Record<string, ReportDraft<ReportSelection>>>({});
  const [typeSelections, setTypeSelections] = useState<Record<string, ReportDraft<WorkTypeReportSelection>>>({});
  const orderedPeriods = sortPlanningPeriods(periods.data ?? []);
  const periodId = selectPlanningPeriodId(orderedPeriods, params.get('period')) ?? '';
  const period = usePlanningPeriodQuery(actorId, workspace.id, periodId);
  const commitments = usePeriodCommitmentsQuery(actorId, workspace.id, periodId);
  const baselines = usePlanBaselinesQuery(actorId, workspace.id, periodId);
  const worklogs = useRecordedWorkQuery(actorId, workspace.id, periodId);
  const meetings=useMeetingsQuery(actorId,workspace.id,project.id,periodId);
  const meetingController=useMeetingWorkspace(actorId,workspace.id,project.id);
  const commentsController=useTaskCommentsWorkspace(actorId,workspace.id);
  const discussionTarget=useRef<typeof meetingController.target>(null);
  const openDiscussion=(taskId:string)=>{const target={taskId,tab:'meeting' as const};discussionTarget.current=target;meetingController.setTarget(target);};
  const meetingStatuses=useStatusesQuery(actorId,workspace.id,project.id);
  const meetingSections=useSectionsQuery(actorId,workspace.id,project.id);
  const runs = useReportRunsQuery(actorId, workspace.id, periodId);
  const view = params.get('view') === 'report' ? 'report' : params.get('view') === 'work-types' ? 'work-types' : 'plan';
  const runId = params.get('run') ?? '';
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const canWrite = workspace.role !== 'viewer' && project.archivedAt === null;
  const ownMembershipId = members.data?.find((member) => member.userId === actorId)?.id ?? null;
  const entryMembershipId = (params.get('worker') ?? ownMembershipId ?? '').toLowerCase();
  const entryMember = members.data?.find((member) => member.id === entryMembershipId);
  const canEnterForMember = canWrite && entryMember !== undefined && (canManage || entryMembershipId === ownMembershipId);
  const taskItems = tasks.isError ? [] : dedupeTasks(loadedTaskScope(tasks.data).tasks);
  const selectedPlan = planKey === null ? null : planDrafts[planKey] ?? null;
  const selectedFact = factKey === null ? null : factDrafts[factKey] ?? null;
  useUnsavedChangesWarning(Object.keys(planDrafts).length > 0 || Object.keys(factDrafts).length > 0);

  const selectPeriod = (id: string, membershipId?: string) => setParams((before) => {
    const next = new URLSearchParams(before); next.set('period', id); if (membershipId !== undefined) next.set('worker', membershipId); next.delete('run'); next.delete('typeRun'); return next;
  });
  useEffect(() => {
    if (!params.has('period') && periodId) setParams((before) => {
      if (before.has('period')) return null;
      const next = new URLSearchParams(before); next.set('period', periodId); return next;
    }, { replace: true });
  }, [params, periodId, setParams]);
  // ?series= mirrors the selected series. A URL change (link, back/forward) is applied once per distinct value;
  // panel selections write the URL and the controller together. Drafts, commands, period and view are untouched.
  const seriesParam = params.get('series');
  const requestedSeriesId = seriesParam !== null && isUuid(seriesParam) ? seriesParam.toLowerCase() : null;
  const appliedSeriesParam = useRef<string | null>(null);
  const { setSelectedSeriesId } = recurrenceController;
  useEffect(() => {
    if (appliedSeriesParam.current === requestedSeriesId) return;
    appliedSeriesParam.current = requestedSeriesId;
    setSelectedSeriesId(requestedSeriesId);
  }, [requestedSeriesId, setSelectedSeriesId]);
  const selectSeries = (id: string | null) => {
    const canonical = id === null ? null : id.toLowerCase();
    appliedSeriesParam.current = canonical;
    setSelectedSeriesId(canonical);
    setParams((before) => { const next = new URLSearchParams(before); if (canonical === null) next.delete('series'); else next.set('series', canonical); return next; });
  };

  const openPlan = (base: PeriodCommitmentDto | null) => {
    if (!period.data || (!base && !canEnterForMember)) return;
    const session = commitmentSession(period.data, base, entryMembershipId);
    setPlanDrafts((before) => ({ ...before, [session.key]: before[session.key] ?? session }));
    setPlanKey(session.key); setPlanOpen(true);
  };
  const openFact = (logId: string | null) => {
    if (!period.data || (!logId && !canEnterForMember)) return;
    const log = worklogs.data?.find((item) => item.id === logId) ?? null;
    if(log?.sourceKind==='meeting_attendance'){meetingController.setTarget({taskId:log.taskId,tab:'attendance',membershipId:log.membershipId,attendanceId:log.attendanceId,requestedPeriodId:log.periodId});return;}
    const session = factSession(period.data, log, entryMembershipId);
    setFactDrafts((before) => ({ ...before, [session.key]: before[session.key] ?? session }));
    setFactKey(session.key); setFactOpen(true);
  };
  const heldCommands = (['createCommitment', 'updateCommitment', 'freeze', 'setFact', 'createReport'] as const).flatMap((kind) => {
    const mutation = commands[kind];
    const variables = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
    return variables ? [{ kind, periodId: variables.periodId, pending: mutation.pendingCommand !== null }] : [];
  });
  const resume = (kind: PlanCommandKind, targetPeriodId: string) => {
    if (kind === 'createCommitment' || kind === 'updateCommitment') {
      const mutation = commands[kind];
      const variables = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
      const found = variables ? Object.values(planDrafts).find((draft) => draft.period.id === targetPeriodId && ('commitmentId' in variables ? draft.base?.id === variables.commitmentId : draft.base === null && draft.packageId === variables.input.workPackageId && draft.membershipId === variables.input.membershipId)) : undefined;
      selectPeriod(targetPeriodId, found?.membershipId);
      if (found) { setPlanKey(found.key); setPlanOpen(true); }
    } else if (kind === 'setFact') {
      const variables = commands.setFact.pendingCommand?.variables ?? commands.setFact.uncertain?.variables;
      const found = Object.values(factDrafts).find((draft) => draft.period.id === targetPeriodId && draft.taskId === variables?.taskId && draft.membershipId === variables.membershipId);
      selectPeriod(targetPeriodId, found?.membershipId);
      if (found) { setFactKey(found.key); setFactOpen(true); }
    } else if (kind === 'freeze') {
      selectPeriod(targetPeriodId); setFreezeOpen(true);
    } else {
      // One navigation restores the original report context without resurrecting either old run.
      setParams((before) => { const next = new URLSearchParams(before); next.set('period', targetPeriodId); next.set('view', 'report'); next.delete('run'); next.delete('typeRun'); return next; });
    }
  };
  const startFreeze = (scope: 'self' | 'project') => {
    const held = commands.freeze.pendingCommand?.variables ?? commands.freeze.uncertain?.variables;
    if (held) { resume('freeze', held.periodId); return; }
    if (!period.data) return;
    setFreezeRequest({ period: period.data, scope, nonce: ++freezeNonce.current });
    commands.freeze.reset(); setFreezeOpen(true);
  };
  const metadataError = [periods, packages, members].find((query) => query.isError);
  const detailError = periodId ? [period, commitments, baselines, worklogs, runs].find((query) => query.isError) : undefined;
  const denied = isAccessDenied(metadataError?.error) || isAccessDenied(detailError?.error);
  const loaded = period.isSuccess && commitments.isSuccess && baselines.isSuccess && worklogs.isSuccess && runs.isSuccess;
  const validProject = period.data === undefined || period.data.projectId === project.id;
  const savePlan = (key: string) => { setPlanDrafts((before) => Object.fromEntries(Object.entries(before).filter(([itemKey]) => itemKey !== key))); if (planKeyRef.current === key) setPlanOpen(false); setAnnouncement(message('planning.personalPlanSaved')); };
  const saveFact = (key: string) => { setFactDrafts((before) => Object.fromEntries(Object.entries(before).filter(([itemKey]) => itemKey !== key))); if (factKeyRef.current === key) setFactOpen(false); setAnnouncement(message('planning.weeklyActualHoursSaved')); };
  // A completed calculation never replaces a period, view, or saved run chosen while it was pending.
  const calculatedReport = (id: string, targetPeriodId: string, sourceRunId: string) => setParams(current => {
    if (current.get('period')?.toLowerCase() !== targetPeriodId.toLowerCase() || current.get('view') !== 'report' || (current.get('run') ?? '') !== sourceRunId) return null;
    const next = new URLSearchParams(current); next.set('run', id); return next;
  });
  const calculatedTypeReport = (id: string, targetPeriodId: string, sourceRunId: string) => setParams(current => {
    if (current.get('period')?.toLowerCase() !== targetPeriodId.toLowerCase() || current.get('view') !== 'work-types' || (current.get('typeRun') ?? '') !== sourceRunId) return null;
    const next = new URLSearchParams(current); next.set('typeRun', id); return next;
  });
  const selectedReport = (id: string, targetPeriodId: string) => setParams((before) => { const next = new URLSearchParams(before); next.set('period', targetPeriodId); next.set('view', 'report'); if (id) next.set('run', id); else next.delete('run'); return next; });
  const selectedTypeReport = (id: string, targetPeriodId: string) => setParams((before) => { const next = new URLSearchParams(before); next.set('period', targetPeriodId); next.set('view', 'work-types'); if (id) next.set('typeRun', id); else next.delete('typeRun'); return next; });
  const heldTypeReport = categoryCommands.createReport.pendingCommand?.variables ?? categoryCommands.createReport.uncertain?.variables ?? null;
  const recurrencePeriod = !periods.isSuccess || !validProject ? null : period.data ?? orderedPeriods.find((item) => item.id === periodId) ?? null;
  // Freeze rejected for unprepared series meetings: show the original period's readiness; nothing is sent here.
  const revealRecurrence = (targetPeriodId: string) => {
    setFreezeOpen(false);
    setParams((before) => { const next = new URLSearchParams(before); next.set('period', targetPeriodId); next.set('view', 'plan'); next.delete('run'); next.delete('typeRun'); return next; });
    void queryClient.invalidateQueries({ queryKey: recurrenceKeys.readiness(actorId, workspace.id, targetPeriodId) });
    window.setTimeout(() => { recurrenceRef.current?.scrollIntoView({ block: 'start' }); recurrenceRef.current?.focus({ preventScroll: true }); }, 0);
  };

  return (
    <div className="space-y-4">
      <Link to={projectTimeHref(workspace.id, project.id, { periodId, workerId: params.has('worker') ? entryMembershipId : undefined })} className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-ink"><ArrowLeft size={16} aria-hidden="true" />{t('planning.backToTaskTable')}</Link>
      <header className="flex items-center justify-between gap-3"><div className="min-w-0"><h1 className="text-xl font-semibold tracking-tight">{t('planning.weeklyPlan')}</h1><p className="mt-0.5 truncate text-xs text-muted">{project.name}</p></div>{canManage && !project.archivedAt ? <Button size="sm" onClick={() => setPeriodOpen(true)}><CalendarDays size={14} aria-hidden="true" />{t('planning.newPeriod')}</Button> : null}</header>
      <div role="status" aria-live="polite" className="sr-only">{announcement ? t(announcement.key, announcement.params) : null}</div>
      <CutoffRecovery controller={cutoffController} canManage={canManage&&canWrite} onOpen={id=>selectPeriod(id)}/>
      <DependencyNotices controller={dependencies} />
      <EdgeDialog controller={dependencies} actorId={actorId} workspaceId={workspace.id} project={project} writable={canWrite} />
      <MeetingCommandNotices controller={meetingController} onOpen={(taskId,tab,selection)=>meetingController.setTarget({taskId,tab,...selection})}/>
      {meetingController.commands.create.pendingCommand||meetingController.commands.create.uncertain?<HeldNotice pending={!!meetingController.commands.create.pendingCommand} label={t('planning.creatingMeeting')} onResume={()=>meetingController.setCreateOpen(true)}/>:null}
      {commands.createPeriod.pendingCommand || commands.createPeriod.uncertain ? <HeldNotice pending={commands.createPeriod.pendingCommand !== null} label={t('planning.creatingPeriod')} onResume={() => setPeriodOpen(true)} /> : null}
      {heldTypeReport ? <HeldNotice pending={categoryCommands.createReport.pendingCommand !== null} label={t('planning.hoursByWorkType')} onResume={() => selectedTypeReport('', heldTypeReport.input.periodId)} /> : null}
      {heldCommands.map((command) => <HeldNotice key={command.kind} pending={command.pending} label={command.kind === 'setFact' ? t('planning.weeklyActualHours') : command.kind === 'freeze' ? t('planning.savingBaseline2') : command.kind === 'createReport' ? t('planning.calculatingReport') : t('planning.personalPlan2')} onResume={() => resume(command.kind, command.periodId)} />)}
      {metadataError ? <QueryErrorState error={metadataError.error} subject="planning" headingLevel={2} retrying={metadataError.isFetching} onRetry={() => void metadataError.refetch()} /> : periods.isPending || packages.isPending || members.isPending ? <p role="status" className="text-sm text-muted">{t('planning.loadingPeriodsAndPeople')}</p> : (periods.data ?? []).length === 0 ? <StateCard headingLevel={2} icon={<CalendarDays size={20} aria-hidden="true" />} title={t('planning.startYourFirstWeekWithAPlan')} description={canManage ? t('planning.createAPeriodAddPersonalHoursThenReviewThe') : t('planning.askAnOwnerOrAdministratorToCreateAWeekly')} actions={canManage ? <Button variant="primary" onClick={() => setPeriodOpen(true)}>{t('planning.createFirstPeriod')}</Button> : undefined} /> : <>
        <div className="flex items-center gap-3"><label htmlFor="weekly-period" className="shrink-0 text-sm font-medium">{t('planning.period')}</label><select id="weekly-period" className={inputClassName('min-w-0 flex-1')} value={periodId} onChange={(event) => selectPeriod(event.target.value)}><option value="">{t('planning.chooseWeek')}</option>{orderedPeriods.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.localStart} — {lastIncludedDate(item.localEndExclusive)}</option>)}</select></div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><label htmlFor="weekly-person" className="shrink-0 text-xs font-medium">{t('planning.timeEntryFor')}</label><select id="weekly-person" aria-describedby="weekly-person-scope" className={inputClassName('h-9 min-w-0 flex-1 text-xs')} value={entryMembershipId} onChange={event => setParams(before => { const next = new URLSearchParams(before); next.set('worker', event.target.value); return next; })}><option value="">{t('planning.chooseAPerson')}</option>{(members.data ?? []).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}{entryMembershipId && !entryMember ? <option value={entryMembershipId}>{t('planning.selectedPersonUnavailable')}</option> : null}</select><p id="weekly-person-scope" className="sr-only">{t('planning.timeEntryPersonScope')}</p>{!canEnterForMember && canWrite ? <p role="status" className="basis-full text-xs text-muted">{entryMember ? t('planning.selectedPersonReadOnly') : t('planning.chooseAvailablePerson')}</p> : null}</div>
        {!periodId ? <StateCard headingLevel={2} title={t('planning.chooseWeek')} description={t('planning.chooseWeekBeforeHours')} /> : detailError ? <QueryErrorState error={detailError.error} subject="planning" headingLevel={2} retrying={detailError.isFetching} onRetry={() => void detailError.refetch()} /> : !validProject ? <StateCard headingLevel={2} title={t('planning.thisPeriodBelongsToAnotherProject')} description={t('planning.chooseAPeriodFromThisProjectsList')} /> : !loaded ? <p role="status" className="text-sm text-muted">{t('planning.loadingSelectedWeek')}</p> : <>
          <section aria-label={t('planning.periodContext')} className="space-y-2">
            <CutoffPanel actorId={actorId} workspaceId={workspace.id} periodId={periodId} timezone={period.data.timezone} canManage={canManage&&canWrite} controller={cutoffController} onFreeze={()=>startFreeze('project')} onManageCalendar={seriesId=>{if(seriesId)selectSeries(seriesId);recurrenceRef.current?.scrollIntoView({block:'start'});recurrenceRef.current?.focus({preventScroll:true});}}/>
            <details className="mt-2 text-xs text-muted">
              <summary className="w-fit cursor-pointer rounded font-medium text-accent-ink">{t('planning.baselineOptionsAndHelp')}</summary>
              <div className="space-y-3 pt-3">
                <p>{t('planning.savingABaselinePreservesTheOriginalPlanYouCan')}</p>
                <p>{t('planning.periodsAreNewestFirstSwitchingWeeksPreservesDraftsAnd')}</p>
                <div className="flex flex-wrap gap-2">{canWrite && ownMembershipId ? <Button size="sm" onClick={() => startFreeze('self')}><Lock size={14} aria-hidden="true" />{t('planning.saveMyBaseline')}</Button> : null}</div>
              </div>
            </details>
          </section>
          <nav aria-label={t('planning.weeklyView')} className="flex gap-1 border-b border-line pb-2">{(['plan', 'report', 'work-types'] as const).map((item) => <Button key={item} variant={view === item ? 'primary' : 'ghost'} aria-current={view === item ? 'page' : undefined} onClick={() => setParams((before) => { const next = new URLSearchParams(before); next.set('view', item); return next; })}>{item === 'plan' ? t('planning.planAndHours') : item === 'report' ? t('planning.report') : t('planning.workTypes')}</Button>)}</nav>
          <div hidden={view !== 'plan'} className="space-y-6">
            <section aria-label={t('planning.personalPlans')} className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('planning.personalPlans')}</h2>{canWrite ? <Button variant="primary" disabled={!canEnterForMember} onClick={() => openPlan(null)}><Plus size={16} aria-hidden="true" />{t('planning.addToPlan')}</Button> : null}</div><p className="text-xs text-muted">{t('planning.personalHoursHint')}</p>{commitments.data.length === 0 ? <p className="rounded-xl border border-dashed border-line p-5 text-sm text-muted">{t('planning.noPersonalPlansForThisWeekYet')}</p> : <PersonalPlanList commitments={commitments.data} packages={packages.data ?? []} members={members.data ?? []} canWrite={canWrite} canManage={canManage} ownMembershipId={ownMembershipId} onOpen={openPlan} />}</section>
            <section aria-label={t('planning.weeklyActualHours')} className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('planning.weeklyActualHours')}</h2>{canWrite ? <Button disabled={!canEnterForMember} onClick={() => openFact(null)}><Plus size={16} aria-hidden="true" />{t('planning.recordActualHours')}</Button> : null}</div><p className="text-xs text-muted">{t('planning.aMissingEntryIsShownAsNotRecordedA')}</p>{worklogs.data.length === 0 ? <p className="rounded-xl border border-dashed border-line p-5 text-sm text-muted">{t('planning.noActualHoursRecordedForThisWeekYet')}</p> : <div className="space-y-2">{worklogs.data.map((log) => <div key={log.id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-medium [overflow-wrap:anywhere]">{taskItems.find((task) => task.id === log.taskId)?.title ?? (packages.data ?? []).find((work) => work.id === log.workPackageId)?.title ?? t('planning.savedTask')}</p><p className="mt-1 text-sm text-muted">{(members.data ?? []).find((member) => member.id === log.membershipId)?.displayName ?? t('planning.savedPerson')} · {formatEstimate(log.minutes)} · {log.state === 'void' ? t('planning.entryVoided') : <RecordedWorkLabel log={log}/>}</p><p className="mt-1 text-xs text-muted">{t('planning.revision2', { source: log.sourceKind==='manual_period'?t('planning.manualEntry'):t('planning.meetingAttendance'), revision: log.revision })}</p></div>{canWrite && (canManage || ownMembershipId === log.membershipId) ? <Button size="sm" onClick={() => openFact(log.id)}>{t('planning.editActualHours')}</Button> : null}</div>)}</div>}</section>
            <section aria-label={t('planning.meetingsThisWeek')} className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('planning.meetingsThisWeek')}</h2>{canWrite&&meetingStatuses.isSuccess?<Button onClick={()=>meetingController.setCreateOpen(true)}>{t('planning.newMeeting')}</Button>:null}</div>{meetings.isError?<QueryErrorState error={meetings.error} subject="task" headingLevel={2} retrying={meetings.isFetching} onRetry={()=>void meetings.refetch()}/>:meetings.isPending?<p role="status" className="text-sm text-muted">{t('planning.loadingMeetings')}</p>:meetings.data.length===0?<p className="text-sm text-muted">{t('planning.noMeetingsInThisPeriodAttendanceAndPersonalPlans')}</p>:<div className="space-y-2">{meetings.data.map(item=><div key={item.meeting.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4"><div className="min-w-0 flex-1"><p className="font-medium [overflow-wrap:anywhere]">{item.task.title}</p><p className="mt-1 text-xs text-muted">{meetingTime(item.meeting.plannedStartAt,item.meeting.timezone)} · {formatEstimate(item.meeting.plannedDurationMinutes)}{item.meeting.state==='cancelled'?t('planning.voided'):''}</p></div><Button size="sm" onClick={()=>meetingController.setTarget({taskId:item.task.id,tab:'meeting'})}>{t('planning.openMeeting')}</Button><Button size="sm" onClick={()=>meetingController.setTarget({taskId:item.task.id,tab:'attendance'})}>{t('planning.attendance')}</Button></div>)}</div>}</section>
          </div>
          <div hidden={view !== 'report'}><WeeklyReport actorId={actorId} workspaceId={workspace.id} period={period.data} baselines={baselines.data} runs={runs.data} members={members.data ?? []} runId={runId} draft={reportSelections[periodId]} onDraftAction={action => setReportSelections(before => updateReportDraft(before, action))} mutation={commands.createReport} onSelectRun={selectedReport} onCalculated={calculatedReport} /></div>
          <div hidden={view !== 'work-types'}><WorkTypeReport actorId={actorId} workspaceId={workspace.id} period={period.data} members={members.data ?? []} runId={params.get('typeRun') ?? ''} draft={typeSelections[periodId]} onDraftAction={action => setTypeSelections(before => updateReportDraft(before, action))} mutation={categoryCommands.createReport} onSelectRun={selectedTypeReport} onCalculated={calculatedTypeReport} /></div>
        </>}
      </>}
      {/* Stays mounted across views, periods and dialogs so held recurrence commands remain reachable. */}
      <div ref={recurrenceRef} tabIndex={-1} className="scroll-mt-4"><RecurrencePanel controller={recurrenceController} actorId={actorId} workspace={workspace} project={project} period={recurrencePeriod} periods={periods.isSuccess ? orderedPeriods : []} members={members.isSuccess ? members.data : []} statuses={meetingStatuses.isSuccess ? meetingStatuses.data : []} sections={meetingSections.isSuccess ? meetingSections.data : []} writable={canWrite} accessDenied={denied || [meetingStatuses.error, meetingSections.error].some(isAccessDenied)} onSelectPeriod={selectPeriod} onSelectSeries={selectSeries} onOpenMeeting={(taskId, targetPeriodId) => meetingController.setTarget({ taskId, tab: 'meeting', requestedPeriodId: targetPeriodId })} /></div>
      <>
        <CreateMeetingDialog accessDenied={denied||[meetingStatuses.error,meetingSections.error].some(isAccessDenied)} controller={meetingController} members={members.data??[]} periods={orderedPeriods} statuses={meetingStatuses.data??[]} sections={meetingSections.data??[]} ownMembershipId={ownMembershipId??''} timezone={workspace.timezone} onCreated={taskId=>meetingController.setTarget({taskId,tab:'plan'})}/>
        <CommentCommandRecovery controller={commentsController} visibleTaskId={denied?null:meetingController.target?.taskId??null} onOpen={openDiscussion}/>
        {meetingController.target?<MeetingDrawer commentsController={commentsController} initialIntent={meetingController.target} onOpenTask={openDiscussion} dependencyController={dependencies} key={meetingController.target.taskId} controller={meetingController} actorId={actorId} workspace={workspace} project={project} members={members.data??[]} taskId={meetingController.target.taskId} requestedPeriodId={meetingController.target.requestedPeriodId} onAcceptOriginalPeriod={selectPeriod} initialMembershipId={meetingController.target.membershipId} initialAttendanceId={meetingController.target.attendanceId} initialTab={meetingController.target===discussionTarget.current?undefined:meetingController.target.tab} open={!denied} onClose={()=>meetingController.setTarget(null)}/>:null}
        <PeriodDialog projectId={project.id} timezone={workspace.timezone} fields={fields.isSuccess ? fields.data : []} mutation={commands.createPeriod} open={periodOpen && !denied} onOpenChange={setPeriodOpen} onCreated={(id) => { setPeriodOpen(false); selectPeriod(id); setAnnouncement(message('planning.weeklyPeriodCreated')); }} />
        <CommitmentDialog session={selectedPlan} open={planOpen && !denied} packages={packages.isSuccess ? packages.data : []} tasks={taskItems} members={members.isSuccess ? members.data : []} ownMembershipId={ownMembershipId} canWriteOthers={canManage} writable={canWrite} fixedMember commands={commands} hasMoreTasks={tasks.hasNextPage} loadingMoreTasks={tasks.isFetchingNextPage} onLoadTasks={() => void tasks.fetchNextPage()} onChange={(session) => setPlanDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setPlanOpen(false)} onSaved={savePlan} onReload={async (session) => { const fresh = await fetchPeriodCommitments(workspace.id, session.period.id); return fresh.find((item) => session.base ? item.id === session.base.id : item.workPackageId === session.packageId && item.membershipId === session.membershipId) ?? null; }} />
        <FactDialog session={selectedFact} open={factOpen && !denied} tasks={taskItems} members={members.isSuccess ? members.data : []} ownMembershipId={ownMembershipId} canWriteOthers={canManage} writable={canWrite} fixedMember mutation={commands.setFact} hasMoreTasks={tasks.hasNextPage} loadingMoreTasks={tasks.isFetchingNextPage} onLoadTasks={() => void tasks.fetchNextPage()} onChange={(session) => setFactDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setFactOpen(false)} onSaved={saveFact} onReload={async (session) => { const fresh = await fetchPeriodWorkLogs(workspace.id, session.period.id); return fresh.find((item) => item.taskId === session.taskId && item.membershipId === session.membershipId) ?? null; }} />
        <FreezeDialog workspaceId={workspace.id} request={freezeRequest} open={freezeOpen && !denied} mutation={commands.freeze} onClose={() => setFreezeOpen(false)} onMaterializationRequired={revealRecurrence} onFrozen={(target, baselineId) => { void cutoffController.refresh(target); setFreezeOpen(false); selectPeriod(target); setAnnouncement(message('planning.baselineSavedSnapshot', { snapshotId: baselineId.slice(0, 8) })); }} />
      </>
    </div>
  );
}

function HeldNotice({ pending, label, onResume }: { pending: boolean; label: string; onResume: () => void }) {
  const { t } = useTranslation();
  return <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><span className="min-w-0 flex-1">{t('planning.theOriginalPeriodIsPreserved2', { label: label, saveState: pending ? t('planning.waitingForServerResponse') : t('planning.saveResultUnknown') })}</span><Button size="sm" onClick={onResume}>{t('planning.openOriginalSave')}</Button></div>;
}
function lastIncludedDate(end: string): string { const date = new Date(`${end}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
