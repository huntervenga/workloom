import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from '../../i18n';
import { clampColumnWidth, columnWidthLimits } from './useLocalTableLayout';

interface Props {
  columnId: string;
  label: string;
  width: number;
  onPreview: (width: number | null) => void;
  onCommit: (width: number | null) => void;
}
interface Gesture {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
  restore: () => void;
}

/** One header edge: preview during capture, persist on release, cancel without saving. */
export function ColumnResizeHandle({ columnId, label, width, onPreview, onCommit }: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const latest = useRef({ onPreview, onCommit });
  latest.current = { onPreview, onCommit };
  const [measured, setMeasured] = useState(width);
  const [dragging, setDragging] = useState(false);
  const limits = columnWidthLimits(columnId);
  const actualWidth = () => ref.current?.closest('th')?.getBoundingClientRect().width || width;

  useLayoutEffect(() => {
    const header = ref.current?.closest('th');
    if (!header) return;
    const measure = () => setMeasured(Math.round(header.getBoundingClientRect().width) || width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, [width]);

  const finish = (commit: boolean, mounted = true) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    active.restore();
    if (commit && active.width !== active.startWidth) latest.current.onCommit(active.width);
    latest.current.onPreview(null);
    if (mounted) setDragging(false);
    if (ref.current?.hasPointerCapture?.(active.pointerId)) ref.current.releasePointerCapture(active.pointerId);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useEffect(() => {
    const cancel = () => finishRef.current(false);
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); finishRef.current(false, false); };
  }, []);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false || gesture.current) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    const style = event.currentTarget.ownerDocument.body.style;
    const cursor = style.cursor, userSelect = style.userSelect;
    style.cursor = 'col-resize'; style.userSelect = 'none';
    const startWidth = Math.round(actualWidth());
    gesture.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, width: startWidth,
      restore: () => { style.cursor = cursor; style.userSelect = userSelect; } };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    active.width = clampColumnWidth(columnId, active.startWidth + event.clientX - active.startX);
    if (frame.current === null) frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (gesture.current) latest.current.onPreview(gesture.current.width);
    });
  };

  return <div ref={ref} role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={t('taskTable.resize.label', { name: label })} aria-valuemin={limits.min} aria-valuemax={limits.max}
    aria-valuenow={measured} title={t('taskTable.resize.hint')}
    data-column-resize={columnId} data-resizing={dragging || undefined}
    className="group/resize absolute inset-y-0 right-0 z-[2] w-2 cursor-col-resize touch-none select-none outline-none hover:bg-accent-soft focus-visible:bg-accent-soft"
    onPointerDown={start} onPointerMove={move}
    onPointerUp={event => { if (gesture.current?.pointerId === event.pointerId) { move(event); finish(true); } }}
    onPointerCancel={() => finish(false)} onLostPointerCapture={() => finish(false)}
    onDoubleClick={event => { event.preventDefault(); event.stopPropagation(); onCommit(null); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); finish(false); return; }
      if (gesture.current || event.altKey || event.metaKey || event.ctrlKey) return;
      const step = event.shiftKey ? 64 : 16;
      const next = event.key === 'ArrowLeft' ? actualWidth() - step : event.key === 'ArrowRight' ? actualWidth() + step
        : event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : undefined;
      if (next !== undefined || event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault(); event.stopPropagation();
        onCommit(next === undefined ? null : clampColumnWidth(columnId, next));
      }
    }}><span aria-hidden="true" className="absolute inset-y-1 right-0 w-px bg-line group-hover/resize:bg-accent group-focus-visible/resize:bg-accent group-data-[resizing=true]/resize:bg-accent" /></div>;
}
