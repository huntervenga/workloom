import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { scrollDragEdge } from './dragAutoScroll';
import { selectTaskRows } from './taskSelection';

export interface SelectionOutcome { ids: string[]; anchor: string | null; limitReached?: boolean }

export interface PointerRangeSelectOptions {
  /** Selection is off or paused: a press neither starts nor extends a range. */
  disabled: boolean;
  /** The current selection, read when a press starts and restored on Escape. */
  selected: readonly string[];
  anchor: () => string | null;
  /** Visible saved row ids in display order, read fresh on every hit test. */
  visibleRowIds: () => string[];
  /** Applies a computed selection; returns whether it was accepted (within the cap). */
  apply: (next: SelectionOutcome) => boolean;
}

/**
 * Mouse/pen range selection by pressing a row's selection gutter and sweeping over other
 * `tr[data-task-row]` rows: the rows between the pressed one and the pointer are selected live.
 * Ctrl/Cmd adds the range to the existing selection and Shift keeps the existing anchor, like the
 * click and keyboard variants. A press that stays inside its own row remains an ordinary click.
 * Escape restores the selection the press started from; touch keeps scrolling.
 */
export function usePointerRangeSelect(options: PointerRangeSelectOptions) {
  const [active, setActive] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const head = useRef(options);
  useLayoutEffect(() => { head.current = options; });
  // The click a release synthesizes on the pressed gutter would collapse the swept range to one row.
  const swallowClick = useRef(false);
  const start = useCallback((pressedId: string, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === 'touch') return;
    if (head.current.disabled) return;
    cleanup.current?.();
    swallowClick.current = false;
    const base = [...head.current.selected];
    const baseAnchor = head.current.anchor();
    const additive = event.ctrlKey || event.metaKey;
    // Shift extends from the current anchor, as Shift+click does; otherwise the pressed row anchors the range.
    const rangeAnchor = event.shiftKey && baseAnchor !== null && head.current.visibleRowIds().includes(baseAnchor) ? baseAnchor : pressedId;
    // Only the pointer that pressed the gutter extends, finishes or cancels the range.
    const pointerId = event.pointerId;
    const own = (other: PointerEvent) => other.pointerId === pointerId;
    let lastPoint = { x: event.clientX, y: event.clientY };
    let lastOver: Element | null = null;
    let lastTarget: string | null = null;
    let sweeping = false;
    let frame: number | null = null;
    const rowAt = (fallback: Element | null): string | null => {
      // A real hit-test miss means outside the viewport; only environments without hit testing use the fallback.
      const over = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(lastPoint.x, lastPoint.y) : fallback;
      lastOver = over;
      return over?.closest<HTMLElement>('tr[data-task-row]')?.dataset.taskRow ?? null;
    };
    const extend = (fallback: Element | null) => {
      if (head.current.disabled) { finish(false); return; }
      const target = rowAt(fallback);
      // Another row starts the sweep; a press that wobbles inside its own row stays a click.
      if (target === null || target === lastTarget || (!sweeping && target === pressedId)) return;
      const visible = head.current.visibleRowIds();
      if (!visible.includes(target) || !visible.includes(rangeAnchor)) return;
      if (!sweeping) { sweeping = true; setActive(true); document.getSelection?.()?.removeAllRanges(); }
      lastTarget = target;
      head.current.apply(selectTaskRows(base, visible, rangeAnchor, target, { shiftKey: true, ctrlKey: additive }));
    };
    const tick = () => {
      frame = null;
      if (scrollDragEdge(lastPoint, lastOver)) extend(lastOver?.isConnected ? lastOver : null);
      if (cleanup.current !== null) frame = requestAnimationFrame(tick);
    };
    // Wheel, keyboard or programmatic scrolling moves rows under a still pointer.
    const scrolled = () => { if (sweeping) extend(lastOver?.isConnected ? lastOver : null); };
    const track = (moved: PointerEvent) => {
      if (!own(moved)) return;
      lastPoint = { x: moved.clientX, y: moved.clientY };
      extend(moved.target instanceof Element ? moved.target : null);
      if (sweeping && frame === null) frame = requestAnimationFrame(tick);
    };
    const finish = (restore: boolean) => {
      cleanup.current?.();
      if (!sweeping) return;
      if (restore) head.current.apply({ ids: base, anchor: baseAnchor });
      // The release's click, if any, arrives in this same task; a cancel without a release clears the flag.
      swallowClick.current = true;
      setTimeout(() => { swallowClick.current = false; }, 0);
    };
    const up = (released: PointerEvent) => { if (own(released)) finish(false); };
    const pointerCancel = (cancelled: PointerEvent) => { if (own(cancelled)) finish(false); };
    const cancel = () => finish(false);
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    const escape = (key: KeyboardEvent) => { if (key.key === 'Escape' && sweeping) { key.preventDefault(); key.stopPropagation(); finish(true); } };
    // Sweeping across titles must not select their text.
    const noTextSelection = (selecting: Event) => { if (sweeping) selecting.preventDefault(); };
    window.addEventListener('pointermove', track);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('scroll', scrolled, true);
    document.addEventListener('visibilitychange', hidden);
    document.addEventListener('selectstart', noTextSelection);
    window.addEventListener('keydown', escape, true);
    cleanup.current = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      window.removeEventListener('pointermove', track);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('scroll', scrolled, true);
      document.removeEventListener('visibilitychange', hidden);
      document.removeEventListener('selectstart', noTextSelection);
      window.removeEventListener('keydown', escape, true);
      cleanup.current = null;
      setActive(false);
    };
  }, []);
  /** Whether the click now being handled only closes a sweep and must not reselect its row. */
  const consumeClick = useCallback(() => {
    const swallowed = swallowClick.current;
    swallowClick.current = false;
    return swallowed;
  }, []);
  return { active, start, consumeClick };
}
