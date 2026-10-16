import type { PeriodCommitmentDto, ProjectDto, WorkspaceDto } from '@workloom/contracts';
import { Badge, Button, Skeleton, StateCard, inputClassName } from '@workloom/ui';
import { ArrowLeft, CalendarDays, Lock, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useTaskFieldsQuery } from '../features/fields';
import { CommitmentDialog, commitmentSession, type CommitmentSession } from '../features/planning/CommitmentDialog';
import { FactDialog, factSession, type FactSession } from '../features/planning/FactDialog';
import { FreezeDialog, type FreezeRequest } from '../features/planning/FreezeDialog';
import { PeriodDialog } from '../features/planning/PeriodDialog';
import { WeeklyReport, type ReportSelection } from '../features/planning/WeeklyReport';
import {
  usePlanningCommands, usePlanningPeriodsQuery, usePlanningPackagesQuery, usePlanningPeriodQuery,
  usePeriodCommitmentsQuery, usePlanBaselinesQuery, usePeriodWorkLogsQuery, useReportRunsQuery,
} from '../features/planning/queries';
import { fetchPeriodCommitments, fetchPeriodWorkLogs } from '../features/planning/api';
import { formatPeriodCutoff } from '../features/planning/dates';
import { selectPlanningPeriodId, sortPlanningPeriods } from '../features/planning/periodSelection';
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
  const { actorId, workspace } = useWorkspaceContext();
  const { projectId = '' } = useParams();
  const project = useProjectQuery(actorId, workspace.id, projectId);
  useDocumentTitle(`Неделя · ${project.data?.name ?? workspace.name}`);
  if (!isUuid(projectId)) return <StateCard headingLevel={1} title="Проект недоступен" description="Выберите доступный проект." />;
  if (project.isPending) return <div role="status"><span className="sr-only">Загрузка недели</span><Skeleton className="h-64 rounded-xl" /></div>;
  if (project.isError) return <QueryErrorState error={project.error} subject="project" headingLevel={1} retrying={project.isFetching} onRetry={() => void project.refetch()} />;
  return <WeeklyContent key={`${actorId}:${workspace.id}:${project.data.id}`} actorId={actorId} workspace={workspace} project={project.data} />;
}

