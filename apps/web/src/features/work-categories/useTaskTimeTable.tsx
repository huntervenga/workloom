import { fetchRecordedWork } from '../meetings/api';
import type { MeetingSelection, MeetingTab } from '../meetings/useMeetingWorkspace';
import { fetchTask } from '../tasks/api';
import { RecordedWorkLabel } from '../../shared/RecordedWorkLabel';
import type { CategorizedManualWorkLogDto, RecordedWorkLogDto, MembershipDto, PackageTimeRowDto, PlanningPeriodDto, ProjectDto, TaskDto, WorkspaceDto } from '@workloom/contracts';
import { Button, inputClassName } from '@workloom/ui';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { isAccessDenied } from '../../lib/api';
import { useUnsavedChangesWarning } from '../../lib/useUnsavedChangesWarning';
import { DialogShell } from '../../shared/DialogShell';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { CommitmentDialog, FactDialog, commitmentSession, factSession, fetchPlanningPeriod, fetchPeriodCommitments,  sortPlanningPeriods, usePlanningCommands, usePlanningPackagesQuery, usePlanningPeriodQuery, usePlanningPeriodsQuery, type CommitmentSession, type FactSession } from '../planning';
import { useTaskFieldsQuery } from '../fields';
import { formatEstimate, type TaskTableCustomColumn } from '../task-table';
import { fetchTaskTimeSummary, fetchWorkCategoryBinding } from './api';
import { CategoryBadge } from './CategoryBadge';
import { RecategorizeDialog, recategorizeSession, type RecategorizeSession } from './RecategorizeDialog';
import { useTaskTimeSummaryQuery, useWorkCategoryCommands } from './queries';

interface Props { actorId: string; workspace: WorkspaceDto; project: ProjectDto; members: readonly MembershipDto[]; tasks: readonly TaskDto[]; hasMoreTasks: boolean; loadingMoreTasks: boolean; onLoadTasks: () => void; accessDenied: boolean; onOpenMeeting?:(taskId:string,tab:MeetingTab,selection?:MeetingSelection)=>void }
interface Breakdown { period: PlanningPeriodDto; task: TaskDto; workerId: string; packageRow: PackageTimeRowDto; logs: RecordedWorkLogDto[] }

