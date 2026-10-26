import { useCallback, useEffect, useRef, useState } from 'react';

export interface TableLayoutScope {
  actorId: string;
  workspaceId: string;
  projectId: string;
}

/** Browser-only overrides; shared column definitions and personal visibility stay on the server. */
export interface LocalTableLayout {
  version: 1;
  columnWidths: Readonly<Record<string, number>>;
}

const builtins = new Set(['title', 'status', 'responsible', 'participants', 'dueDate', 'tags', 'priority', 'estimate', 'weekly-plan', 'weekly-fact']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validColumn = (id: string) => builtins.has(id) || uuid.test(id);
const empty = (): LocalTableLayout => ({ version: 1, columnWidths: {} });
export const columnWidthLimits = (id: string) => ({ min: id === 'title' ? 200 : 64, max: 1200 });
export const clampColumnWidth = (id: string, width: number) => {
  const { min, max } = columnWidthLimits(id);
  return Math.max(min, Math.min(max, Math.round(width)));
};

export function tableLayoutStorageKey(scope: TableLayoutScope): string {
  return `workloom.table-layout.v1:${scope.actorId.toLowerCase()}:${scope.workspaceId.toLowerCase()}:${scope.projectId.toLowerCase()}`;
}

function read(key: string | null): LocalTableLayout {
  if (key === null) return empty();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw || raw.length > 32_000) return empty();
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return empty();
    const record = data as Record<string, unknown>;
    if (record.version !== 1 || !record.columnWidths || typeof record.columnWidths !== 'object' || Array.isArray(record.columnWidths)) return empty();
    const entries = Object.entries(record.columnWidths);
    if (entries.length > 210 || entries.some(([id, width]) => !validColumn(id) || typeof width !== 'number' || !Number.isFinite(width) || clampColumnWidth(id, width) !== width)) return empty();
    return { version: 1, columnWidths: Object.fromEntries(entries) };
  } catch { return empty(); }
}

/** A versioned, scoped local layout. Only explicit completed changes write storage. */
export function useLocalTableLayout(scope?: TableLayoutScope) {
  const key = scope ? tableLayoutStorageKey(scope) : null;
  const [state, setState] = useState(() => ({ key, layout: read(key) }));
  let current = state;
  if (state.key !== key) {
    current = { key, layout: read(key) };
    setState(current);
  }
  const head = useRef(current);
  head.current = current;
  useEffect(() => {
    if (key === null) return;
    const storage = (event: StorageEvent) => {
      if (head.current.key !== key || event.key !== null && event.key !== key) return;
      const next = { key, layout: read(key) };
      head.current = next; setState(next);
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [key]);

  const setColumnWidth = useCallback((id: string, width: number | null) => {
    if (head.current.key !== key || !validColumn(id) || width !== null && !Number.isFinite(width)) return;
    const before = head.current.layout.columnWidths;
    const nextWidth = width === null ? undefined : clampColumnWidth(id, width);
    if (before[id] === nextWidth) return;
    const columnWidths = nextWidth === undefined
      ? Object.fromEntries(Object.entries(before).filter(([columnId]) => columnId !== id)) : { ...before, [id]: nextWidth };
    if (Object.keys(columnWidths).length > 210) return;
    const next = { key, layout: { version: 1 as const, columnWidths } };
    head.current = next; setState(next);
    if (key !== null) {
      try { window.localStorage.setItem(key, JSON.stringify(next.layout)); }
      catch { /* Restricted/full storage leaves the current layout usable in memory. */ }
    }
  }, [key]);
  return { key, columnWidths: current.layout.columnWidths, setColumnWidth };
}
