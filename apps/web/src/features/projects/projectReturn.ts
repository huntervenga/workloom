import { useEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';

interface ReturnPoint {
  x: number;
  y: number;
  tableLeft: number | null;
  selected: string[];
}
const POINTS = new Map<string, ReturnPoint>();
const tableSelector = 'main [data-task-table-scroll]';
const key = (actorId: string, workspaceId: string, locationKey: string) => `${actorId}:${workspaceId}:${locationKey}`;

/** Save the list context immediately before opening a related task in the same tab. */
export function rememberProjectReturn(actorId: string, workspaceId: string, locationKey: string): void {
  const table = document.querySelector<HTMLElement>(tableSelector);
  if (!table) return;
  const id = key(actorId, workspaceId, locationKey);
  POINTS.delete(id);
  POINTS.set(id, {
    x: window.scrollX, y: window.scrollY, tableLeft: table.scrollLeft,
    selected: Array.from(table.querySelectorAll<HTMLElement>('[data-task-row][aria-selected="true"]'))
      .map(row => row.dataset.taskRow ?? '').filter(Boolean).slice(0, 100),
  });
  if (POINTS.size > 32) {
    const first = POINTS.keys().next().value;
    if (first !== undefined) POINTS.delete(first);
  }
}

export function useProjectReturn(actorId: string, workspaceId: string, ready: boolean, onRestore: (ids: string[]) => void): void {
  const location = useLocation();
  const navigation = useNavigationType();
  const restore = useRef(onRestore);
  restore.current = onRestore;
  const id = key(actorId, workspaceId, location.key);
  useEffect(() => {
    if (navigation !== 'POP' || !ready) return;
    const point = POINTS.get(id);
    if (!point) return;
    let attempts = 0;
    let frame = 0;
    const cancel = () => { POINTS.delete(id); window.cancelAnimationFrame(frame); };
    const apply = () => {
      if (!POINTS.has(id)) return;
      const table = document.querySelector<HTMLElement>(tableSelector);
      if (!table && attempts++ < 20) { frame = window.requestAnimationFrame(apply); return; }
      POINTS.delete(id);
      if (!table) return;
      const present = new Set(Array.from(table.querySelectorAll<HTMLElement>('[data-task-row]')).map(row => row.dataset.taskRow));
      restore.current(point.selected.filter(taskId => present.has(taskId)));
      if (point.tableLeft !== null) table.scrollLeft = point.tableLeft;
      window.scrollTo({ left: point.x, top: point.y, behavior: 'instant' });
    };
    frame = window.requestAnimationFrame(apply);
    window.addEventListener('wheel', cancel, { once: true, passive: true });
    window.addEventListener('touchstart', cancel, { once: true, passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchstart', cancel);
    };
  }, [id, navigation, ready]);
}
