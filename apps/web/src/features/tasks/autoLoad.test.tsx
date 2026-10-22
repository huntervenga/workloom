import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_LOAD_TASK_LIMIT, taskAutoLoad, useAutoLoadTasks } from './autoLoad';

const query = (overrides: Partial<Parameters<typeof useAutoLoadTasks>[0]> = {}) => ({ hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false, fetchNextPage: vi.fn(), ...overrides });

describe('loading every page of a project', () => {
  beforeEach(() => { taskAutoLoad.enabled = true; });

  it('asks for the next page while more exist, so the last section and new tasks are not hidden behind a button', () => {
    const q = query();
    renderHook(() => useAutoLoadTasks(q, 100));
    expect(q.fetchNextPage).toHaveBeenCalledTimes(1);
  });
  it('waits while a page is loading, stops on an error, on the last page and at the size limit', () => {
    for (const q of [query({ isFetchingNextPage: true }), query({ isFetchNextPageError: true }), query({ hasNextPage: false })]) {
      renderHook(() => useAutoLoadTasks(q, 100));
      expect(q.fetchNextPage).not.toHaveBeenCalled();
    }
    const big = query();
    renderHook(() => useAutoLoadTasks(big, AUTO_LOAD_TASK_LIMIT));
    expect(big.fetchNextPage).not.toHaveBeenCalled();
  });
  it('can be switched off', () => {
    taskAutoLoad.enabled = false;
    const q = query();
    renderHook(() => useAutoLoadTasks(q, 10));
    expect(q.fetchNextPage).not.toHaveBeenCalled();
  });
});
