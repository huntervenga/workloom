import { useInfiniteQuery } from '@tanstack/react-query';
import { queryKeys } from '../../lib/queryKeys';
import { fetchMyTasks, type MyTasksFilters } from './api';

export function useMyTasksQuery(actorId: string, workspaceId: string, filters: MyTasksFilters, options: { enabled?: boolean } = {}) {
  return useInfiniteQuery({
    queryKey: queryKeys.myTasks(actorId, workspaceId, filters),
    queryFn: ({ pageParam, signal }) => fetchMyTasks(workspaceId, filters, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor,
    enabled: options.enabled ?? true,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
