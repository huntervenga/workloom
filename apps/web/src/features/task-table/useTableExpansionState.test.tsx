import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tableExpansionStorageKey, useTableExpansionState, type TableExpansionScope } from './useTableExpansionState';

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope: TableExpansionScope = { actorId: id(1), workspaceId: id(2), projectId: id(3) };
const task = id(4), child = id(5), grandchild = id(6), other = id(7);
const section = `section:${id(8)}`, person = `assignee:${id(9)}`;
const key = tableExpansionStorageKey(scope);
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

function example(initialTasks = [task, child, grandchild]) {
  return renderHook(({ selected, tasks }: { selected: TableExpansionScope; tasks: readonly string[] }) => useTableExpansionState(selected, tasks),
    { initialProps: { selected: scope, tasks: initialTasks } });
}

describe('personal browser task expansion preferences', () => {
  it('starts every task collapsed and every group expanded without writing on view/refetch', () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const ui = example();
    expect([...ui.result.current.collapsedTaskIds]).toEqual([task, child, grandchild]);
    expect(ui.result.current.collapsedGroupKeys.size).toBe(0);
    ui.rerender({ selected: { ...scope }, tasks: [task, child, grandchild, other] });
    expect(ui.result.current.collapsedTaskIds.has(other)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
  it('restores nested expanded tasks and collapsed sections/people after a complete remount', () => {
    const ui = example();
    act(() => { ui.result.current.setTaskCollapsed(task, false); ui.result.current.setTaskCollapsed(child, false); ui.result.current.setGroupCollapsed(section, true); ui.result.current.setGroupCollapsed(person, true); });
    expect([...ui.result.current.expandedTaskIds]).toEqual([task, child]);
    const raw = JSON.parse(localStorage.getItem(key) ?? '{}');
    expect(raw).toEqual({ version: 1, expandedTaskIds: [task, child], collapsedGroupKeys: [section, person] });
    ui.unmount();
    const reloaded = example();
    expect([...reloaded.result.current.collapsedTaskIds]).toEqual([grandchild]);
    expect([...reloaded.result.current.collapsedGroupKeys]).toEqual([section, person]);
    act(() => { reloaded.result.current.setTaskCollapsed(task, true); reloaded.result.current.setGroupCollapsed(section, false); });
    reloaded.unmount();
    const again = example();
    expect([...again.result.current.expandedTaskIds]).toEqual([child]);
    expect([...again.result.current.collapsedGroupKeys]).toEqual([person]);
  });
  it('does not forget filtered, unloaded or temporarily missing task/group choices', () => {
    const ui = example();
    act(() => { ui.result.current.setTaskCollapsed(task, false); ui.result.current.setTaskCollapsed(child, false); ui.result.current.setGroupCollapsed(section, true); });
    ui.rerender({ selected: scope, tasks: [] });
    expect(ui.result.current.collapsedTaskIds.size).toBe(0);
    ui.rerender({ selected: scope, tasks: [other] });
    expect(ui.result.current.collapsedTaskIds.has(other)).toBe(true);
    ui.rerender({ selected: scope, tasks: [task, child, grandchild] });
    expect([...ui.result.current.collapsedTaskIds]).toEqual([grandchild]);
    expect(ui.result.current.collapsedGroupKeys.has(section)).toBe(true);
  });
  it.each(['actorId', 'workspaceId', 'projectId'] as const)('isolates %s immediately and rejects a previous scope callback', property => {
    const ui = example();
    act(() => { ui.result.current.setTaskCollapsed(task, false); ui.result.current.setGroupCollapsed(section, true); });
    const stale = ui.result.current.setTaskCollapsed;
    const selected = { ...scope, [property]: id(20) };
    ui.rerender({ selected, tasks: [task, child] });
    expect([...ui.result.current.collapsedTaskIds]).toEqual([task, child]);
    expect(ui.result.current.collapsedGroupKeys.size).toBe(0);
    act(() => stale(child, false));
    expect(ui.result.current.expandedTaskIds.size).toBe(0);
    expect(localStorage.getItem(tableExpansionStorageKey(selected))).toBeNull();
    ui.rerender({ selected: scope, tasks: [task, child] });
    expect([...ui.result.current.expandedTaskIds]).toEqual([task]);
    expect(ui.result.current.collapsedGroupKeys.has(section)).toBe(true);
  });
  it('uses canonical UUID identities independently of company slug and casing', () => {
    expect(tableExpansionStorageKey({ actorId: scope.actorId.toUpperCase(), workspaceId: scope.workspaceId.toUpperCase(), projectId: scope.projectId.toUpperCase() })).toBe(key);
    expect(key).not.toContain('balancy');
  });
  it.each(['{broken', '{"version":2,"expandedTaskIds":[],"collapsedGroupKeys":[]}', '{"version":1,"expandedTaskIds":["a task title"],"collapsedGroupKeys":[]}', '{"version":1,"expandedTaskIds":[],"collapsedGroupKeys":["my section name"]}'])('ignores malformed/unknown saved data without rewriting it', saved => {
    localStorage.setItem(key, saved);
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const ui = example();
    expect([...ui.result.current.collapsedTaskIds]).toEqual([task, child, grandchild]);
    expect(ui.result.current.collapsedGroupKeys.size).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });
  it('works in memory when storage access or writes are blocked', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    const ui = example();
    act(() => { ui.result.current.setTaskCollapsed(task, false); ui.result.current.setGroupCollapsed(section, true); });
    expect(ui.result.current.collapsedTaskIds.has(task)).toBe(false);
    expect(ui.result.current.collapsedGroupKeys.has(section)).toBe(true);
    read.mockRestore(); write.mockRestore();
  });
  it('writes one change under StrictMode, skips redundant changes and never persists arbitrary labels', () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const ui = renderHook(() => useTableExpansionState(scope, [task]), { wrapper });
    expect(save).not.toHaveBeenCalled();
    act(() => ui.result.current.setTaskCollapsed(task, false));
    expect(save).toHaveBeenCalledTimes(1);
    act(() => { ui.result.current.setTaskCollapsed(task, false); ui.result.current.setTaskCollapsed('A private task title', false); ui.result.current.setGroupCollapsed('A section name', true); });
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('bounds retained overrides without deleting unknown IDs during ordinary loading', () => {
    const expanded = Array.from({ length: 5_000 }, (_, n) => id(n + 100));
    localStorage.setItem(key, JSON.stringify({ version: 1, expandedTaskIds: expanded, collapsedGroupKeys: [] }));
    const ui = example([other]);
    act(() => ui.result.current.setTaskCollapsed(other, false));
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as { expandedTaskIds: string[] };
    expect(saved.expandedTaskIds).toHaveLength(5_000);
    expect(saved.expandedTaskIds).not.toContain(expanded[0]);
    expect(saved.expandedTaskIds.at(-1)).toBe(other);
  });
});
