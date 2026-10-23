import { useEffect, useRef } from 'react';

/** The URL parameters that make up "how I look at this project": view, sort and the validated filters. */
const REMEMBERED = ['view', 'sort', 'completion', 'status', 'participant', 'tag', 'includeArchived'] as const;
const VIEWS = new Set(['board', 'graph', 'gantt']);
const GROUPINGS = new Set(['section', 'assignee']);

export interface RememberedView { readonly params: string; readonly grouping: string }

const storageKey = (actorId: string, workspaceId: string, projectId: string) => `workloom.projectView.${actorId}.${workspaceId}.${projectId}`;

/** Only the remembered keys, in a stable order; an import or unknown view is never remembered. */
export function rememberedParams(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of REMEMBERED) {
    const values = params.getAll(key);
    if (values.length !== 1) continue;
    const value = values[0] ?? '';
    if (key === 'view' && !VIEWS.has(value)) continue;
    kept.set(key, value);
  }
  return kept.toString();
}

export function readRememberedView(actorId: string, workspaceId: string, projectId: string): RememberedView | null {
  try {
    const raw = window.localStorage.getItem(storageKey(actorId, workspaceId, projectId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RememberedView>;
    if (typeof value.params !== 'string' || typeof value.grouping !== 'string' || value.params.length > 400) return null;
    return { params: rememberedParams(new URLSearchParams(value.params)), grouping: GROUPINGS.has(value.grouping) ? value.grouping : 'section' };
  } catch { return null; }
}

function writeRememberedView(actorId: string, workspaceId: string, projectId: string, value: RememberedView): void {
  try {
    const key = storageKey(actorId, workspaceId, projectId);
    if (value.params === '' && value.grouping === 'section') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage is optional; the view simply starts fresh next time */ }
}

/**
 * Coming back to a project (from the sidebar, the project list or another page) restores the view, sort, filters and grouping
 * the person last used there, as long as the address itself carries no choice of its own. A shared link always wins.
 */
export function useProjectViewMemory(options: {
  actorId: string; workspaceId: string; projectId: string; searchParams: URLSearchParams; grouping: string;
  restore: (params: string, grouping: string) => void;
}): void {
  const { actorId, workspaceId, projectId, searchParams, grouping, restore } = options;
  const restoredFor = useRef<string | null>(null);
  const skipWrite = useRef(false);
  useEffect(() => {
    if (restoredFor.current === projectId) return;
    restoredFor.current = projectId;
    if (searchParams.toString() !== '') return;
    const saved = readRememberedView(actorId, workspaceId, projectId);
    if (!saved || (saved.params === '' && saved.grouping === 'section')) return;
    skipWrite.current = true;
    restore(saved.params, saved.grouping);
  // Runs once per project (the ref); later address changes are the person's own and are saved below.
  }, [actorId, workspaceId, projectId, searchParams, restore]);
  const params = rememberedParams(searchParams);
  useEffect(() => {
    if (skipWrite.current) { skipWrite.current = false; return; }
    if (restoredFor.current !== projectId) return;
    writeRememberedView(actorId, workspaceId, projectId, { params, grouping });
  }, [actorId, workspaceId, projectId, params, grouping]);
}
