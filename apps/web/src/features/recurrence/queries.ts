import { useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import type {
  CreateRecurrenceSeriesInput, EditRecurrenceSeriesInput, SetRecurrenceSeriesStateInput,
  AddRecurrencePeriodsInput, AuthorizeRecurrenceGenerationInput, SetRecurrenceExceptionInput, MaterializePeriodInput,
  RecurrenceSeriesDto, RecurrencePeriodsResultDto, RecurrenceInstanceDto, RecurrenceMaterializationResultDto,
} from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { meetingKeys } from '../meetings/queries';
import { planningKeys } from '../planning/queries';
import {
  fetchRecurrenceSeries, fetchRecurrenceSeriesDetail, fetchRecurrenceInstances, fetchRecurrenceReadiness,
  createRecurrenceSeriesRequest, editRecurrenceSeriesRequest, setRecurrenceSeriesStateRequest,
  addRecurrencePeriodsRequest, authorizeRecurrenceGenerationRequest, setRecurrenceExceptionRequest,
  materializeRecurrencePeriodRequest,
} from './api';

const canonical = (id: string) => id.toLowerCase();
/** Actor/workspace scope every recurrence read; the selected period or person is never an ambient mutation input. */
export const recurrenceKeys = {
  root: (actorId: string, workspaceId: string) => [...queryKeys.workspace(actorId, workspaceId), 'recurrence'] as const,
  seriesList: (actorId: string, workspaceId: string, projectId: string) =>
    [...recurrenceKeys.root(actorId, workspaceId), 'series-list', canonical(projectId)] as const,
  series: (actorId: string, workspaceId: string, seriesId: string) =>
    [...recurrenceKeys.root(actorId, workspaceId), 'series', canonical(seriesId)] as const,
  instances: (actorId: string, workspaceId: string, seriesId: string, periodId: string) =>
    [...recurrenceKeys.series(actorId, workspaceId, seriesId), 'instances', canonical(periodId)] as const,
  readiness: (actorId: string, workspaceId: string, periodId: string) =>
    [...recurrenceKeys.root(actorId, workspaceId), 'readiness', canonical(periodId)] as const,
};

export function useRecurrenceSeriesQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: recurrenceKeys.seriesList(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchRecurrenceSeries(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function useRecurrenceSeriesDetailQuery(actorId: string, workspaceId: string, seriesId: string) {
  return useQuery({
    queryKey: recurrenceKeys.series(actorId, workspaceId, seriesId),
    queryFn: ({ signal }) => fetchRecurrenceSeriesDetail(workspaceId, seriesId, signal),
    enabled: isUuid(seriesId),
  });
}

export function useRecurrenceInstancesQuery(actorId: string, workspaceId: string, seriesId: string, periodId: string) {
  return useQuery({
    queryKey: recurrenceKeys.instances(actorId, workspaceId, seriesId, periodId),
    queryFn: ({ signal }) => fetchRecurrenceInstances(workspaceId, seriesId, periodId, signal),
    enabled: isUuid(seriesId) && isUuid(periodId),
  });
}

/** Also the recovery read after a MATERIALIZATION_REQUIRED rejection; refetched only on demand or invalidation. */
export function useRecurrenceReadinessQuery(actorId: string, workspaceId: string, periodId: string) {
  return useQuery({
    queryKey: recurrenceKeys.readiness(actorId, workspaceId, periodId),
    queryFn: ({ signal }) => fetchRecurrenceReadiness(workspaceId, periodId, signal),
    enabled: isUuid(periodId),
  });
}

/** `draftId` is UI-only: it identifies the submitting draft and never reaches the request body or its hash. */
export interface CreateSeriesVariables extends IdempotentVariables { draftId?: string; input: CreateRecurrenceSeriesInput }
export interface EditSeriesVariables extends IdempotentVariables { draftId?: string; seriesId: string; input: EditRecurrenceSeriesInput }
export interface SetSeriesStateVariables extends IdempotentVariables { draftId?: string; seriesId: string; input: SetRecurrenceSeriesStateInput }
export interface AddPeriodsVariables extends IdempotentVariables { draftId?: string; seriesId: string; input: AddRecurrencePeriodsInput }
export interface AuthorizeSeriesVariables extends IdempotentVariables { draftId?: string; seriesId: string; input: AuthorizeRecurrenceGenerationInput }
export interface SetExceptionVariables extends IdempotentVariables { draftId?: string; seriesId: string; occurrenceKey: string; input: SetRecurrenceExceptionInput }
export interface MaterializePeriodVariables extends IdempotentVariables { draftId?: string; periodId: string; input: MaterializePeriodInput }

/**
 * Page-owned success handlers. They run from the hook's own onSuccess, so a retry sent from a closed
 * drawer's notice still reaches them; use `variables` to retire exactly the submitted scope.
 */
export interface RecurrenceSuccessCallbacks {
  onCreate?: ((data: RecurrenceSeriesDto, variables: CreateSeriesVariables) => void) | undefined;
  onEdit?: ((data: RecurrenceSeriesDto, variables: EditSeriesVariables) => void) | undefined;
  onState?: ((data: RecurrenceSeriesDto, variables: SetSeriesStateVariables) => void) | undefined;
  onAddPeriods?: ((data: RecurrencePeriodsResultDto, variables: AddPeriodsVariables) => void) | undefined;
  onAuthorize?: ((data: RecurrenceSeriesDto, variables: AuthorizeSeriesVariables) => void) | undefined;
  onException?: ((data: RecurrenceInstanceDto, variables: SetExceptionVariables) => void) | undefined;
  onMaterialize?: ((data: RecurrenceMaterializationResultDto, variables: MaterializePeriodVariables) => void) | undefined;
}

/**
 * Writes only invalidate: a replayed answer may be older than independently cached versions, so it is
 * never merged into the cache. Pinned report runs and their rows are immutable and are left alone.
 */
export function useRecurrenceCommands(actorId: string, workspaceId: string, projectId: string, callbacks?: RecurrenceSuccessCallbacks) {
  const client = useQueryClient();
  const planningRoot = planningKeys.root(actorId, workspaceId);
  const livePlanning = (query: Query) => query.queryKey[planningRoot.length] !== 'run';
  const invalidateRecurrence = () => {
    void client.invalidateQueries({ queryKey: recurrenceKeys.root(actorId, workspaceId) });
  };
  /** Edits, exceptions and materialization change real meetings, tasks, packages and their time. */
  const invalidateCalendar = () => {
    invalidateRecurrence();
    void client.invalidateQueries({ queryKey: meetingKeys.root(actorId, workspaceId) });
    void client.invalidateQueries({ queryKey: planningRoot, predicate: livePlanning });
    void client.invalidateQueries({ queryKey: queryKeys.tasks(actorId, workspaceId) });
    void client.invalidateQueries({ queryKey: queryKeys.timeSummaries(actorId, workspaceId) });
  };

  const create = useIdempotentMutation({
    prepare: ({ input }: CreateSeriesVariables) => createRecurrenceSeriesRequest(workspaceId, projectId, input),
    onSuccess: (data, variables) => {
      callbacks?.onCreate?.(data, variables);
      invalidateRecurrence();
    },
  });
  const edit = useIdempotentMutation({
    prepare: ({ seriesId, input }: EditSeriesVariables) => editRecurrenceSeriesRequest(workspaceId, seriesId, input),
    onSuccess: (data, variables) => {
      callbacks?.onEdit?.(data, variables);
      invalidateCalendar();
    },
  });
  // Pause/resume affects background preparation only, never the registered calendar.
  const state = useIdempotentMutation({
    prepare: ({ seriesId, input }: SetSeriesStateVariables) => setRecurrenceSeriesStateRequest(workspaceId, seriesId, input),
    onSuccess: (data, variables) => {
      callbacks?.onState?.(data, variables);
      invalidateRecurrence();
    },
  });
  const addPeriods = useIdempotentMutation({
    prepare: ({ seriesId, input }: AddPeriodsVariables) => addRecurrencePeriodsRequest(workspaceId, seriesId, input),
    onSuccess: (data, variables) => {
      callbacks?.onAddPeriods?.(data, variables);
      invalidateRecurrence();
    },
  });
  const authorize = useIdempotentMutation({
    prepare: ({ seriesId, input }: AuthorizeSeriesVariables) => authorizeRecurrenceGenerationRequest(workspaceId, seriesId, input),
    onSuccess: (data, variables) => {
      callbacks?.onAuthorize?.(data, variables);
      invalidateRecurrence();
    },
  });
  const exception = useIdempotentMutation({
    prepare: ({ seriesId, occurrenceKey, input }: SetExceptionVariables) => setRecurrenceExceptionRequest(workspaceId, seriesId, occurrenceKey, input),
    onSuccess: (data, variables) => {
      callbacks?.onException?.(data, variables);
      invalidateCalendar();
    },
  });
  // One chunk per submission; the caller decides whether to send the next cursor.
  const materialize = useIdempotentMutation({
    prepare: ({ periodId, input }: MaterializePeriodVariables) => materializeRecurrencePeriodRequest(workspaceId, periodId, input),
    onSuccess: (data, variables) => {
      callbacks?.onMaterialize?.(data, variables);
      invalidateCalendar();
      // A final chunk may freeze the target period, which adds baseline locks.
      if (data.frozenBaselineIds.length > 0) void client.invalidateQueries({ queryKey: queryKeys.fields(actorId, workspaceId) });
    },
  });
  return { create, edit, state, addPeriods, authorize, exception, materialize };
}
export type RecurrenceCommands = ReturnType<typeof useRecurrenceCommands>;
