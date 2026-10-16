import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, installFakeApi, json } from '../../test/fakeApi';
import { normalizeTaskFilters, taskListSearchParams } from './api';
import { useTaskListQuery } from './queries';

const projectId = 'abcdef00-0000-4000-8000-000000000401';
const tagA = 'abcdef00-0000-4000-8000-000000000801';
const tagB = 'abcdef00-0000-4000-8000-000000000802';
const sectionId = 'abcdef00-0000-4000-8000-000000000901';
const statusId = 'abcdef00-0000-4000-8000-000000000501';
const participantMembershipId = 'abcdef00-0000-4000-8000-000000000301';

describe('single-tag task query normalization', () => {
  it('omits absent/blank tags without changing the original unfiltered key or query params', () => {
    const legacy = { projectId };
    for (const filters of [legacy, { projectId, tagId: '' }, { projectId, tagId: '   ' }, { projectId, tagId: undefined }]) {
      const normalized = normalizeTaskFilters(filters);
      expect(normalized).toEqual(legacy);
      expect(Object.keys(normalized)).toEqual(['projectId']);
      expect(queryKeys.taskList(anna.id, alpha.id, projectId, { ...normalized, limit: 2 })).toEqual(queryKeys.taskList(anna.id, alpha.id, projectId, { projectId, limit: 2 }));
      expect(Object.fromEntries(taskListSearchParams(filters, 2, null))).toEqual({ projectId, limit: '2' });
    }
  });

  it('keeps one tag AND every existing filter and forwards only the explicitly supplied cursor', () => {
    const filters = { projectId, tagId: tagA, sectionId, statusId, participantMembershipId, search: '  needle  ', includeArchived: true };
    expect(normalizeTaskFilters(filters)).toEqual({ ...filters, search: 'needle' });
    expect(Object.fromEntries(taskListSearchParams(filters, 2, 'signed+cursor/='))).toEqual({ projectId, tagId: tagA, sectionId, statusId, participantMembershipId, search: 'needle', includeArchived: 'true', limit: '2', cursor: 'signed+cursor/=' });
    expect(taskListSearchParams(filters, 2, null).has('cursor')).toBe(false);
    expect(queryKeys.taskList(anna.id, alpha.id, projectId, { ...normalizeTaskFilters(filters), limit: 2 })).not.toEqual(queryKeys.taskList(anna.id, alpha.id, projectId, { ...normalizeTaskFilters({ ...filters, tagId: tagB }), limit: 2 }));
  });

  it('starts each changed tag and cleared query at page one without carrying another tag cursor or writing', async () => {
    const path = `/api/v1/workspaces/${alpha.id}/tasks`;
    const { calls } = installFakeApi({ [`GET ${path}`]: request => json(200, { data: [], meta: { requestId: 'tag-query-test', nextCursor: request.searchParams.has('cursor') ? null : `next-${request.searchParams.get('tagId') ?? 'none'}` } }) });
    const client = createQueryClient({ retry: false });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(({ tagId }: { tagId: string }) => useTaskListQuery(anna.id, alpha.id, { projectId, tagId }, { limit: 2 }), { wrapper, initialProps: { tagId: tagA } });
    try {
      await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
      await act(async () => { await view.result.current.fetchNextPage(); });
      expect(calls.map(call => Object.fromEntries(call.searchParams))).toEqual([
        { projectId, tagId: tagA, limit: '2' }, { projectId, tagId: tagA, limit: '2', cursor: `next-${tagA}` },
      ]);
      view.rerender({ tagId: tagB });
      await waitFor(() => { expect(view.result.current.isSuccess).toBe(true); expect(calls).toHaveLength(3); });
      expect(Object.fromEntries(calls[2]?.searchParams ?? [])).toEqual({ projectId, tagId: tagB, limit: '2' });
      expect(view.result.current.data?.pageParams).toEqual([null]);
      await act(async () => { await view.result.current.fetchNextPage(); });
      expect(calls[3]?.searchParams.get('cursor')).toBe(`next-${tagB}`);
      view.rerender({ tagId: '' });
      await waitFor(() => { expect(view.result.current.isSuccess).toBe(true); expect(calls).toHaveLength(5); });
      expect(Object.fromEntries(calls[4]?.searchParams ?? [])).toEqual({ projectId, limit: '2' });
      expect(view.result.current.data?.pageParams).toEqual([null]);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    } finally { view.unmount(); client.clear(); }
  });
});
