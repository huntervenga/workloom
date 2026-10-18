import { useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';
import { isUuid } from '../../lib/format';
import { fetchActivity, fetchComments, fetchTimeline } from './api';

export const discussionKeys = {
  comments: (actorId: string, workspaceId: string, taskId: string) => [...queryKeys.task(actorId, workspaceId, taskId.toLowerCase()), 'comments'] as const,
  activity: (actorId: string, workspaceId: string, taskId: string) => [...queryKeys.task(actorId, workspaceId, taskId.toLowerCase()), 'activity'] as const,
  timeline: (actorId: string, workspaceId: string, taskId: string) => [...queryKeys.task(actorId, workspaceId, taskId.toLowerCase()), 'timeline'] as const,
};
export function useTimelineQuery(actorId: string, workspaceId: string, taskId: string) {
  return useInfiniteQuery({ queryKey: discussionKeys.timeline(actorId, workspaceId, taskId), initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => fetchTimeline(workspaceId, taskId, pageParam, signal),
    getNextPageParam: page => page.nextCursor, enabled: isUuid(taskId) });
}
/**
 * One prefix call refreshing every matching task timeline (all of them without `taskIds`), so a
 * saved edit or an atomic batch never starts one invalidation per returned row.
 */
export function invalidateTaskTimelines(client: QueryClient, actorId: string, workspaceId: string, taskIds?: readonly string[]) {
  const prefix = queryKeys.tasks(actorId, workspaceId);
  const ids = taskIds ? new Set(taskIds.map(id => id.toLowerCase())) : null;
  if (ids?.size === 0) return Promise.resolve();
  const filters = { queryKey: prefix, predicate: ({ queryKey }: { queryKey: readonly unknown[] }) => queryKey.length === prefix.length + 3
    && queryKey[prefix.length] === 'detail' && queryKey[prefix.length + 2] === 'timeline'
    && (!ids || ids.has(String(queryKey[prefix.length + 1]))) };
  // Invalidation alone joins an initial request with no cached data. Cancel that old
  // read first so its late response cannot erase the confirmed change's freshness.
  return client.cancelQueries(filters, { silent: true }).then(() => client.invalidateQueries(filters));
}
export function useCommentsQuery(actorId: string, workspaceId: string, taskId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: discussionKeys.comments(actorId, workspaceId, taskId), initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => fetchComments(workspaceId, taskId, pageParam, signal),
    getNextPageParam: page => page.nextCursor, enabled: enabled && isUuid(taskId) });
}
export function useActivityQuery(actorId: string, workspaceId: string, taskId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: discussionKeys.activity(actorId, workspaceId, taskId), initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => fetchActivity(workspaceId, taskId, pageParam, signal),
    getNextPageParam: page => page.nextCursor, enabled: enabled && isUuid(taskId) });
}
/** Pages may overlap when the timeline changes between authorized reads. */
export function uniqueRows<T extends { id: string }>(pages: readonly { rows: readonly T[] }[] | undefined): T[] {
  const seen = new Set<string>();
  return (pages ?? []).flatMap(page => page.rows.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; }));
}
