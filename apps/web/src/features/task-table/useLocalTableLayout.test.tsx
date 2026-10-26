import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tableLayoutStorageKey, useLocalTableLayout, type TableLayoutScope } from './useLocalTableLayout';

const scope: TableLayoutScope = { actorId: 'a0000000-0000-4000-8000-000000000001', workspaceId: 'a0000000-0000-4000-8000-000000000002', projectId: 'a0000000-0000-4000-8000-000000000003' };
const fieldId = 'a0000000-0000-4000-8000-000000000004';
const key = tableLayoutStorageKey(scope);
afterEach(() => vi.restoreAllMocks());

describe('local table layout preferences', () => {
  it('writes only explicit changes, retains hidden field widths, and restores after remount', () => {
    const save = vi.spyOn(Storage.prototype, 'setItem');
    const ui = renderHook(() => useLocalTableLayout(scope));
    expect(save).not.toHaveBeenCalled();
    act(() => { ui.result.current.setColumnWidth('title', 412); ui.result.current.setColumnWidth(fieldId, 228); });
    expect(JSON.parse(localStorage.getItem(key) ?? '{}')).toEqual({ version: 1, columnWidths: { title: 412, [fieldId]: 228 } });
    ui.unmount();
    const next = renderHook(() => useLocalTableLayout(scope));
    expect(next.result.current.columnWidths).toEqual({ title: 412, [fieldId]: 228 });
    act(() => next.result.current.setColumnWidth('title', null));
    expect(next.result.current.columnWidths).toEqual({ [fieldId]: 228 });
    expect(save).toHaveBeenCalledTimes(3);
  });

  it.each(['actorId', 'workspaceId', 'projectId'] as const)('isolates %s and refuses a previous scope callback', property => {
    const ui = renderHook(({ selected }) => useLocalTableLayout(selected), { initialProps: { selected: scope } });
    act(() => ui.result.current.setColumnWidth('status', 250));
    const old = ui.result.current.setColumnWidth;
    ui.rerender({ selected: { ...scope, [property]: fieldId } });
    expect(ui.result.current.columnWidths).toEqual({});
    act(() => old('status', 400));
    expect(ui.result.current.columnWidths).toEqual({});
    ui.rerender({ selected: scope });
    expect(ui.result.current.columnWidths.status).toBe(250);
  });

  it.each(['broken JSON', '{"version":2,"columnWidths":{"status":200}}', '{"version":1,"columnWidths":{"status":-10}}', '{"version":1,"columnWidths":{"title":1000000000}}', '{"version":1,"columnWidths":{"__proto__":200}}'])('ignores malformed or unsupported storage: %s', value => {
    localStorage.setItem(key, value);
    const ui = renderHook(() => useLocalTableLayout(scope));
    expect(ui.result.current.columnWidths).toEqual({});
    expect(localStorage.getItem(key)).toBe(value);
  });

  it('keeps widths in memory if storage is blocked and clamps changes to usable bounds', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('Blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('Full'); });
    const ui = renderHook(() => useLocalTableLayout(scope));
    act(() => { ui.result.current.setColumnWidth('title', 1); ui.result.current.setColumnWidth('status', 9999); });
    expect(ui.result.current.columnWidths).toEqual({ title: 200, status: 1200 });
    act(() => ui.result.current.setColumnWidth('status', Number.NaN));
    expect(ui.result.current.columnWidths.status).toBe(1200);
  });

  it('reflects changes from another tab without writing them back', () => {
    const ui = renderHook(() => useLocalTableLayout(scope));
    const value = JSON.stringify({ version: 1, columnWidths: { status: 240 } });
    localStorage.setItem(key, value);
    const save = vi.spyOn(Storage.prototype, 'setItem');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: value })));
    expect(ui.result.current.columnWidths).toEqual({ status: 240 });
    expect(save).not.toHaveBeenCalled();
    expect(tableLayoutStorageKey({ actorId: scope.actorId.toUpperCase(), workspaceId: scope.workspaceId.toUpperCase(), projectId: scope.projectId.toUpperCase() })).toBe(key);
  });
});
