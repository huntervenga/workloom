import { t, useTranslation } from '../../i18n';
import type { BaselineDateValueDto, MembershipDto, PlanningPeriodDto, PlanBaselineDto, ProjectDto, TaskDto, TaskScheduleContextRowDto, WorkspaceDto } from '@workloom/contracts';
import { useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, TextInput, inputClassName } from '@workloom/ui';
import { isAccessDenied } from '../../lib/api';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { QueryErrorState } from '../../shared/QueryErrorState';
import { useQueryClient } from '@tanstack/react-query';
import { planningKeys, usePlanBaselinesQuery } from '../planning/queries';
import { calendarAxis, calendarWindow, clipDates, fitLoadedWindow, shiftDay, todayIn, windowCoverage, windowOffset, type CalendarWindow, type DatedRange } from './dates';
import { useScheduleContext } from './queries';
import type { ScheduleWorkspace } from './useScheduleWorkspace';
import { ComparisonList } from './ComparisonList';
import { planConnectors, skippedCounts, type ConnectorPlan, type ConnectorRow } from './connectors';
import { GanttConnectors, connectorStyles } from './GanttConnectors';
import { anchorAttribute, useConnectorAnchors } from './useConnectorAnchors';
import { pointStyle } from './barGeometry';
import { dateMoveSource, type DateMoveProposal } from './dateGesture';
import { GanttMoveBar, type MoveHandle, type ProposedDates } from './GanttMoveBar';
import type { DateMoveProtection } from './useGanttMove';

