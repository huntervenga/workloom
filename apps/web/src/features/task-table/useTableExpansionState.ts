import { useCallback, useMemo, useRef, useState } from 'react';

export interface TableExpansionScope {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly projectId: string;
}

export interface TableExpansionControls {
  readonly expandedTaskIds: ReadonlySet<string>;
  readonly collapsedGroupKeys: ReadonlySet<string>;
  readonly setTaskCollapsed: (taskId: string, collapsed: boolean) => void;
  readonly setGroupCollapsed: (groupKey: string, collapsed: boolean) => void;
}

interface ExpansionPreferences {
  readonly expandedTaskIds: ReadonlySet<string>;
  readonly collapsedGroupKeys: ReadonlySet<string>;
}

const VERSION = 1;
const MAX_TASK_OVERRIDES = 5_000;
const MAX_GROUP_OVERRIDES = 1_000;
const MAX_STORED_LENGTH = 512_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validGroupKey = (key: string) => key === 'no-section' || key === 'unassigned'
  || /^(section|missing|assignee):/.test(key) && UUID.test(key.slice(key.indexOf(':') + 1));
const emptyPreferences = (): ExpansionPreferences => ({ expandedTaskIds: new Set(), collapsedGroupKeys: new Set() });

/** Browser preference identity uses UUIDs, so renaming a company address never loses it. */
export function tableExpansionStorageKey(scope: TableExpansionScope): string {
  return `workloom.table-expansion.v${VERSION}:${scope.actorId.toLowerCase()}:${scope.workspaceId.toLowerCase()}:${scope.projectId.toLowerCase()}`;
}

function browserStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

function readPreferences(key: string): ExpansionPreferences {
  try {
    const raw = browserStorage()?.getItem(key);
    if (!raw || raw.length > MAX_STORED_LENGTH) return emptyPreferences();
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyPreferences();
    const record = value as Record<string, unknown>;
    const tasks = record.expandedTaskIds, groups = record.collapsedGroupKeys;
    if (record.version !== VERSION || !Array.isArray(tasks) || !Array.isArray(groups)
      || tasks.length > MAX_TASK_OVERRIDES || groups.length > MAX_GROUP_OVERRIDES
      || !tasks.every(id => typeof id === 'string' && UUID.test(id))
      || !groups.every(id => typeof id === 'string' && validGroupKey(id))) return emptyPreferences();
    return { expandedTaskIds: new Set(tasks), collapsedGroupKeys: new Set(groups) };
  } catch { return emptyPreferences(); }
}

function persist(key: string, preference: ExpansionPreferences): void {
  try {
    browserStorage()?.setItem(key, JSON.stringify({ version: VERSION,
      expandedTaskIds: [...preference.expandedTaskIds], collapsedGroupKeys: [...preference.collapsedGroupKeys] }));
  } catch { /* Storage may be disabled or full. The current page still works in memory. */ }
}

/** Old/unloaded IDs are not pruned by a filter or partial page; oldest overrides leave only at the cap. */
function changedSet(before: ReadonlySet<string>, id: string, present: boolean, limit: number): ReadonlySet<string> {
  if (before.has(id) === present) return before;
  const next = new Set(before);
  if (present) next.add(id); else next.delete(id);
  while (next.size > limit) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/** Tasks start collapsed; groups start expanded. Only explicit changes write browser storage. */
export function useTableExpansionState(scope: TableExpansionScope, loadedTaskIds: readonly string[]) {
  const key = tableExpansionStorageKey(scope);
  const [state, setState] = useState(() => ({ key, preference: readPreferences(key) }));
  let current = state;
  if (state.key !== key) {
    // Adjust before committing a changed scope, rather than briefly painting another person's state.
    current = { key, preference: readPreferences(key) };
    setState(current);
  }
  const head = useRef(current);
  head.current = current;

  const update = useCallback((kind: 'task' | 'group', id: string, collapsed: boolean) => {
    if (head.current.key !== key || (kind === 'task' ? !UUID.test(id) : !validGroupKey(id))) return;
    const before = head.current.preference;
    const field = kind === 'task' ? 'expandedTaskIds' : 'collapsedGroupKeys';
    const next = changedSet(before[field], id, kind === 'task' ? !collapsed : collapsed,
      kind === 'task' ? MAX_TASK_OVERRIDES : MAX_GROUP_OVERRIDES);
    if (next === before[field]) return;
    const value = { key, preference: { ...before, [field]: next } };
    head.current = value;
    setState(value);
    persist(key, value.preference);
  }, [key]);
  const setTaskCollapsed = useCallback((taskId: string, collapsed: boolean) => update('task', taskId, collapsed), [update]);
  const setGroupCollapsed = useCallback((groupKey: string, collapsed: boolean) => update('group', groupKey, collapsed), [update]);
  const expanded = current.preference.expandedTaskIds;
  const collapsedTaskIds = useMemo(() => new Set(loadedTaskIds.filter(id => !expanded.has(id))), [loadedTaskIds, expanded]);
  return { collapsedTaskIds, expandedTaskIds: expanded, collapsedGroupKeys: current.preference.collapsedGroupKeys, setTaskCollapsed, setGroupCollapsed };
}
