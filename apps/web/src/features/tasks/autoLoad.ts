import { useEffect } from 'react';

/** Projects up to this many tasks load completely on their own. */
export const AUTO_LOAD_TASK_LIMIT = 1000;

/**
 * Whether the task list pulls its remaining pages by itself. Page-by-page tests switch it off in the shared test setup to
 * exercise the "Load more tasks" button; the dedicated auto-load tests switch it back on.
 */
export const taskAutoLoad = { enabled: true };

interface PagedQuery { hasNextPage: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean; fetchNextPage: () => unknown }

/**
 * Pages beyond the first 100 used to wait behind a button below the table, so the last section (often "No section")
 * and a newly created task looked missing. Keep loading until the project is complete or very large.
 */
export function useAutoLoadTasks(query: PagedQuery, loaded: number): void {
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  useEffect(() => {
    if (taskAutoLoad.enabled && hasNextPage && !isFetchingNextPage && !isFetchNextPageError && loaded < AUTO_LOAD_TASK_LIMIT) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, loaded]);
}
