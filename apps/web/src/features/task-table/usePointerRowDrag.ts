import { useQueryClient } from '@tanstack/react-query';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import type { TaskDto } from '@workloom/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { scrollDragEdge } from './dragAutoScroll';
import type { TaskDropPlacement } from './TaskTable';

export interface DropTarget { taskId: string | null; placement: TaskDropPlacement; responsibleMembershipId?: string | null }

export interface PointerRowDragOptions {
  /** Rows that may be dropped on, as currently loaded; their revisions guard the move. */
  taskById: ReadonlyMap<string, TaskDto>;
  dropAllowed: (source: TaskDto, anchor: TaskDto, placement: TaskDropPlacement) => boolean;
  onMove: ((task: TaskDto, anchor: TaskDto, placement: TaskDropPlacement) => void) | undefined;
  /** A task command is unresolved: a drag neither starts nor commits. */
  blocked: boolean;
  contextKey?: string | undefined;
  /** Owns a transient interaction until drop, cancellation or unmount. */
  acquireProtection?: (() => () => void) | undefined;
  /** Optional group-aware hit test, including an empty assignee group with no row anchor. */
  resolveDrop?: ((source: TaskDto, over: Element | null, point: { x: number; y: number }) => DropTarget | null) | undefined;
  onDrop?: ((source: TaskDto, target: DropTarget) => void) | undefined;
}

/** The page/drawer owns the QueryClient; standalone presentation tables need no provider. */
export function usePointerRowDragProtection(): () => () => void {
  const client = useQueryClient();
  return useCallback(() => {
    const entry = protectedDraftsFor(client).register();
    entry.set(true);
    return entry.dispose;
  }, [client]);
}

/**
 * Pointer reorder over `tr[data-task-row]` rows. Nothing moves locally: the drop only calls
 * `onMove`, and the refetched list stays the authoritative order. Escape cancels.
 */
export function usePointerRowDrag(options: PointerRowDragOptions) {
  const [drag, setDrag] = useState<{ taskId: string; task: TaskDto; target: DropTarget | null; pointer: { x: number; y: number } } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const dragHead = useRef(options);
  useLayoutEffect(() => { dragHead.current = options; });
  const startDrag = useCallback((source: TaskDto, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    // No text selection or native drag image while the pointer reorders.
    event.preventDefault();
    if (dragHead.current.blocked) return;
    dragCleanup.current?.();
    // Register in the pointerdown stack, before a queued live head can refresh the rows.
    const releaseProtection = dragHead.current.acquireProtection?.();
    const start = { x: event.clientX, y: event.clientY };
    const contextKey = dragHead.current.contextKey;
    // Only the pointer that started the drag moves, drops or cancels it.
    const pointerId = event.pointerId;
    const own = (other: PointerEvent) => other.pointerId === pointerId;
    let lastPoint = start; let lastOver: Element | null = null;
    let active = false;
    let frame: number | null = null;
    // One hit test for every caller: the element under the stationary or moved point, else the fallback.
    const resolveTarget = (fallback: Element | null): DropTarget | null => {
      const head = dragHead.current;
      const current = head.taskById.get(source.id);
      // A real hit-test miss means outside the viewport; only environments without hit testing use the fallback.
      const over = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(lastPoint.x, lastPoint.y) : fallback;
      lastOver = over;
      const row = over?.closest<HTMLElement>('tr[data-task-row]');
      const anchor = row ? head.taskById.get(row.dataset.taskRow ?? '') : undefined;
      if (current && head.resolveDrop) return head.resolveDrop(current, over, lastPoint);
      if (current && row && anchor) {
        const rect = row.getBoundingClientRect();
        const placement: TaskDropPlacement = lastPoint.y < rect.top + rect.height / 2 ? 'before' : 'after';
        if (head.dropAllowed(current, anchor, placement)) return { taskId: anchor.id, placement };
      }
      return null;
    };
    const hitTest = (fallback: Element | null) => {
      setDrag({ taskId: source.id, task: source, target: resolveTarget(fallback), pointer: lastPoint });
    };
    const stale = () => dragHead.current.blocked || dragHead.current.contextKey !== contextKey;
    const tick = () => {
      frame = null;
      if (stale()) { finish(false); return; }
      if (scrollDragEdge(lastPoint, lastOver)) hitTest(lastOver?.isConnected ? lastOver : null);
      frame = requestAnimationFrame(tick);
    };
    // Wheel, keyboard or programmatic scrolling of the page or any scrollport moves rows under a still pointer.
    const scrolled = () => {
      if (!active) return;
      if (stale()) { finish(false); return; }
      hitTest(lastOver?.isConnected ? lastOver : null);
    };
    const track = (moved: PointerEvent) => {
      if (!own(moved)) return;
      if (!active && Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < 4) return;
      active = true;
      lastPoint = { x: moved.clientX, y: moved.clientY };
      hitTest(moved.target instanceof Element ? moved.target : null);
      if (frame === null) frame = requestAnimationFrame(tick);
    };
    const finish = (commit: boolean, released?: PointerEvent) => {
      dragCleanup.current?.();
      if (!commit || !active) return;
      const head = dragHead.current;
      if (head.contextKey !== contextKey || head.blocked) return;
      if (released) lastPoint = { x: released.clientX, y: released.clientY };
      // A fresh hit at the release point: a target drawn before a scroll or re-render never commits.
      const target = resolveTarget(lastOver?.isConnected ? lastOver : null);
      // The row as currently loaded supplies the revision the move is guarded by.
      const current = head.taskById.get(source.id);
      if (!target || !current) return;
      const anchor = target.taskId ? head.taskById.get(target.taskId) : undefined;
      if (head.onDrop) head.onDrop(current, target);
      else if (anchor && head.dropAllowed(current, anchor, target.placement)) head.onMove?.(current, anchor, target.placement);
    };
    const up = (released: PointerEvent) => { if (own(released)) finish(true, released); };
    const pointerCancel = (cancelled: PointerEvent) => { if (own(cancelled)) finish(false); };
    const cancel = () => finish(false);
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('scroll', scrolled, true);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('keydown', escape, true);
    dragCleanup.current = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('scroll', scrolled, true);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('keydown', escape, true);
      dragCleanup.current = null;
      releaseProtection?.();
      setDrag(null);
    };
  }, []);
  return { drag, startDrag };
}
