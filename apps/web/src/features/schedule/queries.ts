import { useRef } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import type { TaskScheduleContextDto, TaskScheduleApplyInput, TaskScheduleContextRowDto, ScheduleDependencyComparisonDto, TaskSchedulePreviewDto } from '@workloom/contracts';
import { recordScheduleUndo } from '../undo/recordSpatialUndo';
import { queryKeys } from '../../lib/queryKeys';
import { isAccessDenied } from '../../lib/api';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { applyScheduleRequest, fetchScheduleContext } from './api';
export const scheduleKeys = {
  root: (a: string, w: string) => [...queryKeys.workspace(a, w), 'schedule'] as const,
  context: (a: string, w: string, p: string, ids: readonly string[], baselineId: string) => [...scheduleKeys.root(a, w), p, [...ids].sort().join(','), baselineId] as const,
};
export function useScheduleContext(a: string, w: string, p: string, taskIds: readonly string[], baselineId: string) {
  const client = useQueryClient();
  const ids = [...new Set(taskIds)].sort();
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const results = useQueries({ queries: chunks.map(chunk => {
    const key = scheduleKeys.context(a, w, p, chunk, baselineId);
    return { queryKey: key, queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const incoming = await fetchScheduleContext(w, p, { taskIds: chunk, ...(baselineId ? { baselineId } : {}) }, signal);
      const cached = client.getQueryData<TaskScheduleContextDto>(key);
      return cached && BigInt(cached.asOfChangeSeq) > BigInt(incoming.asOfChangeSeq) ? cached : incoming;
    }, retry: false };
  }) });
  const rows = new Map<string, TaskScheduleContextRowDto>();
  const comparisons = new Map<string, ScheduleDependencyComparisonDto>();
  const sequences = new Map<string, bigint>();
  const comparisonSequences = new Map<string, bigint>();
  for (const result of results) if (result.data) {
    const sequence = BigInt(result.data.asOfChangeSeq);
    for (const row of result.data.rows) if (!sequences.has(row.taskId) || sequence >= (sequences.get(row.taskId) ?? 0n)) { rows.set(row.taskId, row); sequences.set(row.taskId, sequence); }
    for (const comparison of result.data.comparisons) if (!comparisonSequences.has(comparison.dependencyId) || sequence >= (comparisonSequences.get(comparison.dependencyId) ?? 0n)) { comparisons.set(comparison.dependencyId, comparison); comparisonSequences.set(comparison.dependencyId, sequence); }
  }
  return { rows, comparisons: [...comparisons.values()], baseline: results.find(result => result.data?.baseline)?.data?.baseline ?? null,
    error: results.find(result => isAccessDenied(result.error))?.error ?? results.find(result => result.error)?.error ?? null, anyAccessDenied: results.some(result => isAccessDenied(result.error)), pending: results.some(result => result.isPending), fetching: results.some(result => result.isFetching),
    accessConfirmed: () => chunks.every(chunk => client.getQueryState(scheduleKeys.context(a, w, p, chunk, baselineId))?.status === 'success'),
    refetch: async () => (await Promise.all(results.map(result => result.refetch()))).every(result => result.isSuccess),
  };
}
export interface ApplyScheduleVariables extends IdempotentVariables { draftId: string; input: TaskScheduleApplyInput; undoPreview?: TaskSchedulePreviewDto }
export function useApplySchedule(a: string, w: string, p: string, onSuccess: (variables: ApplyScheduleVariables) => void) {
  const client = useQueryClient();
  const snapshots = useRef(new WeakMap<ApplyScheduleVariables, TaskSchedulePreviewDto | undefined>()).current;
  return useIdempotentMutation({ prepare: (v: ApplyScheduleVariables) => {
    if (!snapshots.has(v)) snapshots.set(v, v.undoPreview ? structuredClone(v.undoPreview) : undefined);
    return applyScheduleRequest(w, p, v.input);
  }, onSuccess: (data, variables, ack) => {
    if (ack.actorId !== null && ack.actorId !== a) return;
    if (ack.actorId === a) recordScheduleUndo(client, a, w, p, snapshots.get(variables), data, variables.input, ack.receipt);
    onSuccess(variables);
    void client.invalidateQueries({ queryKey: scheduleKeys.root(a, w) });
    void client.invalidateQueries({ queryKey: queryKeys.tasks(a, w) });
    void client.invalidateQueries({ queryKey: [...queryKeys.workspace(a, w), 'dependencies'] });
  } });
}
