import { useInfiniteQuery, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { CreateWorkTypeReportRunInput, PackageTimeRowDto, RecategorizeWorkLogInput, TaskTimeRowDto, TaskTimeSummaryDto, UpdateProjectWorkCategoryBindingInput } from '@workloom/contracts';
import { ApiError } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { meetingKeys } from '../meetings/queries';
import { planningKeys } from '../planning';
import { createWorkTypeReportRequest, fetchTaskTimeSummary, fetchWorkCategoryBinding, fetchWorkTypeReport, fetchWorkTypeReportRows, fetchWorkTypeReportRuns, recategorizeWorkLogRequest, taskTimeChunks, updateWorkCategoryBindingRequest } from './api';

const id = (value: string) => value.toLowerCase();
export const categoryKeys = {
  root: (actorId: string, workspaceId: string) => [...queryKeys.workspace(actorId, workspaceId), 'workCategories'] as const,
  runs: (actorId: string, workspaceId: string, periodId: string) => [...categoryKeys.root(actorId, workspaceId), 'runs', id(periodId)] as const,
  run: (actorId: string, workspaceId: string, runId: string) => [...categoryKeys.root(actorId, workspaceId), 'run', id(runId)] as const,
  rows: (actorId: string, workspaceId: string, runId: string) => [...categoryKeys.run(actorId, workspaceId, runId), 'rows'] as const,
  time: (actorId: string, workspaceId: string, projectId: string, periodId: string, membershipId: string, taskIds: readonly string[]) => [...queryKeys.timeSummaries(actorId, workspaceId), id(projectId), id(periodId), id(membershipId), taskIds] as const,
};
export function useWorkCategoryBindingQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({ queryKey: queryKeys.workCategoryBinding(actorId, workspaceId, projectId), queryFn: ({ signal }) => fetchWorkCategoryBinding(workspaceId, projectId, signal), enabled: isUuid(projectId) });
}
export function useWorkTypeReportRunsQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({ queryKey: categoryKeys.runs(actorId, workspaceId, periodId), queryFn: ({ signal }) => fetchWorkTypeReportRuns(workspaceId, periodId, signal), enabled: isUuid(periodId) });
}
export function useWorkTypeReportQuery(actorId: string, workspaceId: string, runId: string) {
  return useQuery({ queryKey: categoryKeys.run(actorId, workspaceId, runId), queryFn: ({ signal }) => fetchWorkTypeReport(workspaceId, runId, signal), enabled: isUuid(runId) });
}
export function useWorkTypeReportRowsQuery(actorId: string, workspaceId: string, runId: string) {
  return useInfiniteQuery({ queryKey: categoryKeys.rows(actorId, workspaceId, runId), queryFn: ({ signal, pageParam }) => fetchWorkTypeReportRows(workspaceId, runId, pageParam, signal), initialPageParam: null as string | null, getNextPageParam: (page) => page.nextCursor, enabled: isUuid(runId) });
}

