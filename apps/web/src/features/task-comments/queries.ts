import { useInfiniteQuery } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';
import { isUuid } from '../../lib/format';
import { fetchActivity, fetchComments } from './api';

export const discussionKeys = {
  comments: (actorId: string, workspaceId: string, taskId: string) => [...queryKeys.task(actorId, workspaceId, taskId.toLowerCase()), 'comments'] as const,
  activity: (actorId: string, workspaceId: string, taskId: string) => [...queryKeys.task(actorId, workspaceId, taskId.toLowerCase()), 'activity'] as const,
};
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
