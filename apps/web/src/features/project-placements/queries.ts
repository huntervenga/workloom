import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { useSyncExternalStore } from 'react';
import type { TransferTaskProjectInput, TransferTaskProjectResult } from '@workloom/contracts';
import { fetchProjectRows, fetchTaskPlacements, placementRequest, transferRequest, type PlacementCommand, type ProjectRowsPage } from './api';

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
/**
 * What the last move of a task did. It lives outside any component: the task form remounts when the new project's data
 * loads, and the result, the unmoved fields and the way back must survive that.
 */
export interface TransferNotice { result: TransferTaskProjectResult; fromProjectId: string }
const notices = new Map<string, TransferNotice>();
const noticeListeners = new Set<() => void>();
const publishNotices = () => { for (const listener of noticeListeners) listener(); };
export const transferNotices = {
  set(taskId: string, notice: TransferNotice) { notices.set(taskId, notice); publishNotices(); },
  clear(taskId: string) { if (notices.delete(taskId)) publishNotices(); },
  get: (taskId: string): TransferNotice | undefined => notices.get(taskId),
  subscribe(listener: () => void) { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; },
};
export function useTransferNotice(taskId: string): TransferNotice | undefined {
  return useSyncExternalStore(transferNotices.subscribe, () => transferNotices.get(taskId), () => undefined);
}

/** Moves a task and its subtasks to another project. It touches reports and counters everywhere, so every workspace read is refreshed. */
export function useTransferTaskProject(actorId: string, workspaceId: string) {
  const client = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ taskId, input }: IdempotentVariables & { taskId: string; input: TransferTaskProjectInput; fromProjectId: string }) => transferRequest(workspaceId, taskId, input),
    // Recorded here, not by the caller, so it still happens if the form that sent the move has been replaced meanwhile.
    onSuccess: (result, variables) => { transferNotices.set(variables.taskId, { result, fromProjectId: variables.fromProjectId }); void client.invalidateQueries({ queryKey: queryKeys.workspace(actorId, workspaceId) }); },
  });
}
