import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readRememberedView, rememberedParams, useProjectViewMemory } from './projectViewMemory';

const A = 'a0000000-0000-4000-8000-000000000001', W = 'b0000000-0000-4000-8000-000000000001', P = 'c0000000-0000-4000-8000-000000000001', P2 = 'c0000000-0000-4000-8000-000000000002';

describe('remembering how a project was last viewed', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps only view, sort and filters, in a stable order, and never the task pane or an import view', () => {
    expect(rememberedParams(new URLSearchParams('task=x&view=board&tag=t1&sort=due_asc&week=w'))).toBe('view=board&sort=due_asc&tag=t1');
    expect(rememberedParams(new URLSearchParams('view=import&status=s'))).toBe('status=s');
    expect(rememberedParams(new URLSearchParams('sort=due_asc&sort=manual'))).toBe('');
  });

  it('saves a change, and restores it once when the project is opened with a bare address', () => {
    const restore = vi.fn();
    const first = renderHook(({ params, grouping }) => useProjectViewMemory({ actorId: A, workspaceId: W, projectId: P, searchParams: new URLSearchParams(params), grouping, restore }), { initialProps: { params: '', grouping: 'section' } });
    expect(restore).not.toHaveBeenCalled();
    first.rerender({ params: 'view=board&completion=open', grouping: 'assignee' });
    expect(readRememberedView(A, W, P)).toEqual({ params: 'view=board&completion=open', grouping: 'assignee' });
    first.unmount();
    // Back again from the sidebar: bare address, so the last view returns.
    renderHook(() => useProjectViewMemory({ actorId: A, workspaceId: W, projectId: P, searchParams: new URLSearchParams(''), grouping: 'section', restore }));
    expect(restore).toHaveBeenCalledWith('view=board&completion=open', 'assignee');
    // The restore must not have wiped what it is restoring.
    expect(readRememberedView(A, W, P)).toEqual({ params: 'view=board&completion=open', grouping: 'assignee' });
  });

  it('lets a link with its own choices win, and keeps projects and people apart', () => {
    window.localStorage.setItem(`workloom.projectView.${A}.${W}.${P}`, JSON.stringify({ params: 'view=graph', grouping: 'section' }));
    const restore = vi.fn();
    renderHook(() => useProjectViewMemory({ actorId: A, workspaceId: W, projectId: P, searchParams: new URLSearchParams('view=board'), grouping: 'section', restore }));
    expect(restore).not.toHaveBeenCalled();
    renderHook(() => useProjectViewMemory({ actorId: A, workspaceId: W, projectId: P2, searchParams: new URLSearchParams(''), grouping: 'section', restore }));
    renderHook(() => useProjectViewMemory({ actorId: 'someone-else', workspaceId: W, projectId: P, searchParams: new URLSearchParams(''), grouping: 'section', restore }));
    expect(restore).not.toHaveBeenCalled();
  });

  it('forgets the record when the view returns to the default', () => {
    const hook = renderHook(({ params }) => useProjectViewMemory({ actorId: A, workspaceId: W, projectId: P, searchParams: new URLSearchParams(params), grouping: 'section', restore: vi.fn() }), { initialProps: { params: 'view=board' } });
    expect(readRememberedView(A, W, P)?.params).toBe('view=board');
    hook.rerender({ params: '' });
    expect(readRememberedView(A, W, P)).toBeNull();
  });
});
