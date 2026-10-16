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

const baselineValue = (value: BaselineDateValueDto, start: boolean) => value.state === 'set' ? value.value : value.state === 'not_set' ? 'Не задана' : start ? 'Дата начала не сохранялась в этом плане' : 'Срок не сохранялся в этом плане';
export function ScheduleBar({ start, due, window, baseline = false, onFocus, startLabel, dueLabel, incomplete = false }: { start: string | null; due: string | null; window: CalendarWindow; baseline?: boolean; startLabel?: string; dueLabel?: string; incomplete?: boolean; onFocus: (date: string) => void }) {
  const clipped = clipDates(start, due, window);
  const label = `${baseline ? 'Зафиксировано' : 'Сейчас'}: начало ${startLabel ?? start ?? 'не задано'}, срок ${dueLabel ?? due ?? 'не задан'}`;
  return <div aria-label={label} className={`relative h-7 ${baseline ? 'mt-1' : ''}`}>
    {clipped.kind === 'range' ? <div role="img" aria-label={label} className={`absolute top-1 flex h-5 items-center justify-between overflow-hidden rounded ${baseline ? 'border border-dashed border-slate-500 bg-slate-100' : 'bg-indigo-500 text-white'}`} style={{ left: `${clipped.left}%`, width: `${clipped.width}%`, minWidth: 2 }}><span aria-hidden="true">{clipped.continuesBefore ? '‹' : ''}</span><span aria-hidden="true">{clipped.continuesAfter ? '›' : ''}</span></div> : clipped.kind === 'point' ? <span role="img" aria-label={`${label}; только ${clipped.endpoint === 'start' ? 'начало' : 'срок'}`} className={`absolute top-1 size-4 -translate-x-1/2 rotate-45 rounded-sm ${baseline ? 'border border-slate-500 bg-slate-100' : 'bg-indigo-500'}`} style={{ left: `${clipped.left}%` }} /> : clipped.kind === 'outside' ? <button type="button" className="rounded text-xs text-muted underline" onClick={() => onFocus(clipped.endpoint)}>Вне окна · показать дату</button> : <span className="text-xs text-muted">{clipped.kind === 'none' ? incomplete ? 'Даты не сохранялись полностью' : 'Без дат' : 'Проверьте даты'}</span>}
  </div>;
}
export function GanttView({ actorId, workspace, project, tasks, selectedIds, onSelect, periods, members, controller: c, writable, hasMore, loadingMore, onLoadMore, onOpen }: {
  actorId: string; workspace: WorkspaceDto; project: ProjectDto; tasks: readonly TaskDto[]; selectedIds: readonly string[]; onSelect: (id: string, selected: boolean) => void;
  periods: readonly PlanningPeriodDto[]; members: readonly MembershipDto[]; controller: ScheduleWorkspace; writable: boolean; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onOpen: (id: string) => void;
}) {
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
  if (denied) return <section className="space-y-3 rounded-xl border border-line p-4"><p role="alert" className="text-sm text-muted">Сроки и зафиксированный план скрыты: доступ не подтверждён.</p><Button disabled={checkingAccess || context.fetching || baselines.isFetching} onClick={() => void checkAccess()}>Проверить доступ к срокам</Button></section>;
  const selectedPlan = baselines.data?.find(plan => plan.id === c.baselineId);
  const names = new Map(tasks.map(task => [task.id, task.title]));
  const selected = tasks.filter(task => selectedIds.includes(task.id));
  const hiddenSelection = selected.length !== selectedIds.length;
  const ordered = [...tasks].sort((a, b) => {
    const x = context.rows.get(a.id)?.current, y = context.rows.get(b.id)?.current;
    return Number(!x?.startDate && !x?.dueDate) - Number(!y?.startDate && !y?.dueDate);
  });
  return <section aria-label="Сроки проекта" className="min-w-0 space-y-4">
    <header className="space-y-2"><h2 className="text-lg font-semibold">Сроки · Гант</h2><p className="text-sm text-muted">Из загруженных задач: {tasks.length}{hasMore ? ' · есть следующие страницы' : ''}. Даты не меняют оценку задачи, личный план или факт.</p></header>
    <div className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm font-medium">Начало окна<TextInput type="date" min="0001-01-01" max="9999-12-31" value={c.windowStart} onChange={e => c.setWindowStart(e.target.value)} /></label><label className="space-y-1 text-sm font-medium">Дней в окне<select className={inputClassName('w-auto')} value={c.windowSize} onChange={e => c.setWindowSize(Number(e.target.value))}><option value={28}>28 дней</option><option value={84}>84 дня</option><option value={366}>366 дней</option></select></label><Button disabled={shiftDay(c.windowStart, -c.windowSize) === null} onClick={() => { const date = shiftDay(c.windowStart, -c.windowSize); if (date) c.setWindowStart(date); }}>Предыдущее окно</Button><Button disabled={shiftDay(c.windowStart, c.windowSize) === null} onClick={() => { const date = shiftDay(c.windowStart, c.windowSize); if (date) c.setWindowStart(date); }}>Следующее окно</Button></div>
    {window ? <p className="text-xs text-muted">Показано {window.start} — {window.end}, включительно. Календарные даты · {workspace.timezone}; окно не зависит от дат задач.</p> : <p role="alert" className="text-sm text-red-800">Укажите дату от 0001-01-01 до 9999-12-31. Максимум 366 дней.</p>}
    <section aria-label="Сравнение с зафиксированным планом" className="space-y-3 rounded-xl border border-line p-4"><h3 className="text-sm font-semibold">Зафиксированный план</h3><div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm font-medium">Период плана<select className={inputClassName()} value={c.baselinePeriodId} onChange={e => { c.setBaselinePeriodId(e.target.value); c.setBaselineId(''); }}><option value="">Выберите период для сравнения</option>{[...periods].sort((a, b) => b.localStart.localeCompare(a.localStart)).map(period => <option key={period.id} value={period.id}>{period.name} · {period.localStart}</option>)}</select></label><label className="space-y-1 text-sm font-medium">Зафиксированный план для сравнения<select className={inputClassName()} value={c.baselineId} disabled={!c.baselinePeriodId || !baselines.isSuccess} onChange={e => c.setBaselineId(e.target.value)}><option value="">Без сравнения</option>{(baselines.data ?? []).map(baseline => <option key={baseline.id} value={baseline.id}>{baseline.scope === 'project' ? 'Проектный' : members.find(member => member.id === baseline.membershipId)?.displayName ?? 'Личный'} · {baseline.frozenAt.replace('T', ' ').replace('Z', ' UTC')}</option>)}</select></label></div>{baselines.error && c.baselinePeriodId ? <QueryErrorState error={baselines.error} subject="tasks" headingLevel={3} onRetry={() => void baselines.refetch()} /> : null}
      {context.baseline ? <details><summary className="cursor-pointer text-xs font-medium">Происхождение и покрытие плана</summary><p className="mt-2 text-xs text-muted">{context.baseline.scope === 'project' ? 'Проектный план' : 'Личный план'} · {context.baseline.scope === 'self' ? members.find(member => member.id === context.baseline?.membershipId)?.displayName ?? 'Участник недоступен' : 'участники исходной фиксации'} · {selectedPlan?.snapshot.period.name ?? 'Сохранённый период'} · период {selectedPlan?.snapshot.period.localStart ?? 'из выбранного плана'}. Зафиксирован {context.baseline.frozenAt.replace('T', ' ').replace('Z', ' UTC')}. Покрывает задачи сохранённых обязательств, а не весь проект. Даты и состав берутся только из этой фиксации; подписи задач и участников сейчас — текущие.</p>{context.baseline.sourcePersonalBaselineIds.length ? <ul className="mt-2 space-y-1 text-xs text-muted">{context.baseline.sourcePersonalBaselineIds.map((id, index) => { const source = baselines.data?.find(plan => plan.id === id); const savedMember = source?.snapshot.memberships.find(member => member.id === source.membershipId); return <li key={id}>{source ? `Личный источник: ${savedMember?.displayName ?? 'участник исходного плана'} · ${source.snapshot.period.name} · ${source.frozenAt.replace('T', ' ').replace('Z', ' UTC')}` : `Личный источник ${index + 1}: сведения не загружены`}</li>; })}</ul> : <p className="mt-2 text-xs text-muted">Связанных личных источников нет.</p>}</details> : <p className="text-xs text-muted">Выберите план явно. Отсутствующая в старом плане дата не заменяется текущей.</p>}</section>
    {writable && selectedIds.length ? <div className="space-y-2"><Button disabled={hiddenSelection || context.pending || !!context.error || selected.length > 100} onClick={() => c.open(selected, context.rows)}>Изменить даты выбранных ({selectedIds.length})</Button>{hiddenSelection ? <p className="text-xs text-muted">Часть выбранных задач скрыта текущим фильтром. Вернитесь к ним или снимите выбор; скрытые задачи не исключаются из изменения автоматически.</p> : null}</div> : null}
    {context.error ? <QueryErrorState error={context.error} subject="tasks" headingLevel={3} onRetry={() => void context.refetch()} /> : context.pending ? <p role="status" className="text-sm text-muted">Загружаем текущие сроки…</p> : window ? <div className="relative max-w-full overflow-x-auto rounded-xl border border-line" aria-label="Календарь загруженных задач" tabIndex={0}>
      <div style={{ width: 240 + window.days * 24 }}>
        <div className="flex border-b border-line bg-canvas"><div className="sticky left-0 z-10 w-60 shrink-0 border-r border-line bg-canvas p-3 text-sm font-medium">Задача · исходные даты</div><ol aria-label="Дни календарного окна" className="flex min-w-0 flex-1">{windowDays(window).map(day => <li key={day} title={day} className="w-6 shrink-0 border-r border-line py-3 text-center text-[10px] text-muted">{day.slice(8)}</li>)}</ol></div>
        {ordered.map(task => {
          const row = context.rows.get(task.id);
          if (!row) return <div key={task.id} className="p-3 text-xs text-muted">Сроки задачи ещё не загружены.</div>;
          const base = row.baselineDates;
          const baseStart = base.state === 'captured' && base.startDate.state === 'set' ? base.startDate.value : null;
          const baseDue = base.state === 'captured' && base.dueDate.state === 'set' ? base.dueDate.value : null;
          return <div key={task.id} role="group" aria-label={`Календарные сроки: ${task.title}`} className="flex border-b border-line last:border-b-0">
            <div className="sticky left-0 z-10 w-60 shrink-0 space-y-2 border-r border-line bg-surface p-3"><div className="flex items-start gap-2"><input type="checkbox" aria-label={`Выбрать сроки: ${task.title}`} checked={selectedIds.includes(task.id)} disabled={!selectedIds.includes(task.id) && selectedIds.length >= 100} onChange={e => onSelect(task.id, e.target.checked)} /><button type="button" className="min-w-0 rounded text-left text-sm font-medium text-accent-ink underline [overflow-wrap:anywhere]" onClick={() => onOpen(task.id)}>{task.title}</button></div>
              {row.meetingId ? <Button size="sm" onClick={() => onOpen(task.id)}>Встреча — открыть календарь</Button> : <><p className="text-xs text-muted">Начало: {row.current.startDate ?? 'Не задана'}<br />Срок: {row.current.dueDate ?? 'Не задан'}</p>{writable && row.editableDates ? <Button size="sm" onClick={() => c.open([task], context.rows)}>Изменить даты</Button> : <p className="text-xs text-muted">Даты недоступны для изменения.</p>}</>}
              {base.state === 'not_in_baseline' ? <p className="text-xs text-muted">Задача не входит в этот план</p> : base.state === 'captured' ? <p className="text-xs text-muted">План · начало: {baselineValue(base.startDate, true)}<br />Срок: {baselineValue(base.dueDate, false)}</p> : null}
            </div>
            <div className="min-w-0 flex-1 bg-[linear-gradient(to_right,#e2e8f0_1px,transparent_1px)] p-0" style={{ backgroundSize: '24px 100%' }}><div className="py-3">{row.meetingId ? <p className="px-2 text-xs text-muted">Расписание встречи — в календаре, без обычной полосы</p> : <ScheduleBar start={row.current.startDate} due={row.current.dueDate} window={window} onFocus={c.setWindowStart} />}{base.state === 'captured' && !row.meetingId ? <ScheduleBar start={baseStart} due={baseDue} startLabel={baselineValue(base.startDate, true)} dueLabel={baselineValue(base.dueDate, false)} incomplete={base.startDate.state === 'not_captured' || base.dueDate.state === 'not_captured'} window={window} baseline onFocus={c.setWindowStart} /> : null}{row.blocking.isBlocked ? <p className="px-2 text-xs text-amber-900">Незавершённых предшественников: {row.blocking.unresolvedCount}</p> : null}</div></div>
          </div>;
        })}
      </div></div> : null}
    {tasks.length === 0 ? <p className="text-sm text-muted">В текущем фильтре задач нет.</p> : null}
    {hasMore ? <Button disabled={loadingMore} onClick={onLoadMore}>Загрузить ещё задачи для сроков</Button> : null}
    <ComparisonList comparisons={context.comparisons} names={names} workspaceId={workspace.id} />
  </section>;
}