/** Mounted once by ProjectContent, above row/filter/period lifetimes. No time mutation reads an ambient lens. */
export function useTaskTimeTable(props: Props) {
  const { actorId, workspace, project } = props;
  const [params, setParams] = useSearchParams();
  const ownMembershipId = props.members.find((member) => member.userId === actorId)?.id ?? '';
  const periodId = params.get('week') ?? '';
  const workerId = params.get('worker') ?? ownMembershipId;
  const workerName = props.members.find((member) => member.id === workerId)?.displayName ?? 'Выбранный человек';
  const periods = usePlanningPeriodsQuery(actorId, workspace.id, project.id);
  const period = usePlanningPeriodQuery(actorId, workspace.id, periodId);
  const packages = usePlanningPackagesQuery(actorId, workspace.id, project.id);
  const definitions = useTaskFieldsQuery(actorId, workspace.id, project.id);
  const projection = useTaskTimeSummaryQuery(actorId, workspace.id, project.id, periodId, workerId, props.tasks.map((task) => task.id));
  const commands = usePlanningCommands(actorId, workspace.id, project.id);
  const categoryCommands = useWorkCategoryCommands(actorId, workspace.id, project.id);
  const [planDrafts, setPlanDrafts] = useState<Record<string, CommitmentSession>>({});
  const [factDrafts, setFactDrafts] = useState<Record<string, FactSession>>({});
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, RecategorizeSession>>({});
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [factKey, setFactKey] = useState<string | null>(null);
  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [factOpen, setFactOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null);
  const [openingError, setOpeningError] = useState<Error | null>(null);
  const [opening, setOpening] = useState(false);
  const busyRead = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentKeys = useRef({ planKey, factKey, categoryKey });
  currentKeys.current = { planKey, factKey, categoryKey };
  const canWriteOthers = workspace.role === 'owner' || workspace.role === 'admin';
  const writable = workspace.role !== 'viewer' && project.archivedAt === null;
  const canWriteSubject = writable && (canWriteOthers || workerId === ownMembershipId);
  const currentPlan = planKey ? planDrafts[planKey] ?? null : null;
  const currentFact = factKey ? factDrafts[factKey] ?? null : null;
  const currentCategory = categoryKey ? categoryDrafts[categoryKey] ?? null : null;
  const accessError = [period.error, projection.error, periods.error, definitions.error, openingError, commands.createCommitment.error, commands.updateCommitment.error, commands.setFact.error, categoryCommands.recategorize.error].find(isAccessDenied) ?? null;
  const denied = props.accessDenied || accessError !== null;
  useUnsavedChangesWarning(Object.keys(planDrafts).length > 0 || Object.keys(factDrafts).length > 0 || Object.keys(categoryDrafts).length > 0);

  const lens = (nextPeriod: string, nextWorker: string) => setParams((before) => { const next = new URLSearchParams(before); if (nextPeriod) next.set('week', nextPeriod); else next.delete('week'); if (nextWorker) next.set('worker', nextWorker); else next.delete('worker'); return next; });
  const read = async (operation: () => Promise<void>) => {
    if (busyRead.current) return;
    busyRead.current = true; setOpening(true); setOpeningError(null);
    try { await operation(); }
    catch (failure) { if (alive.current) setOpeningError(failure instanceof Error ? failure : new Error('Time read failed')); }
    finally { busyRead.current = false; if (alive.current) setOpening(false); }
  };
  const loadRow = async (taskId: string, targetPeriod = periodId, targetWorker = workerId) => {
    const [freshPeriod, time] = await Promise.all([fetchPlanningPeriod(workspace.id, targetPeriod), fetchTaskTimeSummary(workspace.id, project.id, targetPeriod, [taskId], targetWorker)]);
    if (freshPeriod.projectId !== project.id) throw new Error('Period scope mismatch');
    const taskRow = time.tasks.find((item) => item.taskId === taskId);
    const packageRow = time.packages.find((item) => item.workPackageId === taskRow?.workPackageId);
    if (!taskRow || !packageRow) throw new Error('Incomplete time projection');
    return { period: freshPeriod, taskRow, packageRow };
  };
  const openPlan = (task: TaskDto) => void read(async () => {
    const fresh = await loadRow(task.id);
    if (!alive.current) return;
    const marker=fresh.taskRow.meetingId===undefined?(await fetchTask(workspace.id,task.id)).meetingId:fresh.taskRow.meetingId;
    if(marker===undefined)throw new Error('Task type unavailable');
    if(marker){props.onOpenMeeting?.(task.id,'plan',{membershipId:workerId,requestedPeriodId:fresh.period.id});return;}
    const session = commitmentSession(fresh.period, fresh.packageRow.commitment, workerId);
    session.packageId = task.workPackageId;
    session.key = `plan:${fresh.period.id}:${task.workPackageId}:${workerId}`;
    setPlanDrafts((before) => ({ ...before, [session.key]: before[session.key] ?? session })); setPlanKey(session.key); setPlanOpen(true);
  });
  const editFact = (freshPeriod: PlanningPeriodDto, log: CategorizedManualWorkLogDto | null, taskId: string, targetWorker: string) => {
    const session = factSession(freshPeriod, log, targetWorker, taskId);
    session.key = `fact:${freshPeriod.id}:${taskId}:${targetWorker}`;
    setFactDrafts((before) => ({ ...before, [session.key]: before[session.key] ?? session })); setFactKey(session.key); setFactOpen(true); setBreakdown(null);
  };
  const openFact = (task: TaskDto) => void read(async () => {
    const fresh = await loadRow(task.id);
    if (!alive.current) return;
    const marker=fresh.taskRow.meetingId===undefined?(await fetchTask(workspace.id,task.id)).meetingId:fresh.taskRow.meetingId;
    if(marker===undefined)throw new Error('Task type unavailable');
    if(marker){props.onOpenMeeting?.(task.id,'attendance',{membershipId:workerId,requestedPeriodId:fresh.period.id});return;}
    if (fresh.taskRow.hasOtherSources) {
      const logs = await fetchRecordedWork(workspace.id, fresh.period.id);
      if (alive.current) setBreakdown({ period: fresh.period, task, workerId, packageRow: fresh.packageRow, logs: logs.filter((log) => log.workPackageId === task.workPackageId) });
    } else editFact(fresh.period, fresh.taskRow.ownManualWork, task.id, workerId);
  });
  const openBreakdown = (task: TaskDto) => void read(async () => {
    const fresh = await loadRow(task.id);
    const logs = await fetchRecordedWork(workspace.id, fresh.period.id);
    if (alive.current) setBreakdown({ period: fresh.period, task, workerId, packageRow: fresh.packageRow, logs: logs.filter((log) => log.workPackageId === task.workPackageId) });
  });
  const editExistingLog = (log: RecordedWorkLogDto, targetPeriod: PlanningPeriodDto) => void read(async () => {
    if(log.sourceKind==='meeting_attendance'){setBreakdown(null);props.onOpenMeeting?.(log.taskId,'attendance',{membershipId:log.membershipId,attendanceId:log.attendanceId,requestedPeriodId:log.periodId});return;}
    const fresh = await loadRow(log.taskId, targetPeriod.id, log.membershipId);
    if (alive.current) editFact(fresh.period, fresh.taskRow.ownManualWork, log.taskId, log.membershipId);
  });
  const openCategory = (session: FactSession) => void read(async () => {
    const [fresh, binding] = await Promise.all([loadRow(session.taskId, session.period.id, session.membershipId), fetchWorkCategoryBinding(workspace.id, project.id)]);
    if (!fresh.taskRow.ownManualWork || !alive.current) return;
    const next = recategorizeSession(fresh.taskRow.ownManualWork, binding, props.tasks.find((task) => task.id === session.taskId)?.title ?? 'Задача этой записи', props.members.find((member) => member.id === session.membershipId)?.displayName ?? 'Сохранённый участник');
    setCategoryDrafts((before) => ({ ...before, [next.key]: before[next.key] ?? next })); setCategoryKey(next.key); setCategoryOpen(true); setFactOpen(false);
  });
  const heldNotices = [
    ...(['createCommitment', 'updateCommitment'] as const).flatMap((kind) => {
      const mutation = commands[kind]; const variables = mutation.pendingCommand?.variables ?? mutation.uncertain?.variables;
      if (!variables) return [];
      const session = Object.values(planDrafts).find((item) => item.period.id === variables.periodId && ('commitmentId' in variables ? item.base?.id === variables.commitmentId : item.packageId === variables.input.workPackageId && item.membershipId === variables.input.membershipId));
      return session ? [{ key: kind, pending: mutation.pendingCommand !== null, label: 'Личный недельный план', resume: () => { lens(session.period.id, session.membershipId); setPlanKey(session.key); setPlanOpen(true); } }] : [];
    }),
    ...(() => {
      const variables = commands.setFact.pendingCommand?.variables ?? commands.setFact.uncertain?.variables;
      const session = variables ? Object.values(factDrafts).find((item) => item.period.id === variables.periodId && item.taskId === variables.taskId && item.membershipId === variables.membershipId) : undefined;
      return session ? [{ key: 'fact', pending: commands.setFact.pendingCommand !== null, label: 'Факт за неделю', resume: () => { lens(session.period.id, session.membershipId); setFactKey(session.key); setFactOpen(true); } }] : [];
    })(),
    ...(() => {
      const variables = categoryCommands.recategorize.pendingCommand?.variables ?? categoryCommands.recategorize.uncertain?.variables;
      const session = variables ? categoryDrafts[variables.workLogId] : undefined;
      return session ? [{ key: 'category', pending: categoryCommands.recategorize.pendingCommand !== null, label: 'Тип записанной работы', resume: () => { lens(session.log.periodId, session.log.membershipId); setCategoryKey(session.key); setCategoryOpen(true); } }] : [];
    })(),
  ];
  const representative = new Map<string, string>();
  for (const task of props.tasks) if (!representative.has(task.workPackageId)) representative.set(task.workPackageId, task.id);
  const ready = period.isSuccess && period.data.projectId === project.id && !projection.isPending && projection.error === null && !denied;
  const cellUnavailable = () => <span className="text-xs text-muted">{projection.isPending || period.isPending ? 'Загрузка…' : 'Часы не загружены'}</span>;
  const columns: TaskTableCustomColumn[] = periodId ? [
    { id: 'weekly-plan', label: `План недели · ${workerName}`, width: 215, renderCell: (task) => {
      if (!ready) return cellUnavailable();
      const row = projection.tasks.get(task.id); const work = projection.packages.get(task.workPackageId);
      if (!row || !work) return cellUnavailable();
      return <div className="space-y-1 py-1"><Button variant="ghost" size="sm" aria-label={`План недели: ${task.title}`} disabled={opening} onClick={() => openPlan(task)}>{row.currentAllocationMinutes === null ? 'Не распределено' : formatEstimate(row.currentAllocationMinutes)}</Button>{representative.get(task.workPackageId) === task.id ? <p className="text-[11px] leading-relaxed text-muted">{work.commitment ? <>{work.commitment.state === 'removed' ? 'Снят с текущего плана · ранее: ' : 'Личный план целиком: '}{work.commitment.plannedMinutes === null ? 'не задан' : formatEstimate(work.commitment.plannedMinutes)}<br />{work.commitment.state === 'removed' ? 'Прежний остаток: ' : 'Нераспределено: '}{work.commitment.unallocatedMinutes === null ? 'неизвестно' : formatEstimate(work.commitment.unallocatedMinutes)}{work.commitment.baselineIds.length ? ' · зафиксирован' : ''}{work.commitment.classification === 'added' ? ' · добавлен после фиксации' : ''}</> : 'Личный план ещё не добавлен'}</p> : null}</div>;
    } },
    { id: 'weekly-fact', label: `Факт недели · ${workerName}`, width: 215, renderCell: (task) => {
      if (!ready) return cellUnavailable();
      const row = projection.tasks.get(task.id); const work = projection.packages.get(task.workPackageId);
      if (!row || !work) return cellUnavailable();
      return <div className="space-y-1 py-1"><Button variant="ghost" size="sm" aria-label={`Факт недели: ${task.title}`} disabled={opening} onClick={() => openFact(task)}>{row.subjectActiveSourceCount === 0 ? 'Не внесено' : formatEstimate(row.subjectActualMinutes)}</Button>{row.ownManualWork?.state === 'active' ? <CategoryBadge category={row.ownManualWork.category} /> : null}{representative.get(task.workPackageId) === task.id ? <button type="button" className="block rounded text-left text-[11px] text-muted underline decoration-dotted underline-offset-2" disabled={opening} onClick={() => openBreakdown(task)}>По работе целиком: {work.subjectActiveSourceCount === 0 ? 'не внесено' : formatEstimate(work.subjectActualMinutes)}</button> : null}</div>;
    } },
  ] : [];

  const controls = <section aria-label="Недельные часы в таблице" className="space-y-3 rounded-xl border border-line bg-surface p-4">
    <div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><label htmlFor="task-time-week" className="text-sm font-medium">Неделя для часов</label><select id="task-time-week" className={inputClassName()} value={periodId} onChange={(event) => lens(event.target.value, workerId)}><option value="">Выберите неделю явно</option>{sortPlanningPeriods(periods.data ?? []).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.localStart}</option>)}</select></div><div className="space-y-1.5"><label htmlFor="task-time-worker" className="text-sm font-medium">Чьи часы в таблице</label><select id="task-time-worker" className={inputClassName()} value={workerId} onChange={(event) => lens(periodId, event.target.value)}>{props.members.map((member) => <option key={member.id} value={member.id}>{member.displayName}{member.id === ownMembershipId ? ' · мои' : ''}</option>)}</select></div></div>
    <p className="text-xs leading-relaxed text-muted">Выбор человека меняет показанные часы, а не список задач и не действующего пользователя. Общая оценка задачи остаётся отдельной.{periodId && !canWriteSubject ? ' Эти личные часы доступны вам для просмотра.' : ''}</p>
    {periods.isError ? <QueryErrorState error={periods.error} subject="planning" headingLevel={3} retrying={periods.isFetching} onRetry={() => void periods.refetch()} /> : null}
    {periodId && (period.isError || projection.error) ? <QueryErrorState error={period.error ?? projection.error} subject="taskTime" headingLevel={3} retrying={period.isFetching || projection.isFetching} onRetry={() => { void period.refetch(); void projection.refetch(); }} /> : null}
    {accessError && accessError !== period.error && accessError !== projection.error && accessError !== openingError && accessError !== periods.error ? <QueryErrorState error={accessError} subject="taskTime" headingLevel={3} retrying={projection.isFetching || definitions.isFetching} onRetry={() => { for (const mutation of [commands.createCommitment, commands.updateCommitment, commands.setFact, categoryCommands.recategorize]) if (isAccessDenied(mutation.error)) mutation.reset(); void projection.refetch(); void definitions.refetch(); }} /> : null}
    {openingError ? <QueryErrorState error={openingError} subject="taskTime" headingLevel={3} retrying={opening} onRetry={() => setOpeningError(null)} /> : null}
    {heldNotices.map((notice) => <div key={notice.key} role="status" className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><span className="min-w-0 flex-1">{notice.label}: {notice.pending ? 'ждём ответа сервера' : 'результат ещё неизвестен'}. Исходная неделя и человек сохранены.</span><Button size="sm" onClick={notice.resume}>Открыть исходную отправку часов</Button></div>)}
  </section>;
  const contextNote = currentFact ? <div className="space-y-2 rounded-lg bg-canvas p-3 text-xs text-muted">{currentFact.base ? <CategoryBadge category={currentFact.base.category} /> : null}<p>{currentFact.base ? 'Исправление часов сохранит прежний тип этой записи.' : 'Тип новой записи будет взят из поля задачи. Отсутствующий тип сохранится как «Без категории».'}</p>{currentFact.base?.state === 'active' && writable && (canWriteOthers || currentFact.membershipId === ownMembershipId) ? <Button size="sm" disabled={commands.setFact.pendingCommand !== null || commands.setFact.uncertain !== null || opening} onClick={() => openCategory(currentFact)}>Изменить тип записанной работы</Button> : null}</div> : null;
  const dialogs = <>
    <CommitmentDialog session={currentPlan} open={planOpen && !denied} packages={packages.data ?? []} tasks={props.tasks} members={props.members} ownMembershipId={ownMembershipId} canWriteOthers={canWriteOthers} writable={writable} fixedContext commands={commands} loadingMoreTasks={props.loadingMoreTasks} hasMoreTasks={props.hasMoreTasks} onLoadTasks={props.onLoadTasks} onChange={(session) => setPlanDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setPlanOpen(false)} onSaved={(key) => { setPlanDrafts((before) => Object.fromEntries(Object.entries(before).filter(([item]) => item !== key))); if (currentKeys.current.planKey === key) setPlanOpen(false); }} onReload={async (session) => { const fresh = await fetchPeriodCommitments(workspace.id, session.period.id); return fresh.find((item) => item.workPackageId === session.packageId && item.membershipId === session.membershipId) ?? null; }} />
    <FactDialog session={currentFact} open={factOpen && !denied} tasks={props.tasks} members={props.members} ownMembershipId={ownMembershipId} canWriteOthers={canWriteOthers} writable={writable} fixedContext contextNote={contextNote} mutation={commands.setFact} hasMoreTasks={false} loadingMoreTasks={false} onLoadTasks={() => undefined} onChange={(session) => setFactDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setFactOpen(false)} onSaved={(key) => { setFactDrafts((before) => Object.fromEntries(Object.entries(before).filter(([item]) => item !== key))); if (currentKeys.current.factKey === key) setFactOpen(false); }} onReload={async (session) => { const fresh = await loadRow(session.taskId, session.period.id, session.membershipId); return fresh.taskRow.ownManualWork; }} />
    <RecategorizeDialog session={currentCategory} open={categoryOpen && !denied} field={definitions.data?.find((field) => field.id === currentCategory?.binding.fieldId) ?? null} writable={writable && (canWriteOthers || currentCategory?.log.membershipId === ownMembershipId)} mutation={categoryCommands.recategorize} onChange={(session) => setCategoryDrafts((before) => ({ ...before, [session.key]: session }))} onClose={() => setCategoryOpen(false)} onSaved={(key) => { setCategoryDrafts((before) => Object.fromEntries(Object.entries(before).filter(([item]) => item !== key))); if (currentKeys.current.categoryKey === key) setCategoryOpen(false); }} onReload={async (session) => { const [fresh, binding] = await Promise.all([loadRow(session.log.taskId, session.log.periodId, session.log.membershipId), fetchWorkCategoryBinding(workspace.id, project.id)]); if (!fresh.taskRow.ownManualWork) throw new Error('Work record unavailable'); return { log: fresh.taskRow.ownManualWork, binding }; }} />
    <DialogShell title="Из чего сложились часы" description={breakdown ? `${breakdown.task.title} · ${breakdown.period.name}. Итоги рассчитаны по всей доступной работе, включая незагруженные дочерние задачи.` : 'Состав недельных часов.'} open={breakdown !== null && !denied} onOpenChange={(next) => { if (!next) setBreakdown(null); }}>
      {breakdown ? <div className="mt-5 space-y-4"><dl className="space-y-2 text-sm"><div><dt className="text-muted">Выбранный человек, вся работа</dt><dd className="font-semibold">{breakdown.packageRow.subjectActiveSourceCount ? formatEstimate(breakdown.packageRow.subjectActualMinutes) : 'Не внесено'}</dd></div><div><dt className="text-muted">Все люди, вся работа</dt><dd className="font-semibold">{breakdown.packageRow.totalActiveSourceCount ? formatEstimate(breakdown.packageRow.totalActualMinutes) : 'Не внесено'}</dd></div></dl><p className="text-xs text-muted">Эти суммы нельзя заменить одной ручной записью. Выберите конкретный источник ниже.</p>{breakdown.logs.map((log) => <div key={log.id} className="space-y-2 rounded-lg border border-line p-3 text-sm"><p className="font-medium">{props.tasks.find((task) => task.id === log.taskId)?.title ?? 'Задача этой записи'}</p><p className="text-xs text-muted">{props.members.find((member) => member.id === log.membershipId)?.displayName ?? 'Сохранённый участник'} · {formatEstimate(log.minutes)} · {log.state === 'void' ? 'отменено' : <RecordedWorkLabel log={log}/>}</p><CategoryBadge category={log.category} />{writable && (canWriteOthers || log.membershipId === ownMembershipId) ? <Button size="sm" disabled={opening} onClick={() => editExistingLog(log, breakdown.period)}>Изменить эту запись факта</Button> : null}</div>)}<Link to={`/w/${workspace.id}/projects/${project.id}/week?period=${breakdown.period.id}`} className="block rounded text-sm font-medium text-accent-ink">Открыть недельный план и отчёты</Link></div> : null}
    </DialogShell>
  </>;
  return { controls, columns, dialogs };
}
