import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { fetchProjectRows, fetchTaskPlacements, placementRequest, type PlacementCommand, type ProjectRowsPage } from './api';

// Rows share the task family: a canonical task edit invalidates every visible placement.
export const placementKeys = {
  rows: (actorId: string, workspaceId: string, projectId: string, includeArchived: boolean) => [...queryKeys.projectTaskLists(actorId, workspaceId, projectId), 'placements', { includeArchived }] as const,
  task: (actorId: string, workspaceId: string, taskId: string) => [...queryKeys.tasks(actorId, workspaceId), 'placements', taskId] as const,
};
export function useProjectRowsQuery(actorId: string, workspaceId: string, projectId: string, includeArchived = false) {
  return useInfiniteQuery({
    queryKey: placementKeys.rows(actorId, workspaceId, projectId, includeArchived),
    queryFn: ({ signal, pageParam }) => fetchProjectRows(workspaceId, projectId, pageParam, includeArchived, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page: ProjectRowsPage) => page.nextCursor,
    enabled: isUuid(projectId),
  });
}
export function useTaskPlacementsQuery(actorId: string, workspaceId: string, taskId: string) {
  return useQuery({ queryKey: placementKeys.task(actorId, workspaceId, taskId), queryFn: ({ signal }) => fetchTaskPlacements(workspaceId, taskId, signal), enabled: isUuid(taskId) });
}
export function loadedProjectRows(data: InfiniteData<ProjectRowsPage> | undefined) {
  // Cursor refetches may overlap. A placement appears only once, at its latest revision.
  const rows = new Map<string, ProjectRowsPage['rows'][number]>();
  for (const row of data?.pages.flatMap(page => page.rows) ?? []) {
    const previous = rows.get(row.placement.id);
    if (!previous || row.placement.revision >= previous.placement.revision) rows.set(row.placement.id, row);
  }
  return [...rows.values()];
}
export function usePlacementCommands(actorId: string, workspaceId: string) {
  const client = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ command }: IdempotentVariables & { command: PlacementCommand }) => placementRequest(workspaceId, command),
    // Receipt replay is never used to resurrect a detached placement in the cache.
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.tasks(actorId, workspaceId) }); },
  });
}
export type PlacementCommands = ReturnType<typeof usePlacementCommands>;
