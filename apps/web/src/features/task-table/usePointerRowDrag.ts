import type { TaskDto } from '@workloom/contracts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TaskDropPlacement } from './TaskTable';

export interface DropTarget { taskId: string; placement: TaskDropPlacement }

export interface PointerRowDragOptions {
  /** Rows that may be dropped on, as currently loaded; their revisions guard the move. */
  taskById: ReadonlyMap<string, TaskDto>;
  dropAllowed: (source: TaskDto, anchor: TaskDto, placement: TaskDropPlacement) => boolean;
  onMove: ((task: TaskDto, anchor: TaskDto, placement: TaskDropPlacement) => void) | undefined;
  /** A task command is unresolved: a drag neither starts nor commits. */
  blocked: boolean;
}

/**
 * Pointer reorder over `tr[data-task-row]` rows. Nothing moves locally: the drop only calls
 * `onMove`, and the refetched list stays the authoritative order. Escape cancels.
 */
export function usePointerRowDrag(options: PointerRowDragOptions) {
  const [drag, setDrag] = useState<{ taskId: string; target: DropTarget | null } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);
  const dragHead = useRef(options);
  useLayoutEffect(() => { dragHead.current = options; });
  const startDrag = useCallback((source: TaskDto, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    // No text selection or native drag image while the pointer reorders.
    event.preventDefault();
    if (dragHead.current.blocked) return;
    dragCleanup.current?.();
    const start = { x: event.clientX, y: event.clientY };
    let active = false;
    let target: DropTarget | null = null;
    const track = (moved: PointerEvent) => {
      if (!active && Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < 4) return;
      active = true;
      // Touch keeps the pointer captured on the handle, so hit-test the point itself when possible.
      const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(moved.clientX, moved.clientY) : null;
      const over = hit ?? (moved.target instanceof Element ? moved.target : null);
      const row = over?.closest<HTMLElement>('tr[data-task-row]');
      const anchor = row ? dragHead.current.taskById.get(row.dataset.taskRow ?? '') : undefined;
      target = null;
      if (row && anchor) {
        const rect = row.getBoundingClientRect();
        const placement: TaskDropPlacement = moved.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        if (dragHead.current.dropAllowed(source, anchor, placement)) target = { taskId: anchor.id, placement };
      }
      setDrag({ taskId: source.id, target });
    };
    const finish = (commit: boolean) => {
      dragCleanup.current?.();
      const head = dragHead.current;
      // The row as currently loaded supplies the revision the move is guarded by.
      const current = head.taskById.get(source.id);
      const anchor = target ? head.taskById.get(target.taskId) : undefined;
      if (commit && active && target && current && anchor && !head.blocked && head.dropAllowed(current, anchor, target.placement)) head.onMove?.(current, anchor, target.placement);
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape') { key.preventDefault(); key.stopPropagation(); finish(false); } };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
    dragCleanup.current = () => {
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      dragCleanup.current = null;
      setDrag(null);
    };
  }, []);
  return { drag, startDrag };
}