export interface TaskTimeData {
  tasks: ReadonlyMap<string, TaskTimeRowDto>;
  packages: ReadonlyMap<string, PackageTimeRowDto>;
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/** Full package rows may recur across batches. A newer numeric read version replaces, never adds. */
export function mergeTaskTimeSummaries(summaries: readonly TaskTimeSummaryDto[]): Pick<TaskTimeData, 'tasks' | 'packages'> {
  const tasks = new Map<string, { sequence: bigint; row: TaskTimeRowDto }>();
  const packages = new Map<string, { sequence: bigint; row: PackageTimeRowDto }>();
  for (const summary of summaries) {
    const sequence = BigInt(summary.asOfChangeSeq);
    for (const row of summary.tasks) {
      const cached = tasks.get(row.taskId);
      if (!cached || cached.sequence < sequence) tasks.set(row.taskId, { sequence, row:row.meetingId===undefined&&cached?.row.meetingId!==undefined?{...row,meetingId:cached.row.meetingId}:row });
      else if (cached.sequence === sequence && JSON.stringify(cached.row) !== JSON.stringify(row)) throw new ApiError({ kind: 'invalid_response', status: 200 });
    }
    for (const row of summary.packages) {
      const cached = packages.get(row.workPackageId);
      if (!cached || cached.sequence < sequence) packages.set(row.workPackageId, { sequence, row });
      else if (cached.sequence === sequence && JSON.stringify(cached.row) !== JSON.stringify(row)) throw new ApiError({ kind: 'invalid_response', status: 200 });
    }
  }
  return {
    tasks: new Map([...tasks].map(([taskId, value]) => {
      const currentPackage = packages.get(value.row.workPackageId);
      // Keep allocation and the full commitment from the same newer package snapshot.
      const row = currentPackage && currentPackage.sequence > value.sequence
        ? { ...value.row, currentAllocationMinutes: currentPackage.row.commitment?.state === 'active' ? currentPackage.row.commitment.allocations.find((allocation) => allocation.taskId === taskId)?.minutes ?? null : null }
        : value.row;
      return [taskId, row];
    })),
    packages: new Map([...packages].map(([packageId, value]) => [packageId, value.row])),
  };
}
function combineTimeQueries(results: UseQueryResult<TaskTimeSummaryDto>[]): TaskTimeData {
  let error: Error | null = results.find((result) => result.error !== null)?.error ?? null;
  let merged: Pick<TaskTimeData, 'tasks' | 'packages'> = { tasks: new Map(), packages: new Map() };
  if (error === null) {
    try { merged = mergeTaskTimeSummaries(results.flatMap((result) => result.data ? [result.data] : [])); }
    catch (failure) { error = failure instanceof Error ? failure : new Error('Invalid time projection'); }
  }
  return { ...merged, error, isPending: results.some((result) => result.isPending), isFetching: results.some((result) => result.isFetching), refetch: async () => { await Promise.all(results.map((result) => result.refetch())); } };
}
export function useTaskTimeSummaryQuery(actorId: string, workspaceId: string, projectId: string, periodId: string, membershipId: string, taskIds: readonly string[]): TaskTimeData {
  const enabled = isUuid(periodId) && isUuid(membershipId) && isUuid(projectId);
  const chunks = enabled ? taskTimeChunks(taskIds) : [];
  return useQueries({ queries: chunks.map((chunk) => ({ queryKey: categoryKeys.time(actorId, workspaceId, projectId, periodId, membershipId, chunk), queryFn: ({ signal }: { signal: AbortSignal }) => fetchTaskTimeSummary(workspaceId, projectId, periodId, chunk, membershipId, signal) })), combine: combineTimeQueries });
}

export interface UpdateBindingVariables extends IdempotentVariables { input: UpdateProjectWorkCategoryBindingInput }
export interface RecategorizeVariables extends IdempotentVariables { workLogId: string; periodId: string; input: RecategorizeWorkLogInput }
export interface CreateWorkTypeReportVariables extends IdempotentVariables { input: CreateWorkTypeReportRunInput }
export function useWorkCategoryCommands(actorId: string, workspaceId: string, projectId: string) {
  const client = useQueryClient();
  const binding = useIdempotentMutation({
    prepare: ({ input }: UpdateBindingVariables) => updateWorkCategoryBindingRequest(workspaceId, projectId, input),
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.workCategoryBinding(actorId, workspaceId, projectId), exact: true }); },
  });
  const recategorize = useIdempotentMutation({
    prepare: ({ workLogId, input }: RecategorizeVariables) => recategorizeWorkLogRequest(workspaceId, workLogId, input),
    onSuccess: (log) => {
      void client.invalidateQueries({queryKey:meetingKeys.recorded(actorId,workspaceId,log.periodId),exact:true});
      if(log.sourceKind==='meeting_attendance')void client.invalidateQueries({queryKey:meetingKeys.attendance(actorId,workspaceId,log.taskId)});
      void client.invalidateQueries({ queryKey: planningKeys.worklogs(actorId, workspaceId, log.periodId), exact: true });
      void client.invalidateQueries({ queryKey: queryKeys.timeSummaries(actorId, workspaceId) });
    },
  });
  const createReport = useIdempotentMutation({
    prepare: ({ input }: CreateWorkTypeReportVariables) => createWorkTypeReportRequest(workspaceId, input),
    onSuccess: (run) => { void client.invalidateQueries({ queryKey: categoryKeys.runs(actorId, workspaceId, run.periodId), exact: true }); },
  });
  return { binding, recategorize, createReport };
}
export type WorkCategoryCommands = ReturnType<typeof useWorkCategoryCommands>;
