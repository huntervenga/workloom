import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatePlanningPeriodInput, UpdatePlanningPeriodInput, CreatePeriodCommitmentInput,
  UpdatePeriodCommitmentInput, FreezePlanInput, SetManualPeriodWorkInput,
  CreateWeeklyPlanFactReportInput,
} from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import {
  fetchPlanningPeriods, fetchPlanningPeriod, fetchPlanningPackages, fetchPeriodCommitments,
  fetchPlanBaselines, fetchPeriodWorkLogs, fetchReportRuns, fetchReportRun, fetchReportRows,
  createPlanningPeriodRequest, updatePlanningPeriodRequest, createPeriodCommitmentRequest,
  updatePeriodCommitmentRequest, freezePlanRequest, setManualPeriodWorkRequest, createWeeklyReportRequest,
} from './api';

const canonical = (id: string) => id.toLowerCase();
/** Actor/workspace always scope planning data; the selected period is never an ambient mutation input. */
export const planningKeys = {
  root: (actorId: string, workspaceId: string) => [...queryKeys.workspace(actorId, workspaceId), 'planning'] as const,
  periods: (actorId: string, workspaceId: string, projectId: string) => [...planningKeys.root(actorId, workspaceId), 'periods', canonical(projectId)] as const,
  packages: (actorId: string, workspaceId: string, projectId: string) => [...planningKeys.root(actorId, workspaceId), 'packages', canonical(projectId)] as const,
  period: (actorId: string, workspaceId: string, periodId: string) => [...planningKeys.root(actorId, workspaceId), 'period', canonical(periodId)] as const,
  commitments: (actorId: string, workspaceId: string, periodId: string) => [...planningKeys.period(actorId, workspaceId, periodId), 'commitments'] as const,
  baselines: (actorId: string, workspaceId: string, periodId: string) => [...planningKeys.period(actorId, workspaceId, periodId), 'baselines'] as const,
  worklogs: (actorId: string, workspaceId: string, periodId: string) => [...planningKeys.period(actorId, workspaceId, periodId), 'worklogs'] as const,
  runs: (actorId: string, workspaceId: string, periodId: string) => [...planningKeys.period(actorId, workspaceId, periodId), 'runs'] as const,
  run: (actorId: string, workspaceId: string, runId: string) => [...planningKeys.root(actorId, workspaceId), 'run', canonical(runId)] as const,
  rows: (actorId: string, workspaceId: string, runId: string) => [...planningKeys.run(actorId, workspaceId, runId), 'rows'] as const,
};

export function usePlanningPeriodsQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: planningKeys.periods(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchPlanningPeriods(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function usePlanningPackagesQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: planningKeys.packages(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchPlanningPackages(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function usePlanningPeriodQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({
    queryKey: planningKeys.period(actorId, workspaceId, periodId),
    queryFn: ({ signal }) => fetchPlanningPeriod(workspaceId, periodId, signal),
    enabled: isUuid(periodId),
  });
}

export function usePeriodCommitmentsQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({
    queryKey: planningKeys.commitments(actorId, workspaceId, periodId),
    queryFn: ({ signal }) => fetchPeriodCommitments(workspaceId, periodId, signal),
    enabled: isUuid(periodId),
  });
}

export function usePlanBaselinesQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({
    queryKey: planningKeys.baselines(actorId, workspaceId, periodId),
    queryFn: ({ signal }) => fetchPlanBaselines(workspaceId, periodId, signal),
    enabled: isUuid(periodId),
  });
}

export function usePeriodWorkLogsQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({
    queryKey: planningKeys.worklogs(actorId, workspaceId, periodId),
    queryFn: ({ signal }) => fetchPeriodWorkLogs(workspaceId, periodId, signal),
    enabled: isUuid(periodId),
  });
}

export function useReportRunsQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({
    queryKey: planningKeys.runs(actorId, workspaceId, periodId),
    queryFn: ({ signal }) => fetchReportRuns(workspaceId, periodId, signal),
    enabled: isUuid(periodId),
  });
}

export function useReportRunQuery(actorId: string, workspaceId: string, runId: string) {
  return useQuery({
    queryKey: planningKeys.run(actorId, workspaceId, runId),
    queryFn: ({ signal }) => fetchReportRun(workspaceId, runId, signal),
    enabled: isUuid(runId),
  });
}

