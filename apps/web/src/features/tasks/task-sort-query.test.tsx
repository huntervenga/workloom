import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, installFakeApi, json } from '../../test/fakeApi';
import { normalizeTaskFilters, taskListSearchParams, type TaskListFilters } from './api';
import { useTaskListQuery } from './queries';

const projectId = 'abcdef00-0000-4000-8000-000000000401';
const statusId = 'abcdef00-0000-4000-8000-000000000501';
const tagId = 'abcdef00-0000-4000-8000-000000000801';
describe('server due-sort query identity', () => {
  it('preserves explicit due mode in the request/key while omitted and manual keep the legacy identity', () => {
    const filters = { projectId, statusId, tagId, search: '  needle  ', includeArchived: true };
    const manual = normalizeTaskFilters({ ...filters, sort: 'manual' });
    expect(manual).toEqual(normalizeTaskFilters(filters));
    expect(taskListSearchParams({ ...filters, sort: 'manual' }, 2, null).has('sort')).toBe(false);
    const due = normalizeTaskFilters({ ...filters, sort: 'due_asc' });
    expect(due).toEqual({ ...filters, search: 'needle', sort: 'due_asc' });
    expect(taskListSearchParams(due, 2, null).get('sort')).toBe('due_asc');
    expect(queryKeys.taskList(anna.id, alpha.id, projectId, { ...due, limit: 2 })).not.toEqual(queryKeys.taskList(anna.id, alpha.id, projectId, { ...manual, limit: 2 }));
  });
});

it('rejects unsupported runtime sorts instead of converting them into a successful manual read', () => {
  for (const sort of ['priority', '', ['due_asc', 'manual']]) {
    const malformed = { projectId, sort } as TaskListFilters;
    expect(() => taskListSearchParams(malformed, 2, null)).toThrow();
  }
});

it('starts due mode at page one with all intersecting filters, never mixing manual/due cursors', async () => {
  const path = `/api/v1/workspaces/${alpha.id}/tasks`;
  const { calls } = installFakeApi({ [`GET ${path}`]: request => json(200, { data: [], meta: { requestId: 'due-query-fixture', nextCursor: request.searchParams.has('cursor') ? null : `next-${request.searchParams.get('sort') ?? 'manual'}` } }) });
  const client = createQueryClient({ retry: false });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ sort }: { sort: 'manual' | 'due_asc' }) => useTaskListQuery(anna.id, alpha.id, { projectId, statusId, tagId, search: 'needle', sort }, { limit: 2 }), { wrapper, initialProps: { sort: 'manual' } });
  try {
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await act(async () => { await view.result.current.fetchNextPage(); });
    expect(calls[1]?.searchParams.get('cursor')).toBe('next-manual');
    view.rerender({ sort: 'due_asc' });
    await waitFor(() => { expect(view.result.current.isSuccess).toBe(true); expect(calls).toHaveLength(3); });
    expect(Object.fromEntries(calls[2]?.searchParams ?? [])).toEqual({ projectId, statusId, tagId, search: 'needle', sort: 'due_asc', limit: '2' });
    expect(view.result.current.data?.pageParams).toEqual([null]);
    await act(async () => { await view.result.current.fetchNextPage(); });
    expect(calls[3]?.searchParams.get('cursor')).toBe('next-due_asc');
    view.rerender({ sort: 'manual' });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(view.result.current.data?.pages.every(page => page.nextCursor !== 'next-due_asc')).toBe(true);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.filter(call => call.searchParams.get('sort') === 'due_asc').every(call => call.searchParams.get('cursor') !== 'next-manual')).toBe(true);
  } finally { view.unmount(); client.clear(); }
});
