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
const key = (filters: TaskListFilters) => queryKeys.taskList(anna.id, alpha.id, projectId, { ...normalizeTaskFilters(filters), limit: 2 });

describe('task completion query normalization', () => {
  it('keeps the legacy shape, request and cache identity when completion is omitted', () => {
    for (const filters of [{ projectId }, { projectId, completion: undefined }]) {
      const normalized = normalizeTaskFilters(filters);
      expect(normalized).toEqual({ projectId });
      expect(Object.keys(normalized)).toEqual(['projectId']);
      expect('completion' in normalized).toBe(false);
      expect(Object.fromEntries(taskListSearchParams(filters, 2, null))).toEqual({ projectId, limit: '2' });
      expect(key(filters)).toEqual(queryKeys.taskList(anna.id, alpha.id, projectId, { projectId, limit: 2 }));
    }
  });

  it('serializes explicit open with every other filter and gives it its own cache identity', () => {
    const filters: TaskListFilters = { projectId, statusId, tagId, search: '  needle  ', includeArchived: true, sort: 'due_asc', completion: 'open' };
    expect(normalizeTaskFilters(filters)).toEqual({ ...filters, search: 'needle' });
    expect(Object.fromEntries(taskListSearchParams(filters, 2, 'signed+cursor/='))).toEqual({ projectId, statusId, tagId, search: 'needle', includeArchived: 'true', sort: 'due_asc', completion: 'open', limit: '2', cursor: 'signed+cursor/=' });
    expect(key({ projectId, completion: 'open' })).not.toEqual(key({ projectId }));
    expect(key(filters)).not.toEqual(key({ ...filters, completion: undefined }));
  });

  it('forwards an unsupported runtime completion to strict validation instead of reading all tasks', () => {
    for (const completion of ['all', '', 'closed', 'OPEN', ' open', true, null, ['open']]) {
      const malformed = { projectId, completion } as unknown as TaskListFilters;
      expect(normalizeTaskFilters(malformed), JSON.stringify(completion)).toHaveProperty('completion', completion);
      expect(() => taskListSearchParams(malformed, 2, null), JSON.stringify(completion)).toThrow();
    }
  });
});

it('starts each completion change at page one without carrying the other choice cursor or writing', async () => {
  const path = `/api/v1/workspaces/${alpha.id}/tasks`;
  const { calls } = installFakeApi({ [`GET ${path}`]: request => json(200, { data: [], meta: { requestId: 'completion-query-test', nextCursor: request.searchParams.has('cursor') ? null : `next-${request.searchParams.get('completion') ?? 'all'}` } }) });
  const client = createQueryClient({ retry: false });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(({ completion }: { completion: 'open' | undefined }) => useTaskListQuery(anna.id, alpha.id, { projectId, statusId, completion }, { limit: 2 }), { wrapper, initialProps: { completion: undefined } as { completion: 'open' | undefined } });
  try {
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await act(async () => { await view.result.current.fetchNextPage(); });
    expect(calls.map(call => Object.fromEntries(call.searchParams))).toEqual([
      { projectId, statusId, limit: '2' }, { projectId, statusId, limit: '2', cursor: 'next-all' },
    ]);
    view.rerender({ completion: 'open' });
    await waitFor(() => { expect(view.result.current.isSuccess).toBe(true); expect(calls).toHaveLength(3); });
    expect(Object.fromEntries(calls[2]?.searchParams ?? [])).toEqual({ projectId, statusId, completion: 'open', limit: '2' });
    expect(view.result.current.data?.pageParams).toEqual([null]);
    await act(async () => { await view.result.current.fetchNextPage(); });
    expect(Object.fromEntries(calls[3]?.searchParams ?? [])).toEqual({ projectId, statusId, completion: 'open', limit: '2', cursor: 'next-open' });
    view.rerender({ completion: undefined });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    expect(view.result.current.data?.pages.every(page => page.nextCursor !== 'next-open')).toBe(true);
    expect(calls.filter(call => call.searchParams.has('completion')).every(call => call.searchParams.get('cursor') !== 'next-all')).toBe(true);
    expect(calls.filter(call => !call.searchParams.has('completion')).every(call => call.searchParams.get('cursor') !== 'next-open')).toBe(true);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  } finally { view.unmount(); client.clear(); }
});