export function useReportRowsQuery(actorId: string, workspaceId: string, runId: string) {
  return useInfiniteQuery({
    queryKey: planningKeys.rows(actorId, workspaceId, runId),
    queryFn: ({ signal, pageParam }) => fetchReportRows(workspaceId, runId, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: isUuid(runId),
  });
}

/** Invalidate live collections only; immutable pinned runs do not change after a fact edit. */
export function usePlanningCommands(actorId: string, workspaceId: string, projectId: string) {
  const client = useQueryClient();
  const invalidatePeriods = () => {
    void client.invalidateQueries({ queryKey: planningKeys.periods(actorId, workspaceId, projectId), exact: true });
    void client.invalidateQueries({ queryKey: planningKeys.packages(actorId, workspaceId, projectId), exact: true });
  };
  const invalidatePeriod = (periodId: string) => {
    invalidatePeriods();
    void client.invalidateQueries({ queryKey: queryKeys.timeSummaries(actorId, workspaceId) });
    void client.invalidateQueries({ queryKey: planningKeys.period(actorId, workspaceId, periodId) });
  };
  const createPeriod = useIdempotentMutation({
    prepare: ({ input }: CreatePeriodVariables) => createPlanningPeriodRequest(workspaceId, input),
    onSuccess: () => invalidatePeriods(),
  });
  const updatePeriod = useIdempotentMutation({
    prepare: ({ periodId, input }: UpdatePeriodVariables) => updatePlanningPeriodRequest(workspaceId, periodId, input),
    onSuccess: (_data, variables) => invalidatePeriod(variables.periodId),
  });
  const createCommitment = useIdempotentMutation({
    prepare: ({ periodId, input }: CreateCommitmentVariables) => createPeriodCommitmentRequest(workspaceId, periodId, input),
    onSuccess: (_data, variables) => invalidatePeriod(variables.periodId),
  });
  const updateCommitment = useIdempotentMutation({
    prepare: ({ periodId, commitmentId, input }: UpdateCommitmentVariables) => updatePeriodCommitmentRequest(workspaceId, periodId, commitmentId, input),
    onSuccess: (_data, variables) => invalidatePeriod(variables.periodId),
  });
  const freeze = useIdempotentMutation({
    prepare: ({ periodId, input }: FreezeVariables) => freezePlanRequest(workspaceId, periodId, input),
    onSuccess: (_data, variables) => {
      invalidatePeriod(variables.periodId);
      void client.invalidateQueries({ queryKey: queryKeys.tasks(actorId, workspaceId) });
      void client.invalidateQueries({ queryKey: queryKeys.fields(actorId, workspaceId) });
    },
  });
  const setFact = useIdempotentMutation({
    prepare: ({ taskId, periodId, membershipId, input }: SetFactVariables) => setManualPeriodWorkRequest(workspaceId, taskId, periodId, membershipId, input),
    onSuccess: (_data, variables) => invalidatePeriod(variables.periodId),
  });
  const createReport = useIdempotentMutation({
    prepare: ({ input }: CreateReportVariables) => createWeeklyReportRequest(workspaceId, input),
    onSuccess: (run) => {
      // Do not recreate cache entries for an actor/workspace already left while this request was sent.
      void client.invalidateQueries({ queryKey: planningKeys.runs(actorId, workspaceId, run.periodId), exact: true });
    },
  });
  return { createPeriod, updatePeriod, createCommitment, updateCommitment, freeze, setFact, createReport };
}
export type PlanningCommands = ReturnType<typeof usePlanningCommands>;
export interface CreatePeriodVariables extends IdempotentVariables { input: CreatePlanningPeriodInput }
export interface UpdatePeriodVariables extends IdempotentVariables { periodId: string; input: UpdatePlanningPeriodInput }
export interface CreateCommitmentVariables extends IdempotentVariables { periodId: string; input: CreatePeriodCommitmentInput }
export interface UpdateCommitmentVariables extends IdempotentVariables { periodId: string; commitmentId: string; input: UpdatePeriodCommitmentInput }
export interface FreezeVariables extends IdempotentVariables { periodId: string; input: FreezePlanInput }
export interface SetFactVariables extends IdempotentVariables { taskId: string; periodId: string; membershipId: string; input: SetManualPeriodWorkInput }
export interface CreateReportVariables extends IdempotentVariables { periodId: string; input: CreateWeeklyPlanFactReportInput }
