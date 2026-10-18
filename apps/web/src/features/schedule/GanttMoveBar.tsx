import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { pointStyle } from './barGeometry';
import { clipDates, type CalendarWindow } from './dates';
import { DATE_MOVE_THRESHOLD, type DateMoveProposal, type DateMoveSource } from './dateGesture';
import { useGanttMove, type DateMoveProtection } from './useGanttMove';

/** Spread only onto the saved bar body (range or point), never onto the row, track, outside-date button or baseline. */
export interface MoveHandle {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  /** Source task ID while a move could start now (eligible source and open gate at render), otherwise null. */
  movable: string | null;
}
export interface ProposedDates { startDate: string | null; dueDate: string | null }
const trackSelector = '[data-gantt-track]';
/** Stable test selector shared by every ghost shape; the ghost itself stays unanchored and pointer-transparent. */
const ghostTestId = 'gantt-date-move-ghost';

/**
 * Move-only wrapper around one saved current bar. The saved bar, its anchor and connectors keep the saved
 * dates; the proposal is a separate, unanchored, pointer-transparent ghost. A drop only hands the proposal
 * and its refresh lease to the page-owned direct save lane; the bar itself never writes.
 */
export function GanttMoveBar({ actorId, workspaceId, source, viewportKey, pixelsPerDay, window, staged, canStart, onRefused, onDrop, children }: {
  actorId: string; workspaceId: string;
  /** Null when this bar cannot move now; the saved bar still renders without a handle. */
  source: DateMoveSource | null;
  viewportKey: string; pixelsPerDay: number; window: CalendarWindow;
  /** Dates of a retained move draft for this task, drawn as the same ghost until applied or discarded. */
  staged: ProposedDates | null;
  /** Synchronous gate read before any protection is acquired, and at render for the movable marker. */
  canStart: () => boolean;
  onRefused: () => void;
  onDrop: (proposal: DateMoveProposal, lease: DateMoveProtection) => boolean;
  children: (handle: MoveHandle | null) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const move = useGanttMove({ actorId, workspaceId, source, viewportKey, pixelsPerDay,
    getTrack: () => root.current?.closest<HTMLElement>(trackSelector) ?? null, onDrop });
  // A refused press stays an ordinary click; only a drag past the threshold explains the refusal and swallows that click.
  const refusal = useRef<(() => void) | null>(null);
  const refusedDrag = useRef(false);
  const latestRefused = useRef(onRefused); latestRefused.current = onRefused;
  useEffect(() => () => refusal.current?.(), []);
  const watchRefusal = (pointerId: number, clientX: number) => {
    refusal.current?.();
    refusedDrag.current = false;
    const stop = () => {
      document.removeEventListener('pointermove', moveListener); document.removeEventListener('pointerup', stop); document.removeEventListener('pointercancel', stop);
      if (refusal.current === stop) refusal.current = null;
    };
    const moveListener = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || !Number.isFinite(e.clientX) || Math.abs(e.clientX - clientX) < DATE_MOVE_THRESHOLD) return;
      refusedDrag.current = true; stop(); latestRefused.current();
    };
    document.addEventListener('pointermove', moveListener); document.addEventListener('pointerup', stop); document.addEventListener('pointercancel', stop);
    refusal.current = stop;
  };
  const handle: MoveHandle | null = source ? {
    onPointerDown: event => {
      if (!event.isPrimary || event.button !== 0) return;
      if (!canStart()) { watchRefusal(event.pointerId, event.clientX); return; }
      refusedDrag.current = false;
      move.onPointerDown(event);
    },
    onClickCapture: event => {
      if (refusedDrag.current) { refusedDrag.current = false; event.preventDefault(); event.stopPropagation(); return; }
      move.onClickCapture(event);
    },
    movable: canStart() ? source.taskId : null,
  } : null;
  const shown = move.proposal ?? staged;
  return <div ref={root} className="relative">
    {children(handle)}
    {shown ? <ProposedGhost startDate={shown.startDate} dueDate={shown.dueDate} window={window} /> : null}
  </div>;
}

function ProposedGhost({ startDate, dueDate, window }: ProposedDates & { window: CalendarWindow }) {
  const { t } = useTranslation();
  const clipped = clipDates(startDate, dueDate, window);
  const label = t('schedule.ganttMoveBar.proposedDates', { start: startDate ?? t('schedule.ganttView.notSet'), due: dueDate ?? t('schedule.ganttView.notSet') });
  if (clipped.kind === 'range') return <div data-gantt-proposal="" data-testid={ghostTestId} title={label} className="pointer-events-none absolute top-0.5 z-[3] flex h-5 items-center overflow-hidden rounded border-2 border-dashed border-indigo-700 bg-indigo-50/80 px-1 text-[11px] font-medium leading-4 text-indigo-950" style={{ left: `${clipped.left}%`, width: `${clipped.width}%`, minWidth: 2 }}><span className="truncate">{label}</span></div>;
  if (clipped.kind === 'point') {
    const end = clipped.left > 60;
    return <div data-gantt-proposal="" data-testid={ghostTestId} title={label} className="pointer-events-none absolute inset-x-0 top-0 z-[3] h-6">
      <span aria-hidden="true" className="absolute top-1 rounded-sm border-2 border-dashed border-indigo-700 bg-indigo-50/80" style={{ ...pointStyle, left: `${clipped.left}%` }} />
      <span className="absolute top-0 whitespace-nowrap rounded bg-indigo-50/90 px-1 text-[11px] font-medium leading-6 text-indigo-950" style={end ? { right: `calc(${100 - clipped.left}% + 12px)` } : { left: `calc(${clipped.left}% + 12px)` }}>{label}</span>
    </div>;
  }
  if (clipped.kind === 'outside') return <div data-gantt-proposal="" data-testid={ghostTestId} title={label} className={`pointer-events-none absolute top-0.5 z-[3] whitespace-nowrap rounded border-2 border-dashed border-indigo-700 bg-indigo-50/90 px-1 text-[11px] font-medium leading-4 text-indigo-950 ${clipped.endpoint < window.start ? 'left-0' : 'right-0'}`}>{t('schedule.ganttMoveBar.proposedOutsideWindow', { dates: label })}</div>;
  return null;
}