const baselineValue = (value: BaselineDateValueDto, start: boolean) => value.state === 'set' ? value.value : value.state === 'not_set' ? t('schedule.ganttView.notSet') : start ? t('schedule.ganttView.startDateWasNotCapturedInThisPlan') : t('schedule.ganttView.dueDateWasNotCapturedInThisPlan');
const frozenAt = (value: string) => value.replace('T', ' ').replace('Z', ' UTC');
/** Day column width keeps 28 days readable on a laptop and a full 366-day year bounded. */
export const dayWidth = (days: number) => days <= 28 ? 36 : days <= 84 ? 20 : 12;
const LABEL_COLUMN = 'w-44 sm:w-72';
const noConnectors: ConnectorPlan = { drawn: [], skipped: [] };
/** Day separators plus Saturday/Sunday shading as two repeating backgrounds, aligned to the window's first weekday. */
const TRACK_BACKGROUND = '[background-image:linear-gradient(90deg,var(--color-line)_1px,transparent_1px),linear-gradient(90deg,transparent_calc(var(--gantt-day)*5px),var(--color-gantt-weekend)_calc(var(--gantt-day)*5px),var(--color-gantt-weekend)_calc(var(--gantt-day)*7px))] [background-size:calc(var(--gantt-day)*1px)_100%,calc(var(--gantt-day)*7px)_100%] [background-position:0_0,calc(var(--gantt-shift)*1px)_0]';
const trackBackground = (width: number, firstWeekday: number) => ({ '--gantt-day': width, '--gantt-shift': -(firstWeekday - 1) * width }) as CSSProperties;
export function ScheduleBar({ start, due, window, baseline = false, onFocus, startLabel, dueLabel, incomplete = false, title, anchor, handle = null, onActivate }: { start: string | null; due: string | null; window: CalendarWindow; baseline?: boolean; startLabel?: string; dueLabel?: string; incomplete?: boolean; title?: string; anchor?: string; onFocus: (date: string) => void; handle?: MoveHandle | null;
  /** Current bars only: a click (not a drag past the threshold) or Enter/Space opens the task, movable or read-only. */
  onActivate?: () => void }) {
  const { t } = useTranslation();
  const clipped = clipDates(start, due, window);
  const label = t('schedule.ganttView.valueStartValueDueValue', { p0: baseline ? t('schedule.ganttView.frozenDatesLabel') : t('schedule.ganttView.current'), p1: startLabel ?? start ?? t('schedule.ganttView.notSet'), p2: dueLabel ?? due ?? t('schedule.ganttView.notSet') });
  // The move handle sits on the saved body itself; the body keeps its saved dates while a ghost shows the proposal.
  // data-gantt-movable carries the source task ID only while a move could start now; blocked bodies keep the handle for guidance.
  const body = handle ? { onPointerDown: handle.onPointerDown, onClickCapture: handle.onClickCapture, 'data-gantt-move-handle': '', ...(handle.movable ? { 'data-gantt-movable': handle.movable } : {}) } : {};
  const pointLabel = clipped.kind === 'point' ? t('schedule.ganttView.valueOnlyValue', { p0: label, p1: clipped.endpoint === 'start' ? t('schedule.ganttView.startDate') : t('schedule.ganttView.dueDate') }) : label;
  const activate = onActivate && !baseline ? {
    role: 'button', tabIndex: 0, 'aria-label': t('timelineUX.bar.openTask', { title: title ?? '', dates: pointLabel }), onClick: onActivate,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onActivate(); } },
  } : null;
  const focusRing = activate ? 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-900' : '';
  return <div aria-label={label} className="relative h-6" {...(anchor ? { [anchorAttribute]: anchor } : {})}>
    {clipped.kind === 'range' ? <div title={title ? `${title} · ${label}` : label} className={`absolute top-0.5 z-[2] flex h-5 items-center gap-0.5 overflow-hidden rounded px-0.5 text-[11px] leading-5 ${baseline ? 'border border-dashed border-slate-500 bg-slate-100 text-slate-700' : 'bg-indigo-500 text-white shadow-xs'} ${handle ? 'cursor-grab touch-none select-none active:cursor-grabbing' : activate ? 'cursor-pointer' : ''} ${focusRing}`} style={{ left: `${clipped.left}%`, width: `${clipped.width}%`, minWidth: 2 }} {...body} {...(activate ?? { role: 'img', 'aria-label': label })}><span aria-hidden="true">{clipped.continuesBefore ? '‹' : ''}</span>{title ? <span aria-hidden="true" className="min-w-0 flex-1 truncate">{title}</span> : <span className="flex-1" />}<span aria-hidden="true">{clipped.continuesAfter ? '›' : ''}</span></div>
      : clipped.kind === 'point' ? <span title={label} className={`absolute top-1 z-[2] rounded-sm ${baseline ? 'border border-slate-500 bg-slate-100' : 'bg-indigo-500'} ${handle ? 'cursor-grab touch-none select-none active:cursor-grabbing' : activate ? 'cursor-pointer' : ''} ${focusRing}`} style={{ ...pointStyle, left: `${clipped.left}%` }} {...body} {...(activate ?? { role: 'img', 'aria-label': pointLabel })} />
      : clipped.kind === 'outside' ? <button type="button" className="rounded px-1 text-xs leading-6 text-muted underline" onClick={() => onFocus(clipped.endpoint)}>{t('schedule.ganttView.outsideWindowShowValue', { date: clipped.endpoint })}</button>
      : <span className="px-1 text-xs leading-6 text-muted">{clipped.kind === 'none' ? incomplete ? t('schedule.ganttView.datesWereNotFullyCaptured') : t('schedule.ganttView.noDates') : t('schedule.ganttView.checkDates')}</span>}
  </div>;
}
function planLabel(plan: PlanBaselineDto, members: readonly MembershipDto[]) {
  return `${plan.scope === 'project' ? t('schedule.ganttView.project') : members.find(member => member.id === plan.membershipId)?.displayName ?? t('schedule.ganttView.personal')} · ${frozenAt(plan.frozenAt)}`;
}
export function GanttView({ actorId, workspace, project, tasks, tasksSettled, selectedIds, selectionDisabled = false, onSelect, periods, members, controller: c, writable, hasMore, loadingMore, onLoadMore, onOpen }: {
  actorId: string; workspace: WorkspaceDto; project: ProjectDto; tasks: readonly TaskDto[]; selectedIds: readonly string[]; onSelect: (id: string, selected: boolean) => void;
  /** Optional page signal that `tasks` reflects a successful task-list read, including an empty one. */
  tasksSettled?: boolean;
  /** A pending or unknown page-owned bulk command keeps its original selection. */
  selectionDisabled?: boolean;
  periods: readonly PlanningPeriodDto[]; members: readonly MembershipDto[]; controller: ScheduleWorkspace; writable: boolean; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; onOpen: (id: string) => void;
}) {
  const { t, locale } = useTranslation();
  const queryClient = useQueryClient();
  const [checkingAccess, setCheckingAccess] = useState(false);
  // One compact disclosure holds the about text, the frozen-plan editor, the arrow legend and the dependency checks.
  const [advancedOpen, setAdvancedOpen] = useState(() => !!c.baselinePeriodId && !c.baselineId);
  const fitHelpId = useId();
  const context = useScheduleContext(actorId, workspace.id, project.id, tasks.map(task => task.id), c.baselineId);
  const baselines = usePlanBaselinesQuery(actorId, workspace.id, c.baselinePeriodId);
  const noteReadDenied = c.noteReadDenied;
  const authoritativeDenial = context.anyAccessDenied || isAccessDenied(baselines.error);
  useLayoutEffect(() => { if (authoritativeDenial) noteReadDenied(); }, [authoritativeDenial, noteReadDenied]);
  // Re-render when any pending/unknown command of this client starts or settles, so move guidance stays current.
  const commands = protectedCommandsFor(queryClient);
  useSyncExternalStore(commands.subscribe, commands.getSnapshot);
  const readMoveGate = c.moveGate;
  const moveGate = readMoveGate();
  // Why the last drag past the threshold was refused; a global refusal clears once the global gate opens.
  const [moveRefused, setMoveRefused] = useState<'command' | 'draft' | null>(null);
  const refusedTask = useRef<string | null>(null);
  useLayoutEffect(() => { if (moveRefused && readMoveGate(refusedTask.current ?? undefined) === null) setMoveRefused(null); }, [moveRefused, moveGate, readMoveGate, c.drafts, c.held]);
  const axis = useMemo(() => { const window = calendarWindow(c.windowStart, c.windowSize); return window ? { window, ...calendarAxis(window) } : null; }, [c.windowStart, c.windowSize]);
  // Calendar-only values are formatted at UTC midnight so the viewer's zone never shifts a day.
  const formats = useMemo(() => ({
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }),
    full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }),
    medium: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }),
    month: new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    monthShort: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
  }), [locale]);
  const calendarDate = (value: string) => new Date(`${value}T00:00:00Z`);
  const formatRange = (start: string, end: string) => formats.medium.formatRange(calendarDate(start), calendarDate(end));
  const denied = c.denied || context.anyAccessDenied || isAccessDenied(context.error) || isAccessDenied(baselines.error);
  // Fit and coverage read only loaded, current, non-meeting dates; baselines never widen the axis.
  const ranges: DatedRange[] = tasks.flatMap(task => { const row = context.rows.get(task.id); return row && !row.meetingId ? [{ start: row.current.startDate, due: row.current.dueDate }] : []; });
  const fit = fitLoadedWindow(ranges);
  // The page passes an empty list while its task query is still loading or failed, and the query cache
  // can report success a render before that prop updates. So only the page's own tasksSettled signal can
  // settle an empty list; a non-empty list can only come from loaded pages. Every task also needs an authorized row.
  const listSettled = tasksSettled ?? tasks.length > 0;
  const snapshotReady = !denied && listSettled && !context.pending && !context.fetching && !context.error && tasks.every(task => context.rows.has(task.id));
  const { initializeWindow } = c;
  // Runs before paint; the controller ignores every call after the first settled window.
  useLayoutEffect(() => { if (snapshotReady) initializeWindow(fit); }, [snapshotReady, fit, initializeWindow]);  // Arrows use the same authorized context read as the bars; identity covers every input that moves a row or bar.
  const connectorRows = new Map<string, ConnectorRow>();
  for (const task of tasks) { const row = context.rows.get(task.id); if (row) connectorRows.set(task.id, { start: row.current.startDate, due: row.current.dueDate, meeting: !!row.meetingId }); }
  const connectorPlan = axis && !context.pending && !context.error ? planConnectors(context.comparisons, connectorRows, axis.window, dayWidth(axis.window.days)) : noConnectors;
  const connectorIds = [...new Set(connectorPlan.drawn.flatMap(item => [item.from.taskId, item.to.taskId]))].sort();
  const connectorIdentity = JSON.stringify([locale, c.baselineId, axis?.window.start, axis?.window.days, connectorPlan.drawn, tasks.map(task => { const row = context.rows.get(task.id); return row ? [task.id, task.title, row.current, row.meetingId, row.baselineDates, row.blocking.unresolvedCount] : [task.id]; })]);
  const connectors = useConnectorAnchors(connectorIdentity, connectorIds, !denied && connectorPlan.drawn.length > 0);
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
  const window = axis?.window ?? null;
  const today = todayIn(workspace.timezone);
  const selectedPlan = baselines.data?.find(plan => plan.id === c.baselineId);
  const names = new Map(tasks.map(task => [task.id, task.title]));
  const selected = tasks.filter(task => selectedIds.includes(task.id));
  const hiddenSelection = selected.length !== selectedIds.length;
  const contextReady = !context.pending && !context.error;
  const coverage = window ? windowCoverage(ranges, window) : null;
  const fitShown = c.windowFit && c.windowFit.start === c.windowStart && c.windowFit.days === c.windowSize ? c.windowFit : null;
  const missedWindow = contextReady && !fitShown && coverage !== null && coverage.dated > 0 && coverage.inside === 0;
  const fitHelp = !contextReady || fit.kind !== 'none' ? null : tasks.length ? t('schedule.ganttView.noLoadedDatesToFit', { days: c.windowSize }) : t('schedule.ganttView.noLoadedTasksToFit', { days: c.windowSize });
  const scope = hasMore ? t('schedule.ganttView.loadedScopeMore', { count: tasks.length }) : t('schedule.ganttView.loadedScope', { count: tasks.length });
  const fitQualifier = hasMore ? t('schedule.ganttView.fitScopeMore') : t('schedule.ganttView.fitScopeLoaded');
  const comparing = !!c.baselineId;
  const clearComparison = () => { c.setBaselineId(''); c.setBaselinePeriodId(''); };
  const undated = (row: TaskScheduleContextRowDto | undefined) => !!row && !row.current.startDate && !row.current.dueDate;
  const datedTasks = tasks.filter(task => !undated(context.rows.get(task.id)));
  const undatedTasks = tasks.filter(task => undated(context.rows.get(task.id)));
  const width = window ? dayWidth(window.days) : 0;
  const todayOffset = window ? windowOffset(today, window) : null;
  const background = axis ? trackBackground(width, axis.days[0]?.weekday ?? 1) : undefined;
  const aligned = connectorPlan.drawn.filter(item => item.state === 'compatible').length, conflicts = connectorPlan.drawn.filter(item => item.state === 'conflict').length;
  const neutral = connectorPlan.drawn.length - aligned - conflicts;
  const connectorLabel = t('timelineUX.connectors.svgLabel', { aligned, conflicts, neutral });
  const skipped = skippedCounts(connectorPlan);
  const skippedText = [
    skipped.meeting ? t('schedule.ganttView.connectorSkipMeeting', { count: skipped.meeting }) : '',
    skipped.missing_date ? t('schedule.ganttView.connectorSkipMissingDate', { count: skipped.missing_date }) : '',
    skipped.not_loaded ? t('schedule.ganttView.connectorSkipNotLoaded', { count: skipped.not_loaded }) : '',
    skipped.outside_window ? t('schedule.ganttView.connectorSkipOutsideWindow', { count: skipped.outside_window }) : '',
    skipped.not_current ? t('schedule.ganttView.connectorSkipNotCurrent', { count: skipped.not_current }) : '',
  ].filter(Boolean);
  const checksId = `${fitHelpId}-checks`;
  // Any window, zoom, filter/loaded scope or comparison change cancels an active move gesture.
  const viewportKey = window ? [window.start, window.days, width, c.baselinePeriodId, c.baselineId, accessScope].join('|') : '';
  const movedDrafts = new Map<string, ProposedDates>();
  for (const draft of Object.values(c.drafts)) {
    const first = draft.rows[0];
    if (draft.origin === 'move' && draft.rows.length === 1 && first) movedDrafts.set(first.taskId, { startDate: first.startDate || null, dueDate: first.dueDate || null });
  }
  // Task-specific: a retained draft blocks only its own bars; the global part covers commands, denial and scope.
  const refusal = (taskId: string) => { const gate = c.moveGate(taskId); return gate === 'command' || gate === 'draft' ? gate : null; };
  const refuseMove = (taskId: string) => { refusedTask.current = taskId; setMoveRefused(refusal(taskId) ?? 'command'); };
  // A drop enqueues into the page-owned direct lane, which previews and applies only an exact clean match; no dialog opens.
  const dropMove = (proposal: DateMoveProposal, lease: DateMoveProtection) => {
    const staged = c.stageMove(proposal, lease, { actorId, workspaceId: workspace.id, projectId: project.id });
    refusedTask.current = staged ? null : proposal.source.taskId;
    setMoveRefused(staged ? null : refusal(proposal.source.taskId) ?? 'draft');
    return staged;
  };
  const renderRow = (task: TaskDto) => {
    const row = context.rows.get(task.id);
    if (!row || !window) return <div key={task.id} className="px-3 py-2 text-xs text-muted">{t('schedule.ganttView.taskDatesHaveNotLoadedYet')}</div>;
    const base = row.baselineDates;
    const baseStart = base.state === 'captured' && base.startDate.state === 'set' ? base.startDate.value : null;
    const baseDue = base.state === 'captured' && base.dueDate.state === 'set' ? base.dueDate.value : null;
    return <div key={task.id} role="group" aria-label={t('schedule.ganttView.calendarDatesValue', { p0: task.title })} className="flex border-b border-line last:border-b-0" data-gantt-row="">
      <div className={`sticky left-0 z-10 ${LABEL_COLUMN} shrink-0 border-r border-line bg-surface px-2 py-1.5`}>
        <div className="flex min-w-0 items-center gap-1.5">
          <input type="checkbox" className="shrink-0" aria-label={t('schedule.ganttView.selectDatesValue', { p0: task.title })} checked={selectedIds.includes(task.id)} disabled={selectionDisabled || !selectedIds.includes(task.id) && selectedIds.length >= 100} onChange={e => onSelect(task.id, e.target.checked)} />
          <button type="button" title={task.title} className="min-w-0 flex-1 truncate rounded text-left text-[13px] font-medium text-accent-ink hover:underline" onClick={() => onOpen(task.id)}>{task.title}</button>
          {row.meetingId ? null : writable && row.editableDates ? <button type="button" aria-label={t('schedule.ganttView.editDates')} title={t('schedule.ganttView.editDates')} className="shrink-0 rounded border border-line bg-surface px-1.5 text-[11px] leading-5 text-ink-soft hover:border-line-strong hover:text-ink" onClick={() => c.open([task], context.rows)}>{t('schedule.ganttView.editShort')}</button> : <span title={t('schedule.ganttView.datesCannotBeEdited')} className="shrink-0 text-[11px] text-muted"><span aria-hidden="true">{t('schedule.ganttView.readOnlyShort')}</span><span className="sr-only">{t('schedule.ganttView.datesCannotBeEdited')}</span></span>}
        </div>
        {row.meetingId ? <button type="button" className="mt-0.5 rounded text-[11px] text-accent-ink underline" onClick={() => onOpen(task.id)}>{t('schedule.ganttView.meetingOpenCalendar')}</button>
          : <p className="mt-0.5 text-[11px] leading-4 text-muted">{t('schedule.ganttView.datesSummary', { start: row.current.startDate ?? t('schedule.ganttView.notSet'), due: row.current.dueDate ?? t('schedule.ganttView.notSet') })}</p>}
        {base.state === 'not_in_baseline' ? <p className="truncate text-[11px] leading-4 text-muted">{t('schedule.ganttView.taskIsNotIncludedInThisPlan')}</p> : base.state === 'captured' ? <p className="text-[11px] leading-4 text-slate-600">{t('schedule.ganttView.planStartValue', { date: baselineValue(base.startDate, true) })}<br />{t('schedule.ganttView.dueValue', { date: baselineValue(base.dueDate, false) })}</p> : null}
        {row.blocking.isBlocked ? <p className="text-[11px] leading-4 text-amber-900">{t('schedule.ganttView.unfinishedPredecessorCount', { count: row.blocking.unresolvedCount })}</p> : null}
      </div>
      <div data-gantt-track="" className={`relative shrink-0 py-1.5 ${TRACK_BACKGROUND}`} style={{ width: window.days * width, ...background }}>
        {todayOffset !== null ? <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-rose-500/70" style={{ left: (todayOffset + 0.5) * width - 1 }} /> : null}
        {row.meetingId ? <p className="px-1 text-xs leading-6 text-muted">{t('schedule.ganttView.meetingScheduleIsInTheCalendarWithoutA')}</p>
          : <GanttMoveBar actorId={actorId} workspaceId={workspace.id} source={dateMoveSource(task, row, { projectId: project.id, writable, ready: snapshotReady })} viewportKey={viewportKey} pixelsPerDay={width} window={window} staged={movedDrafts.get(task.id) ?? null} canStart={() => c.moveGate(task.id) === null} onRefused={() => refuseMove(task.id)} onDrop={dropMove}>
            {handle => <ScheduleBar start={row.current.startDate} due={row.current.dueDate} title={task.title} anchor={task.id} window={window} onFocus={c.setWindowStart} handle={handle} onActivate={() => onOpen(task.id)} />}
          </GanttMoveBar>}
        {base.state === 'captured' && !row.meetingId ? <ScheduleBar start={baseStart} due={baseDue} startLabel={baselineValue(base.startDate, true)} dueLabel={baselineValue(base.dueDate, false)} incomplete={base.startDate.state === 'not_captured' || base.dueDate.state === 'not_captured'} window={window} baseline onFocus={c.setWindowStart} /> : null}
      </div>
    </div>;
  };
  const aboutId = `${fitHelpId}-about`, compareId = `${fitHelpId}-compare`, legendId = `${fitHelpId}-legend`;
  const notDrawn = connectorPlan.skipped.length;
  // The checks live in the disclosure; reviewing them opens it first, then moves focus once it is shown.
  const reviewChecks = () => { setAdvancedOpen(true); globalThis.setTimeout(() => document.getElementById(checksId)?.focus(), 0); };
  const shift = (amount: number) => { const date = shiftDay(c.windowStart, amount); if (date) c.setWindowStart(date); };
  const fitRange = fitShown ? formatRange(fitShown.earliest, fitShown.latest) : '';
  return <section aria-label={t('schedule.ganttView.projectTimeline')} className="min-w-0 space-y-2">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 className="text-base font-semibold">{t('schedule.ganttView.timelineGantt')}</h2>
      {window ? <p className="text-xs text-muted">{t('schedule.ganttView.scopeLine', { range: formatRange(window.start, window.end), scope })} <span className="sr-only">{t('schedule.ganttView.windowRangeDetail', { count: window.days, startIso: window.start, endIso: window.end, timezone: workspace.timezone })}</span></p> : null}
    </header>
    <div id={aboutId} hidden={!advancedOpen} className="space-y-1 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
      {window ? <p>{t('schedule.ganttView.aboutWindow', { count: window.days, startIso: window.start, endIso: window.end, timezone: workspace.timezone })}</p> : null}
      <p>{t('schedule.ganttView.aboutLoaded')}</p>
      <p>{t('schedule.ganttView.datesDoNotChangePlans')}</p>
      <p>{t('timelineUX.about.move')}</p>
      <p>{t('schedule.ganttView.connectorsAbout')} {t('timelineUX.about.neutral')}</p>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]"><span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-sm bg-indigo-500" />{t('schedule.ganttView.legendCurrent')}</span><span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-sm border border-dashed border-slate-500 bg-slate-100" />{t('schedule.ganttView.legendFrozen')}</span><span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2.5 w-0.5 bg-rose-500" />{t('schedule.ganttView.legendToday')}</span><span className="inline-flex items-center gap-1"><span aria-hidden="true" className="inline-block h-2.5 w-4 rounded-sm bg-slate-100 ring-1 ring-line" />{t('schedule.ganttView.legendWeekend')}</span></p>
    </div>
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="flex"><span className="sr-only">{t('schedule.ganttView.windowStart')}</span><TextInput type="date" className="h-8 w-36 px-2 text-[13px]" min="0001-01-01" max="9999-12-31" value={c.windowStart} onChange={e => c.setWindowStart(e.target.value)} /></label>
      <label className="flex"><span className="sr-only">{t('schedule.ganttView.daysInWindow')}</span><select className={inputClassName('h-8 w-auto px-2 text-[13px]')} value={c.windowSize} onChange={e => c.setWindowSize(Number(e.target.value))}><option value={28}>{t('schedule.ganttView.28Days')}</option><option value={84}>{t('schedule.ganttView.84Days')}</option><option value={366}>{t('schedule.ganttView.366Days')}</option></select></label>
      <div className="flex gap-1">
        <Button size="sm" aria-label={t('schedule.ganttView.previousWindow')} title={t('schedule.ganttView.previousWindow')} disabled={shiftDay(c.windowStart, -c.windowSize) === null} onClick={() => shift(-c.windowSize)}><span aria-hidden="true">‹</span></Button>
        <Button size="sm" title={t('schedule.ganttView.todayHint', { date: today })} onClick={() => c.setWindowStart(today)}>{t('schedule.ganttView.today')}</Button>
        <Button size="sm" aria-label={t('schedule.ganttView.nextWindow')} title={t('schedule.ganttView.nextWindow')} disabled={shiftDay(c.windowStart, c.windowSize) === null} onClick={() => shift(c.windowSize)}><span aria-hidden="true">›</span></Button>
      </div>
      <Button size="sm" variant={missedWindow ? 'primary' : 'secondary'} disabled={!contextReady || fit.kind === 'none'} aria-describedby={fitHelp ? fitHelpId : undefined} title={t('schedule.ganttView.fitLoadedTasksHint')} onClick={() => c.fitWindow(fit)}>{t('schedule.ganttView.fitLoadedTasks')}</Button>
      <Button size="sm" variant="ghost" aria-expanded={advancedOpen} aria-controls={`${aboutId} ${compareId} ${legendId} ${checksId}`} onClick={() => setAdvancedOpen(open => !open)}>{t('timelineUX.advanced.toggle')}</Button>
    </div>
    {window ? null : <p role="alert" className="text-sm text-red-800">{t('schedule.ganttView.enterADateFrom00010101To')}</p>}
    {fitShown ? <p role="status" className="text-xs text-indigo-900">{fitShown.kind === 'wide' ? t('schedule.ganttView.fitWide', { span: fitShown.span, range: fitRange }) : fitShown.origin === 'initial' ? t('schedule.ganttView.initialFitStatus', { count: fitShown.count, range: fitRange }) : t('schedule.ganttView.fittedStatus', { count: fitShown.count, range: fitRange })} {fitQualifier}</p> : null}
    {missedWindow && coverage ? <p role="status" className="text-xs text-amber-900">{t('schedule.ganttView.missedWindow', { before: coverage.before, after: coverage.after })} {t('schedule.ganttView.useFitLoadedTasks')}</p> : null}
    {fitHelp ? <p id={fitHelpId} className="text-xs text-muted">{fitHelp}</p> : null}
    <section aria-label={t('schedule.ganttView.compareWithAFrozenPlan')} className="flex flex-wrap items-center gap-1.5 text-xs">
      {comparing ? <p className="inline-flex min-w-0 items-center gap-1.5 rounded bg-slate-100 px-1.5 py-0.5 font-medium text-ink"><span aria-hidden="true" className="inline-block h-2.5 w-4 shrink-0 rounded-sm border border-dashed border-slate-500 bg-white" /><span className="truncate">{selectedPlan ? t('schedule.ganttView.comparingWith', { plan: planLabel(selectedPlan, members) }) : t('schedule.ganttView.comparingSelected')}</span></p> : c.baselinePeriodId ? <p className="text-muted">{t('schedule.ganttView.comparisonPeriodOnly')}</p> : null}
      {comparing || c.baselinePeriodId ? <Button size="sm" variant="ghost" onClick={clearComparison}>{t('schedule.ganttView.clearComparison')}</Button> : null}
      {baselines.error && c.baselinePeriodId ? <div className="w-full"><QueryErrorState error={baselines.error} subject="tasks" headingLevel={3} onRetry={() => void baselines.refetch()} /></div> : null}
      <div id={compareId} hidden={!advancedOpen} className="w-full space-y-2 rounded-lg border border-line px-3 py-2">
      <h3 className="text-xs font-semibold">{comparing ? t('schedule.ganttView.editComparison') : t('schedule.ganttView.compareWithFrozenPlan')}</h3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-xs font-medium">{t('schedule.ganttView.planPeriod')}<select className={inputClassName('h-8 w-auto max-w-full px-2 text-[13px]')} value={c.baselinePeriodId} onChange={e => { c.setBaselinePeriodId(e.target.value); c.setBaselineId(''); }}><option value="">{t('schedule.ganttView.chooseAPeriodToCompare')}</option>{[...periods].sort((a, b) => b.localStart.localeCompare(a.localStart)).map(period => <option key={period.id} value={period.id}>{period.name} · {period.localStart}</option>)}</select></label>
        <label className="space-y-1 text-xs font-medium">{t('schedule.ganttView.frozenPlanToCompare')}<select className={inputClassName('h-8 w-auto max-w-full px-2 text-[13px]')} value={c.baselineId} disabled={!c.baselinePeriodId || !baselines.isSuccess} onChange={e => c.setBaselineId(e.target.value)}><option value="">{t('schedule.ganttView.noComparison')}</option>{(baselines.data ?? []).map(baseline => <option key={baseline.id} value={baseline.id}>{planLabel(baseline, members)}</option>)}</select></label>
      </div>
      {context.baseline ? <details><summary className="cursor-pointer text-xs font-medium">{t('schedule.ganttView.planSourcesAndCoverage')}</summary><p className="mt-2 text-xs text-muted">{context.baseline.scope === 'project' ? t('schedule.ganttView.projectPlan') : t('schedule.ganttView.personalPlan')} · {context.baseline.scope === 'self' ? members.find(member => member.id === context.baseline?.membershipId)?.displayName ?? t('schedule.ganttView.memberUnavailable') : t('schedule.ganttView.membersFromTheOriginalFreeze')} · {selectedPlan?.snapshot.period.name ?? t('schedule.ganttView.savedPeriod')} {t('schedule.ganttView.period')}{selectedPlan?.snapshot.period.localStart ?? t('schedule.ganttView.fromTheSelectedPlan')}{t('schedule.ganttView.frozen')}{frozenAt(context.baseline.frozenAt)}{t('schedule.ganttView.coversTasksInSavedCommitmentsNotTheEntire')}</p>{context.baseline.sourcePersonalBaselineIds.length ? <ul className="mt-2 space-y-1 text-xs text-muted">{context.baseline.sourcePersonalBaselineIds.map((id, index) => { const source = baselines.data?.find(plan => plan.id === id); const savedMember = source?.snapshot.memberships.find(member => member.id === source.membershipId); return <li key={id}>{source ? t('schedule.ganttView.personalSourceValueValueValue', { p0: savedMember?.displayName ?? t('schedule.ganttView.originalPlanMember'), p1: source.snapshot.period.name, p2: frozenAt(source.frozenAt) }) : t('schedule.ganttView.personalSourceValueDetailsNotLoaded', { p0: index + 1 })}</li>; })}</ul> : <p className="mt-2 text-xs text-muted">{t('schedule.ganttView.noLinkedPersonalSources')}</p>}</details> : null}
      <p className="text-xs text-muted">{t('schedule.ganttView.chooseAPlanExplicitlyDatesMissingFromAn')}</p>
      </div>
    </section>
    {writable && selectedIds.length ? <div className="space-y-2"><Button disabled={hiddenSelection || context.pending || !!context.error || selected.length > 100} onClick={() => c.open(selected, context.rows)}>{t('schedule.ganttView.editSelectedDateCount', { count: selectedIds.length })}</Button>{hiddenSelection ? <p className="text-xs text-muted">{t('schedule.ganttView.someSelectedTasksAreHiddenByTheCurrent')}</p> : null}</div> : null}
    {moveRefused ? <p role="status" className="text-xs text-amber-900">{t(moveRefused === 'command' ? 'schedule.ganttMoveBar.blockedByCommand' : 'timelineUX.move.blockedByTaskDraft')}</p> : null}
    {contextReady && window && (conflicts || notDrawn) && !advancedOpen ? <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
      {conflicts ? <span className="text-orange-800">{t('schedule.ganttView.connectorConflicts', { count: conflicts })}</span> : null}
      {notDrawn ? <span>{t('timelineUX.connectors.notShown', { count: notDrawn })}</span> : null}
      <button type="button" className="rounded text-accent-ink underline" onClick={reviewChecks}>{t('schedule.ganttView.reviewDependencyChecks')}</button>
    </p> : null}
    {contextReady && window && context.comparisons.length ? <div id={legendId} hidden={!advancedOpen} role="group" aria-label={t('schedule.ganttView.connectorsLegend')} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
      <span className="font-medium text-ink-soft">{t('schedule.ganttView.connectorsTitle')}</span>
      <span className="inline-flex items-center gap-1"><svg aria-hidden="true" width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={connectorStyles.compatible.stroke} strokeWidth={connectorStyles.compatible.strokeWidth} /></svg>{t('schedule.ganttView.connectorAligned', { count: aligned })}</span>
      <span className="inline-flex items-center gap-1 text-orange-800"><svg aria-hidden="true" width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={connectorStyles.conflict.stroke} strokeWidth={connectorStyles.conflict.strokeWidth} strokeDasharray={connectorStyles.conflict.strokeDasharray} /></svg>{t('schedule.ganttView.connectorConflicts', { count: conflicts })}</span>
      <span className="inline-flex items-center gap-1"><svg aria-hidden="true" width="18" height="6"><line x1="0" y1="3" x2="18" y2="3" stroke={connectorStyles.neutral.stroke} strokeWidth={connectorStyles.neutral.strokeWidth} strokeDasharray={connectorStyles.neutral.strokeDasharray} /></svg>{t('timelineUX.connectors.neutral', { count: neutral })}</span>
      {skippedText.length ? <span>{t('schedule.ganttView.connectorsNotDrawn', { reasons: skippedText.join(', ') })}</span> : null}
      <a className="text-accent-ink underline" href={`#${checksId}`}>{t('schedule.ganttView.reviewDependencyChecks')}</a>
    </div> : null}
    {context.error ? <QueryErrorState error={context.error} subject="tasks" headingLevel={3} onRetry={() => void context.refetch()} /> : context.pending ? <p role="status" className="text-sm text-muted">{t('schedule.ganttView.loadingCurrentDates')}</p> : window && axis ? <div className="relative max-w-full overflow-x-auto rounded-xl border border-line" aria-label={t('schedule.ganttView.loadedTaskCalendar')} tabIndex={0}>
      <div ref={connectors.hostRef} className="relative isolate w-max min-w-full">
        <GanttConnectors plan={connectorPlan} anchors={connectors.anchors} label={connectorLabel} />
        <div className="flex border-b border-line bg-canvas">
          <div className={`sticky left-0 z-20 ${LABEL_COLUMN} flex shrink-0 items-end border-r border-line bg-canvas px-2 py-1.5 text-xs font-medium text-muted`}>{comparing ? t('schedule.ganttView.taskCurrentAndFrozenDates') : t('schedule.ganttView.taskCurrentDates')}</div>
          <div className="shrink-0">
            <div aria-hidden="true" className="relative h-6 border-b border-line" style={{ width: window.days * width }}>{axis.months.map(month => { const span = month.days * width, long = formats.month.format(calendarDate(month.first)); return <div key={month.month} title={long} className="absolute inset-y-0 truncate border-l border-slate-300 px-1 text-[11px] font-semibold leading-6 text-ink-soft" style={{ left: month.offset * width, width: span }}>{span >= 84 ? long : span >= 28 ? formats.monthShort.format(calendarDate(month.first)) : ''}</div>; })}</div>
            <ol aria-label={t('schedule.ganttView.calendarWindowDays')} className="flex" style={{ width: window.days * width }}>{axis.days.map(day => { const isToday = day.date === today; return <li key={day.date} title={day.date} aria-current={isToday ? 'date' : undefined} className={`shrink-0 overflow-visible whitespace-nowrap border-r border-line py-0.5 text-center leading-tight ${isToday ? 'bg-rose-100 font-semibold text-rose-900' : day.weekend ? 'bg-slate-100 text-muted' : 'text-ink-soft'}`} style={{ width }}>
              <span className="sr-only">{isToday ? t('schedule.ganttView.todayDayLabel', { date: formats.full.format(calendarDate(day.date)) }) : formats.full.format(calendarDate(day.date))}</span>
              <span aria-hidden="true" className="block text-[10px]">{width >= 20 ? formats.weekday.format(calendarDate(day.date)) : ' '}</span>
              <span aria-hidden="true" className="block text-[11px]">{width >= 20 || day.day === 1 || day.weekday === 1 ? day.day : ' '}</span>
            </li>; })}</ol>
          </div>
        </div>
        {datedTasks.map(renderRow)}
        {undatedTasks.length ? <div role="group" aria-labelledby={`${fitHelpId}-undated`}>
          <div className="flex border-y border-line bg-canvas"><div className={`sticky left-0 z-10 ${LABEL_COLUMN} shrink-0 bg-canvas px-2 py-1.5`}><h3 id={`${fitHelpId}-undated`} className="text-xs font-semibold">{t('schedule.ganttView.noDatesGroup', { count: undatedTasks.length })}</h3><p className="text-[11px] text-muted">{t('schedule.ganttView.noDatesGroupHint')}</p></div></div>
          {undatedTasks.map(renderRow)}
        </div> : null}
      </div></div> : null}
    {tasks.length === 0 ? <p className="text-sm text-muted">{t('schedule.ganttView.noTasksMatchTheCurrentFilter')}</p> : null}
    {hasMore ? <Button disabled={loadingMore} onClick={onLoadMore}>{t('schedule.ganttView.loadMoreTimelineTasks')}</Button> : null}
    <div id={checksId} tabIndex={-1} hidden={!advancedOpen}><ComparisonList comparisons={context.comparisons} names={names} workspaceId={workspace.id} /></div>
  </section>;
}
