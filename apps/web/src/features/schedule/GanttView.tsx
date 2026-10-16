import { t, useTranslation } from '../../i18n';
import type { BaselineDateValueDto, MembershipDto, PlanningPeriodDto, ProjectDto, TaskDto, WorkspaceDto } from '@workloom/contracts';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { isAccessDenied } from '../../lib/api';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { useQueryClient } from '@tanstack/react-query';
import { planningKeys, usePlanBaselinesQuery } from '../planning/queries';
import { calendarWindow, clipDates, shiftDay, windowDays, type CalendarWindow } from './dates';
import { useScheduleContext } from './queries';
import type { ScheduleWorkspace } from './useScheduleWorkspace';
import { ComparisonList } from './ComparisonList';

const baselineValue = (value: BaselineDateValueDto, start: boolean) => value.state === 'set' ? value.value : value.state === 'not_set' ? t('schedule.ganttView.notSet') : start ? t('schedule.ganttView.startDateWasNotCapturedInThisPlan') : t('schedule.ganttView.dueDateWasNotCapturedInThisPlan');
export function ScheduleBar({ start, due, window, baseline = false, onFocus, startLabel, dueLabel, incomplete = false }: { start: string | null; due: string | null; window: CalendarWindow; baseline?: boolean; startLabel?: string; dueLabel?: string; incomplete?: boolean; onFocus: (date: string) => void }) {
  const { t } = useTranslation();
  const clipped = clipDates(start, due, window);
  const label = t('schedule.ganttView.valueStartValueDueValue', { p0: baseline ? t('schedule.ganttView.frozenDatesLabel') : t('schedule.ganttView.current'), p1: startLabel ?? start ?? t('schedule.ganttView.notSet'), p2: dueLabel ?? due ?? t('schedule.ganttView.notSet') });
  return <div aria-label={label} className={`relative h-7 ${baseline ? 'mt-1' : ''}`}>
    {clipped.kind === 'range' ? <div role="img" aria-label={label} className={`absolute top-1 flex h-5 items-center justify-between overflow-hidden rounded ${baseline ? 'border border-dashed border-slate-500 bg-slate-100' : 'bg-indigo-500 text-white'}`} style={{ left: `${clipped.left}%`, width: `${clipped.width}%`, minWidth: 2 }}><span aria-hidden="true">{clipped.continuesBefore ? '‹' : ''}</span><span aria-hidden="true">{clipped.continuesAfter ? '›' : ''}</span></div> : clipped.kind === 'point' ? <span role="img" aria-label={t('schedule.ganttView.valueOnlyValue', { p0: label, p1: clipped.endpoint === 'start' ? t('schedule.ganttView.startDate') : t('schedule.ganttView.dueDate') })} className={`absolute top-1 size-4 -translate-x-1/2 rotate-45 rounded-sm ${baseline ? 'border border-slate-500 bg-slate-100' : 'bg-indigo-500'}`} style={{ left: `${clipped.left}%` }} /> : clipped.kind === 'outside' ? <button type="button" className="rounded text-xs text-muted underline" onClick={() => onFocus(clipped.endpoint)}>{t('schedule.ganttView.outsideWindowShowDate')}</button> : <span className="text-xs text-muted">{clipped.kind === 'none' ? incomplete ? t('schedule.ganttView.datesWereNotFullyCaptured') : t('schedule.ganttView.noDates') : t('schedule.ganttView.checkDates')}</span>}
  </div>;
}
export function GanttView({ actorId, workspace, project, tasks, selectedIds, onSelect, periods, members, controller: c, writable, hasMore, loadingMore, onLoadMore, onOpen }: {
  actorId: string; workspace: WorkspaceDto; project: ProjectDto; tasks: readonly TaskDto[]; selectedIds: readonly string[]; onSelect: (id: string, selected: boolean) => void;
  periods: readonly PlanningPeriodDto[]; members: readonly MembershipDto[]; controller: ScheduleWorkspace; writable: boolean; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [checkingAccess, setCheckingAccess] = useState(false);
  const context = useScheduleContext(actorId, workspace.id, project.id, tasks.map(task => task.id), c.baselineId);
  const baselines = usePlanBaselinesQuery(actorId, workspace.id, c.baselinePeriodId);
  const noteReadDenied = c.noteReadDenied;
  const authoritativeDenial = context.anyAccessDenied || isAccessDenied(baselines.error);
  useLayoutEffect(() => { if (authoritativeDenial) noteReadDenied(); }, [authoritativeDenial, noteReadDenied]);
  const window = calendarWindow(c.windowStart, c.windowSize);
  const denied = c.denied || context.anyAccessDenied || isAccessDenied(context.error) || isAccessDenied(baselines.error);
  const accessScope = `${[...tasks.map(task => task.id)].sort().join(',')}:${c.baselinePeriodId}:${c.baselineId}`;
  const currentAccessScope = useRef(accessScope); currentAccessScope.current = accessScope;
  const checkAccess = async () => {
    setCheckingAccess(true);
    try {
      const results = await Promise.all([context.refetch(), ...(c.baselinePeriodId ? [baselines.refetch().then(result => result.isSuccess)] : [])]);
      if (results.every(Boolean)) await c.clearDenial(() => currentAccessScope.current === accessScope && context.accessConfirmed() && (!c.baselinePeriodId || queryClient.getQueryState(planningKeys.baselines(actorId, workspace.id, c.baselinePeriodId))?.status === 'success'));
    } finally { setCheckingAccess(false); }
  };
  if (denied) return <section className="space-y-3 rounded-xl border border-line p-4"><p role="alert" className="text-sm text-muted">{t('schedule.ganttView.timelineAndFrozenPlanAreHiddenBecauseAccess')}</p><Button disabled={checkingAccess || context.fetching || baselines.isFetching} onClick={() => void checkAccess()}>{t('schedule.ganttView.checkTimelineAccess')}</Button></section>;
  const selectedPlan = baselines.data?.find(plan => plan.id === c.baselineId);
  const names = new Map(tasks.map(task => [task.id, task.title]));
  const selected = tasks.filter(task => selectedIds.includes(task.id));
  const hiddenSelection = selected.length !== selectedIds.length;
  const ordered = [...tasks].sort((a, b) => {
    const x = context.rows.get(a.id)?.current, y = context.rows.get(b.id)?.current;
    return Number(!x?.startDate && !x?.dueDate) - Number(!y?.startDate && !y?.dueDate);
  });
  return <section aria-label={t('schedule.ganttView.projectTimeline')} className="min-w-0 space-y-4">
    <header className="space-y-2"><h2 className="text-lg font-semibold">{t('schedule.ganttView.timelineGantt')}</h2><p className="text-sm text-muted">{t('schedule.ganttView.fromLoadedTasks')}{tasks.length}{hasMore ? t('schedule.ganttView.morePagesAvailable') : ''}{t('schedule.ganttView.datesDoNotChangeTheTeamEstimatePersonal')}</p></header>
    <div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm font-medium">{t('schedule.ganttView.windowStart')}<TextInput type="date" min="0001-01-01" max="9999-12-31" value={c.windowStart} onChange={e => c.setWindowStart(e.target.value)} /></label><label className="space-y-1 text-sm font-medium">{t('schedule.ganttView.daysInWindow')}<select className={inputClassName('w-auto')} value={c.windowSize} onChange={e => c.setWindowSize(Number(e.target.value))}><option value={28}>{t('schedule.ganttView.28Days')}</option><option value={84}>{t('schedule.ganttView.84Days')}</option><option value={366}>{t('schedule.ganttView.366Days')}</option></select></label><Button disabled={shiftDay(c.windowStart, -c.windowSize) === null} onClick={() => { const date = shiftDay(c.windowStart, -c.windowSize); if (date) c.setWindowStart(date); }}>{t('schedule.ganttView.previousWindow')}</Button><Button disabled={shiftDay(c.windowStart, c.windowSize) === null} onClick={() => { const date = shiftDay(c.windowStart, c.windowSize); if (date) c.setWindowStart(date); }}>{t('schedule.ganttView.nextWindow')}</Button></div>
    {window ? <p className="text-xs text-muted">{t('schedule.ganttView.showing')}{window.start} — {window.end}{t('schedule.ganttView.inclusiveCalendarDates')}{workspace.timezone}{t('schedule.ganttView.windowIsIndependentOfTaskDates')}</p> : <p role="alert" className="text-sm text-red-800">{t('schedule.ganttView.enterADateFrom00010101To')}</p>}
    <section aria-label={t('schedule.ganttView.compareWithAFrozenPlan')} className="space-y-3 rounded-xl border border-line p-4"><h3 className="text-sm font-semibold">{t('schedule.ganttView.frozenPlan')}</h3><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">{t('schedule.ganttView.planPeriod')}<select className={inputClassName()} value={c.baselinePeriodId} onChange={e => { c.setBaselinePeriodId(e.target.value); c.setBaselineId(''); }}><option value="">{t('schedule.ganttView.chooseAPeriodToCompare')}</option>{[...periods].sort((a, b) => b.localStart.localeCompare(a.localStart)).map(period => <option key={period.id} value={period.id}>{period.name} · {period.localStart}</option>)}</select></label><label className="space-y-1 text-sm font-medium">{t('schedule.ganttView.frozenPlanToCompare')}<select className={inputClassName()} value={c.baselineId} disabled={!c.baselinePeriodId || !baselines.isSuccess} onChange={e => c.setBaselineId(e.target.value)}><option value="">{t('schedule.ganttView.noComparison')}</option>{(baselines.data ?? []).map(baseline => <option key={baseline.id} value={baseline.id}>{baseline.scope === 'project' ? t('schedule.ganttView.project') : members.find(member => member.id === baseline.membershipId)?.displayName ?? t('schedule.ganttView.personal')} · {baseline.frozenAt.replace('T', ' ').replace('Z', ' UTC')}</option>)}</select></label></div>{baselines.error && c.baselinePeriodId ? <QueryErrorState error={baselines.error} subject="tasks" headingLevel={3} onRetry={() => void baselines.refetch()} /> : null}
      {context.baseline ? <details><summary className="cursor-pointer text-xs font-medium">{t('schedule.ganttView.planSourcesAndCoverage')}</summary><p className="mt-2 text-xs text-muted">{context.baseline.scope === 'project' ? t('schedule.ganttView.projectPlan') : t('schedule.ganttView.personalPlan')} · {context.baseline.scope === 'self' ? members.find(member => member.id === context.baseline?.membershipId)?.displayName ?? t('schedule.ganttView.memberUnavailable') : t('schedule.ganttView.membersFromTheOriginalFreeze')} · {selectedPlan?.snapshot.period.name ?? t('schedule.ganttView.savedPeriod')} {t('schedule.ganttView.period')}{selectedPlan?.snapshot.period.localStart ?? t('schedule.ganttView.fromTheSelectedPlan')}{t('schedule.ganttView.frozen')}{context.baseline.frozenAt.replace('T', ' ').replace('Z', ' UTC')}{t('schedule.ganttView.coversTasksInSavedCommitmentsNotTheEntire')}</p>{context.baseline.sourcePersonalBaselineIds.length ? <ul className="mt-2 space-y-1 text-xs text-muted">{context.baseline.sourcePersonalBaselineIds.map((id, index) => { const source = baselines.data?.find(plan => plan.id === id); const savedMember = source?.snapshot.memberships.find(member => member.id === source.membershipId); return <li key={id}>{source ? t('schedule.ganttView.personalSourceValueValueValue', { p0: savedMember?.displayName ?? t('schedule.ganttView.originalPlanMember'), p1: source.snapshot.period.name, p2: source.frozenAt.replace('T', ' ').replace('Z', ' UTC') }) : t('schedule.ganttView.personalSourceValueDetailsNotLoaded', { p0: index + 1 })}</li>; })}</ul> : <p className="mt-2 text-xs text-muted">{t('schedule.ganttView.noLinkedPersonalSources')}</p>}</details> : <p className="text-xs text-muted">{t('schedule.ganttView.chooseAPlanExplicitlyDatesMissingFromAn')}</p>}</section>
    {writable && selectedIds.length ? <div className="space-y-2"><Button disabled={hiddenSelection || context.pending || !!context.error || selected.length > 100} onClick={() => c.open(selected, context.rows)}>{t('schedule.ganttView.editSelectedDateCount', { count: selectedIds.length })}</Button>{hiddenSelection ? <p className="text-xs text-muted">{t('schedule.ganttView.someSelectedTasksAreHiddenByTheCurrent')}</p> : null}</div> : null}
    {context.error ? <QueryErrorState error={context.error} subject="tasks" headingLevel={3} onRetry={() => void context.refetch()} /> : context.pending ? <p role="status" className="text-sm text-muted">{t('schedule.ganttView.loadingCurrentDates')}</p> : window ? <div className="relative max-w-full overflow-x-auto rounded-xl border border-line" aria-label={t('schedule.ganttView.loadedTaskCalendar')} tabIndex={0}>
      <div style={{ width: 240 + window.days * 24 }}>
        <div className="flex border-b border-line bg-canvas"><div className="sticky left-0 z-10 w-60 shrink-0 border-r border-line bg-canvas p-3 text-sm font-medium">{t('schedule.ganttView.taskOriginalDates')}</div><ol aria-label={t('schedule.ganttView.calendarWindowDays')} className="flex min-w-0 flex-1">{windowDays(window).map(day => <li key={day} title={day} className="w-6 shrink-0 border-r border-line py-3 text-center text-[10px] text-muted">{day.slice(8)}</li>)}</ol></div>
        {ordered.map(task => {
          const row = context.rows.get(task.id);
          if (!row) return <div key={task.id} className="p-3 text-xs text-muted">{t('schedule.ganttView.taskDatesHaveNotLoadedYet')}</div>;
          const base = row.baselineDates;
          const baseStart = base.state === 'captured' && base.startDate.state === 'set' ? base.startDate.value : null;
          const baseDue = base.state === 'captured' && base.dueDate.state === 'set' ? base.dueDate.value : null;
          return <div key={task.id} role="group" aria-label={t('schedule.ganttView.calendarDatesValue', { p0: task.title })} className="flex border-b border-line last:border-b-0">
            <div className="sticky left-0 z-10 w-60 shrink-0 space-y-2 border-r border-line bg-surface p-3"><div className="flex items-start gap-2"><input type="checkbox" aria-label={t('schedule.ganttView.selectDatesValue', { p0: task.title })} checked={selectedIds.includes(task.id)} disabled={!selectedIds.includes(task.id) && selectedIds.length >= 100} onChange={e => onSelect(task.id, e.target.checked)} /><button type="button" className="min-w-0 rounded text-left text-sm font-medium text-accent-ink underline [overflow-wrap:anywhere]" onClick={() => onOpen(task.id)}>{task.title}</button></div>
              {row.meetingId ? <Button size="sm" onClick={() => onOpen(task.id)}>{t('schedule.ganttView.meetingOpenCalendar')}</Button> : <><p className="text-xs text-muted">{t('schedule.ganttView.startValue', { date: row.current.startDate ?? t('schedule.ganttView.notSet') })}<br />{t('schedule.ganttView.dueValue', { date: row.current.dueDate ?? t('schedule.ganttView.notSet') })}</p>{writable && row.editableDates ? <Button size="sm" onClick={() => c.open([task], context.rows)}>{t('schedule.ganttView.editDates')}</Button> : <p className="text-xs text-muted">{t('schedule.ganttView.datesCannotBeEdited')}</p>}</>}
              {base.state === 'not_in_baseline' ? <p className="text-xs text-muted">{t('schedule.ganttView.taskIsNotIncludedInThisPlan')}</p> : base.state === 'captured' ? <p className="text-xs text-muted">{t('schedule.ganttView.planStartValue', { date: baselineValue(base.startDate, true) })}<br />{t('schedule.ganttView.dueValue', { date: baselineValue(base.dueDate, false) })}</p> : null}
            </div>
            <div className="min-w-0 flex-1 bg-[linear-gradient(to_right,#e2e8f0_1px,transparent_1px)] p-0" style={{ backgroundSize: '24px 100%' }}><div className="py-3">{row.meetingId ? <p className="px-2 text-xs text-muted">{t('schedule.ganttView.meetingScheduleIsInTheCalendarWithoutA')}</p> : <ScheduleBar start={row.current.startDate} due={row.current.dueDate} window={window} onFocus={c.setWindowStart} />}{base.state === 'captured' && !row.meetingId ? <ScheduleBar start={baseStart} due={baseDue} startLabel={baselineValue(base.startDate, true)} dueLabel={baselineValue(base.dueDate, false)} incomplete={base.startDate.state === 'not_captured' || base.dueDate.state === 'not_captured'} window={window} baseline onFocus={c.setWindowStart} /> : null}{row.blocking.isBlocked ? <p className="px-2 text-xs text-amber-900">{t('schedule.ganttView.unfinishedPredecessorCount', { count: row.blocking.unresolvedCount })}</p> : null}</div></div>
          </div>;
        })}
      </div></div> : null}
    {tasks.length === 0 ? <p className="text-sm text-muted">{t('schedule.ganttView.noTasksMatchTheCurrentFilter')}</p> : null}
    {hasMore ? <Button disabled={loadingMore} onClick={onLoadMore}>{t('schedule.ganttView.loadMoreTimelineTasks')}</Button> : null}
    <ComparisonList comparisons={context.comparisons} names={names} workspaceId={workspace.id} />
  </section>;
}
