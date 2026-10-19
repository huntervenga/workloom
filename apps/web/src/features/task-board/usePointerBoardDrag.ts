import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { edgeScrollStep, scrollDragEdge } from '../task-table/dragAutoScroll';

export interface BoardDropTarget { statusId: string; anchorTaskId: string | null; placement: 'before' | 'after' }
export type BoardMoveCard = (task: TaskDto, statusId: string, anchor: TaskDto | null, placement: 'before' | 'after') => void;
export interface BoardDragState { task: TaskDto; point: { x: number; y: number }; statusId: string | null; anchorTaskId: string | null; placement: 'before' | 'after'; width: number; height: number; offset: { x: number; y: number } }
interface Options {
  tasks: ReadonlyMap<string, TaskDto>; statuses: ReadonlyMap<string, TaskStatusDto>;
  allowed: (task: TaskDto) => boolean; blocked: boolean; contextKey: string;
  onMoveCard?: BoardMoveCard | undefined;
  onMoveStatus?: ((task: TaskDto, statusId: string) => void) | undefined;
  acquireProtection?: (() => () => void) | undefined;
}
/** A drag is an intent only: no card/order/status is patched before the server confirms. */
export function usePointerBoardDrag(options: Options) {
  const head = useRef(options), cleanup = useRef<(() => void) | null>(null);
  const [drag, setDrag] = useState<BoardDragState | null>(null);
  useLayoutEffect(() => { head.current = options; });
  useEffect(() => () => cleanup.current?.(), []);
  const startDrag = useCallback((source: TaskDto, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.isPrimary === false || head.current.blocked || (!head.current.onMoveCard && !head.current.onMoveStatus) || !head.current.allowed(source)) return;
    event.preventDefault(); event.stopPropagation();
    cleanup.current?.();
    const release = head.current.acquireProtection?.();
    const context = head.current.contextKey, pointerId = event.pointerId;
    const first = { x: event.clientX, y: event.clientY };
    const board = event.currentTarget.closest<HTMLElement>('[data-board-scroll]');
    const rect = event.currentTarget.closest<HTMLElement>('[data-board-card]')?.getBoundingClientRect();
    const width = rect?.width || 274, height = rect?.height || 150;
    const offset = { x: rect?.width ? first.x - rect.left : 12, y: rect?.height ? first.y - rect.top : 12 };
    let point = first, over: Element | null = null, active = false, frame: number | null = null;
    const own = (e: PointerEvent) => e.pointerId === pointerId;
    const current = () => head.current.tasks.get(source.id);
    const stale = () => {
      const task = current();
      return head.current.blocked || head.current.contextKey !== context || !task || !head.current.allowed(task)
        || task.revision !== source.revision || task.statusId !== source.statusId || task.position !== source.position
        || task.workPackageRevision !== source.workPackageRevision || task.participantsRevision !== source.participantsRevision;
    };
    const hit = (fallback: Element | null): BoardDropTarget | null => {
      over = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(point.x, point.y) : fallback;
      const lane = over?.closest<HTMLElement>('[data-board-status]');
      const statusId = lane?.dataset.boardStatus;
      const status = statusId ? head.current.statuses.get(statusId) : null;
      if (!lane || !board?.contains(lane) || !status || status.projectId !== source.projectId || status.workspaceId !== source.workspaceId) return null;
      // Linked boards retain their canonical status-only action, without claiming a shared order.
      if (!head.current.onMoveCard) return status.id === source.statusId ? null : { statusId: status.id, anchorTaskId: null, placement: 'after' };
      const elements = [...lane.querySelectorAll<HTMLElement>('[data-board-card]')].filter(card => card.dataset.boardCard !== source.id);
      for (const element of elements) {
        const bounds = element.getBoundingClientRect();
        if (point.y < bounds.top + bounds.height / 2) {
          const anchor = head.current.tasks.get(element.dataset.boardCard ?? '');
          if (!anchor || anchor.archivedAt !== null || anchor.statusId !== status.id || anchor.projectId !== source.projectId || anchor.workspaceId !== source.workspaceId) return null;
          return { statusId: status.id, anchorTaskId: anchor.id, placement: 'before' };
        }
      }
      // With paging/filtering this intentionally means the authoritative full lane end.
      return status.id === source.statusId && elements.length === 0 ? null : { statusId: status.id, anchorTaskId: null, placement: 'after' };
    };
    const paint = (fallback: Element | null) => {
      const target = hit(fallback);
      setDrag({ task: source, point, statusId: target?.statusId ?? null, anchorTaskId: target?.anchorTaskId ?? null, placement: target?.placement ?? 'after', width, height, offset });
    };
    const stop = (commit: boolean, event?: PointerEvent) => {
      if (event) point = { x: event.clientX, y: event.clientY };
      const target = commit && active && !stale() ? hit(over?.isConnected ? over : null) : null;
      cleanup.current?.();
      // Releasing the interaction lease comes before the parent's guarded command starts.
      if (target && !stale()) {
        if (head.current.onMoveCard) head.current.onMoveCard(source, target.statusId, target.anchorTaskId === null ? null : head.current.tasks.get(target.anchorTaskId) ?? null, target.placement);
        else head.current.onMoveStatus?.(source, target.statusId);
      }
    };
    const tick = () => {
      frame = null;
      if (stale()) { stop(false); return; }
      let scrolled = scrollDragEdge(point, over);
      const port = over?.closest<HTMLElement>('[data-board-scroll]');
      if (port && port.scrollWidth > port.clientWidth) {
        const rect = port.getBoundingClientRect();
        const next = Math.max(0, Math.min(port.scrollWidth - port.clientWidth, port.scrollLeft + edgeScrollStep(point.x, rect.left, rect.right)));
        if (next !== port.scrollLeft) { port.scrollLeft = next; scrolled = true; }
      }
      if (scrolled) paint(over?.isConnected ? over : null);
      frame = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      if (!own(event)) return;
      if (!active && Math.hypot(event.clientX - first.x, event.clientY - first.y) < 4) return;
      if (stale()) { stop(false); return; }
      active = true; point = { x: event.clientX, y: event.clientY };
      paint(event.target instanceof Element ? event.target : null);
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    const up = (event: PointerEvent) => { if (own(event)) stop(true, event); };
    const cancelPointer = (event: PointerEvent) => { if (own(event)) stop(false); };
    const cancel = () => stop(false);
    const scroll = () => { if (active) { if (stale()) stop(false); else paint(over?.isConnected ? over : null); } };
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('blur', cancel); window.addEventListener('scroll', scroll, true); window.addEventListener('keydown', escape, true); document.addEventListener('visibilitychange', hidden);
    cleanup.current = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('blur', cancel); window.removeEventListener('scroll', scroll, true); window.removeEventListener('keydown', escape, true); document.removeEventListener('visibilitychange', hidden);
      cleanup.current = null; release?.(); setDrag(null);
    };
  }, []);
  return { drag, startDrag };
}