function WeeklyContent({ actorId, workspace, project }: { actorId: string; workspace: WorkspaceDto; project: ProjectDto }) {
  const [params, setParams] = useSearchParams();
  const periods = usePlanningPeriodsQuery(actorId, workspace.id, project.id);
  const packages = usePlanningPackagesQuery(actorId, workspace.id, project.id);
  const members = useMembershipsQuery(actorId, workspace.id);
  const fields = useTaskFieldsQuery(actorId, workspace.id, project.id);
  const tasks = useTaskListQuery(actorId, workspace.id, { projectId: project.id, includeArchived: true });
  // Every command and draft outlives period query changes and hidden dialogs.
  const commands = usePlanningCommands(actorId, workspace.id, project.id);
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
  const [announcement, setAnnouncement] = useState('');
  const [reportSelections, setReportSelections] = useState<Record<string, ReportSelection>>({});
  const orderedPeriods = sortPlanningPeriods(periods.data ?? []);
  const periodId = selectPlanningPeriodId(orderedPeriods, params.get('period')) ?? '';
  const period = usePlanningPeriodQuery(actorId, workspace.id, periodId);
  const commitments = usePeriodCommitmentsQuery(actorId, workspace.id, periodId);
  const baselines = usePlanBaselinesQuery(actorId, workspace.id, periodId);
  const worklogs = usePeriodWorkLogsQuery(actorId, workspace.id, periodId);
  const runs = useReportRunsQuery(actorId, workspace.id, periodId);
  const view = params.get('view') === 'report' ? 'report' : 'plan';
  const runId = params.get('run') ?? '';
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const canWrite = workspace.role !== 'viewer' && project.archivedAt === null;
  const ownMembershipId = members.data?.find((member) => member.userId === actorId)?.id ?? null;
  const taskItems = tasks.isError ? [] : dedupeTasks(loadedTaskScope(tasks.data).tasks);
  const selectedPlan = planKey === null ? null : planDrafts[planKey] ?? null;
  const selectedFact = factKey === null ? null : factDrafts[factKey] ?? null;
  useUnsavedChangesWarning(Object.keys(planDrafts).length > 0 || Object.keys(factDrafts).length > 0);

  const selectPeriod = (id: string) => setParams((before) => {
    const next = new URLSearchParams(before); next.set('period', id); next.delete('run'); return next;
  });
  useEffect(() => {
    if (!params.has('period') && periodId) setParams((before) => {
      if (before.has('period')) return before;
      const next = new URLSearchParams(before); next.set('period', periodId); return next;
    }, { replace: true });
  }, [params, periodId, setParams]);

  const openPlan = (base: PeriodCommitmentDto | null) => {
    if (!period.data) return;
    const session = commitmentSession(period.data, base, ownMembershipId ?? '');
    setPlanDrafts((before) => ({ ...before, [session.key]: before[session.key] ?? session }));
    setPlanKey(session.key); setPlanOpen(true);
  };
  const openFact = (logId: string | null) => {
    if (!period.data) return;
    const log = worklogs.data?.find((item) => item.id === logId) ?? null;
    const session = factSession(period.data, log, ownMembershipId ?? '');
    setFactDrafts((before) => ({ ...before, [session.key]: before[session.key] ?? session }));
    setFactKey(session.key); setFactOpen(true);
  };
  const heldCommands = (['createCommitment', 'updateCommitment', 'freeze', 'setFact', 'createReport'] as const).flatMap((kind) => {
    const mutation = commands[kind];
    const variables = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
    return variables ? [{ kind, periodId: variables.periodId, pending: mutation.pendingCommand !== null }] : [];
  });
  const resume = (kind: PlanCommandKind, targetPeriodId: string) => {
    selectPeriod(targetPeriodId);
    if (kind === 'createCommitment' || kind === 'updateCommitment') {
      const mutation = commands[kind];
      const variables = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
      const key = variables && 'commitmentId' in variables ? variables.commitmentId : `new:${targetPeriodId}`;
      setPlanKey(planDrafts[key] ? key : Object.values(planDrafts).find((draft) => draft.base?.id === key)?.key ?? key); setPlanOpen(true);
    } else if (kind === 'setFact') {
      const variables = commands.setFact.pendingCommand?.variables ?? commands.setFact.uncertain?.variables;
      const found = Object.values(factDrafts).find((draft) => draft.period.id === targetPeriodId && draft.taskId === variables?.taskId && draft.membershipId === variables.membershipId);
      if (found) { setFactKey(found.key); setFactOpen(true); }
    } else if (kind === 'freeze') setFreezeOpen(true);
    else setParams((before) => { const next = new URLSearchParams(before); next.set('period', targetPeriodId); next.set('view', 'report'); next.delete('run'); return next; });
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
  const savePlan = (key: string) => { setPlanDrafts((before) => Object.fromEntries(Object.entries(before).filter(([itemKey]) => itemKey !== key))); if (planKeyRef.current === key) setPlanOpen(false); setAnnouncement('Личный план сохранён.'); };
  const saveFact = (key: string) => { setFactDrafts((before) => Object.fromEntries(Object.entries(before).filter(([itemKey]) => itemKey !== key))); if (factKeyRef.current === key) setFactOpen(false); setAnnouncement('Факт за неделю сохранён.'); };
  const selectedReport = (id: string, targetPeriodId: string) => setParams((before) => { const next = new URLSearchParams(before); next.set('period', targetPeriodId); next.set('view', 'report'); if (id) next.set('run', id); else next.delete('run'); return next; });

  return (
    <div className="space-y-6">
      <Link to={`/w/${workspace.id}/projects/${project.id}`} className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-ink"><ArrowLeft size={16} aria-hidden="true" />К таблице задач</Link>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="mb-1 text-xs font-medium text-muted">{project.name}</p><h1 className="text-2xl font-semibold tracking-tight">Недельный план</h1><p className="mt-2 text-sm leading-relaxed text-muted">Личный объём на неделю, исходный план и внесённый факт.</p></div>{canManage && !project.archivedAt ? <Button onClick={() => setPeriodOpen(true)}><CalendarDays size={16} aria-hidden="true" />Новый период</Button> : null}</header>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>
      {commands.createPeriod.pendingCommand || commands.createPeriod.uncertain ? <HeldNotice pending={commands.createPeriod.pendingCommand !== null} label="Создание периода" onResume={() => setPeriodOpen(true)} /> : null}
      {heldCommands.map((command) => <HeldNotice key={command.kind} pending={command.pending} label={command.kind === 'setFact' ? 'Факт за неделю' : command.kind === 'freeze' ? 'Фиксация плана' : command.kind === 'createReport' ? 'Расчёт отчёта' : 'Личный план'} onResume={() => resume(command.kind, command.periodId)} />)}
      {metadataError ? <QueryErrorState error={metadataError.error} subject="planning" headingLevel={2} retrying={metadataError.isFetching} onRetry={() => void metadataError.refetch()} /> : periods.isPending || packages.isPending || members.isPending ? <p role="status" className="text-sm text-muted">Загрузка периодов и участников…</p> : (periods.data ?? []).length === 0 ? <StateCard headingLevel={2} icon={<CalendarDays size={20} aria-hidden="true" />} title="Первая неделя начинается с плана" description={canManage ? 'Создайте период, добавьте личные часы и проверьте исходный план перед фиксацией.' : 'Попросите владельца или администратора создать недельный период.'} actions={canManage ? <Button variant="primary" onClick={() => setPeriodOpen(true)}>Создать первый период</Button> : undefined} /> : <>
        <div className="space-y-2"><label htmlFor="weekly-period" className="text-sm font-medium">Период</label><select id="weekly-period" className={inputClassName()} value={periodId} onChange={(event) => selectPeriod(event.target.value)}>{orderedPeriods.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.localStart} — {lastIncludedDate(item.localEndExclusive)}</option>)}</select><p className="text-xs text-muted">Периоды показаны от новых к старым. Переключение недели сохраняет открытые черновики и отправки в памяти этой страницы.</p></div>
        {detailError ? <QueryErrorState error={detailError.error} subject="planning" headingLevel={2} retrying={detailError.isFetching} onRetry={() => void detailError.refetch()} /> : !validProject ? <StateCard headingLevel={2} title="Период относится к другому проекту" description="Выберите период из списка этого проекта." /> : !loaded ? <p role="status" className="text-sm text-muted">Загрузка выбранной недели…</p> : <>
          <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{period.data.name}</h2><p className="mt-1 text-sm text-muted">{period.data.localStart} — {lastIncludedDate(period.data.localEndExclusive)} · {period.data.timezone}</p><p className="mt-1 text-xs text-muted">Срок фиксации ({period.data.timezone}): {formatPeriodCutoff(period.data.cutoffAt, period.data.timezone)}</p></div><Badge tone="muted">{period.data.state === 'frozen' ? 'План проекта зафиксирован' : 'Планирование'}</Badge></div><div className="flex flex-wrap gap-2">{canWrite && ownMembershipId ? <Button onClick={() => startFreeze('self')}><Lock size={14} aria-hidden="true" />Зафиксировать мой план</Button> : null}{canManage && canWrite ? <Button onClick={() => startFreeze('project')}><Lock size={14} aria-hidden="true" />Зафиксировать план проекта</Button> : null}</div><p className="text-xs leading-relaxed text-muted">Фиксация сохраняет исходный снимок. Новую работу и факт можно добавить и после неё — они будут отмечены отдельно.</p></section>
          <nav aria-label="Представление недели" className="flex gap-2 border-b border-line pb-3">{(['plan', 'report'] as const).map((item) => <Button key={item} variant={view === item ? 'primary' : 'ghost'} aria-current={view === item ? 'page' : undefined} onClick={() => setParams((before) => { const next = new URLSearchParams(before); next.set('view', item); return next; })}>{item === 'plan' ? 'План и часы' : 'Отчёт'}</Button>)}</nav>
          <div hidden={view !== 'plan'} className="space-y-6">
            <section aria-label="Личные планы" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Личные планы</h2>{canWrite ? <Button variant="primary" onClick={() => openPlan(null)}><Plus size={16} aria-hidden="true" />Добавить в план</Button> : null}</div><p className="text-xs leading-relaxed text-muted">Это часы конкретного человека на неделю. Общая оценка задачи остаётся отдельной и не умножается на число участников.</p>{commitments.data.length === 0 ? <p className="rounded-xl border border-dashed border-line p-5 text-sm text-muted">Пока нет личных планов на эту неделю.</p> : <div className="space-y-2">{commitments.data.map((item) => <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-medium [overflow-wrap:anywhere]">{(packages.data ?? []).find((work) => work.id === item.workPackageId)?.title ?? 'Сохранённая работа'}</p><p className="mt-1 text-sm text-muted">{(members.data ?? []).find((member) => member.id === item.membershipId)?.displayName ?? 'Сохранённый участник'} · {item.plannedMinutes === null ? 'Личный план не задан' : `Личный план: ${formatEstimate(item.plannedMinutes)}`}</p><p className="mt-1 text-xs text-muted">Нераспределено: {item.unallocatedMinutes === null ? 'неизвестно' : formatEstimate(item.unallocatedMinutes)}{item.state === 'removed' ? ' · убрано из текущего плана' : ''}</p><div className="mt-2 flex flex-wrap gap-1.5">{item.baselineIds.length > 0 ? <Badge tone="muted">Зафиксировано</Badge> : null}{item.classification === 'added' ? <Badge tone="muted">Добавлено после фиксации</Badge> : null}</div></div><Button size="sm" onClick={() => openPlan(item)}>{canWrite && (canManage || ownMembershipId === item.membershipId) && item.baselineIds.length === 0 ? 'Изменить план' : 'Посмотреть план'}</Button></div>)}</div>}</section>
            <section aria-label="Факт за неделю" className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Факт за неделю</h2>{canWrite ? <Button onClick={() => openFact(null)}><Plus size={16} aria-hidden="true" />Внести факт</Button> : null}</div><p className="text-xs text-muted">Отсутствие записи — «Не внесено». Подтверждённый 0 сохраняется как отдельный факт.</p>{worklogs.data.length === 0 ? <p className="rounded-xl border border-dashed border-line p-5 text-sm text-muted">Факт за эту неделю ещё не внесён.</p> : <div className="space-y-2">{worklogs.data.map((log) => <div key={log.id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 sm:flex-row sm:items-center"><div className="min-w-0 flex-1"><p className="font-medium [overflow-wrap:anywhere]">{taskItems.find((task) => task.id === log.taskId)?.title ?? (packages.data ?? []).find((work) => work.id === log.workPackageId)?.title ?? 'Сохранённая задача'}</p><p className="mt-1 text-sm text-muted">{(members.data ?? []).find((member) => member.id === log.membershipId)?.displayName ?? 'Сохранённый участник'} · {formatEstimate(log.minutes)} · {log.state === 'void' ? 'запись отменена' : 'за неделю'}</p><p className="mt-1 text-xs text-muted">Ручной факт · версия {log.revision}</p></div>{canWrite && (canManage || ownMembershipId === log.membershipId) ? <Button size="sm" onClick={() => openFact(log.id)}>Изменить факт</Button> : null}</div>)}</div>}</section>
          </div>
          <div hidden={view !== 'report'}><WeeklyReport actorId={actorId} workspaceId={workspace.id} period={period.data} baselines={baselines.data} runs={runs.data} members={members.data ?? []} runId={runId} selection={reportSelections[periodId]} onSelectionChange={(selection) => setReportSelections((before) => ({ ...before, [periodId]: selection }))} mutation={commands.createReport} onSelectRun={selectedReport} /></div>
        </>}
      </>}
      <>
        <PeriodDialog projectId={project.id} timezone={workspace.timezone} fields={fields.isSuccess ? fields.data : []} mutation={commands.createPeriod} open={periodOpen && !denied} onOpenChange={setPeriodOpen} onCreated={(id) => { setPeriodOpen(false); selectPeriod(id); setAnnouncement('Недельный период создан.'); }} />
        <CommitmentDialog session={selectedPlan} open={planOpen && !denied} packages={packages.isSuccess ? packages.data : []} tasks={taskItems} members={members.isSuccess ? members.data : []} ownMembershipId={ownMembershipId} canWriteOthers={canManage} writable={canWrite} commands={commands} hasMoreTasks={tasks.hasNextPage} loadingMoreTasks={tasks.isFetchingNextPage} onLoadTasks={() => void tasks.fetchNextPage()} onChange={(session) => setPlanDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setPlanOpen(false)} onSaved={savePlan} onReload={async (session) => { const fresh = await fetchPeriodCommitments(workspace.id, session.period.id); return fresh.find((item) => session.base ? item.id === session.base.id : item.workPackageId === session.packageId && item.membershipId === session.membershipId) ?? null; }} />
        <FactDialog session={selectedFact} open={factOpen && !denied} tasks={taskItems} members={members.isSuccess ? members.data : []} ownMembershipId={ownMembershipId} canWriteOthers={canManage} writable={canWrite} mutation={commands.setFact} hasMoreTasks={tasks.hasNextPage} loadingMoreTasks={tasks.isFetchingNextPage} onLoadTasks={() => void tasks.fetchNextPage()} onChange={(session) => setFactDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setFactOpen(false)} onSaved={saveFact} onReload={async (session) => { const fresh = await fetchPeriodWorkLogs(workspace.id, session.period.id); return fresh.find((item) => item.taskId === session.taskId && item.membershipId === session.membershipId) ?? null; }} />
        <FreezeDialog workspaceId={workspace.id} request={freezeRequest} open={freezeOpen && !denied} mutation={commands.freeze} onClose={() => setFreezeOpen(false)} onFrozen={(target, baselineId) => { setFreezeOpen(false); selectPeriod(target); setAnnouncement(`План зафиксирован. Снимок ${baselineId.slice(0, 8)}.`); }} />
      </>
    </div>
  );
}

function HeldNotice({ pending, label, onResume }: { pending: boolean; label: string; onResume: () => void }) {
  return <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><span className="min-w-0 flex-1">{label}: {pending ? 'ждём ответа сервера' : 'результат отправки неизвестен'}. Исходный период сохранён.</span><Button size="sm" onClick={onResume}>Открыть исходную отправку</Button></div>;
}
function lastIncludedDate(end: string): string { const date = new Date(`${end}T12:00:00Z`); date.setUTCDate(date.getUTCDate() - 1); return date.toISOString().slice(0, 10); }
