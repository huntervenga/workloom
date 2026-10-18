import { useInfiniteQuery, useQueries, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CreateTaskFieldInput,
  CreateTaskFieldOptionInput,
  SetTaskFieldValueInput,
  TaskFieldValueDto,
  UpdateProjectColumnsInput,
  UpdateTaskFieldInput,
  UpdateTaskFieldOptionInput,
} from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { invalidateTaskTimelines } from '../task-comments/queries';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import {
  createTaskFieldOptionRequest,
  createTaskFieldRequest,
  fetchProjectColumns,
  fetchProjectFieldValues,
  fetchTaskFieldHistoryPage,
  fetchTaskFieldValues,
  fetchTaskFields,
  fieldValueTaskIdChunks,
  setTaskFieldValueRequest,
  updateProjectColumnsRequest,
  updateTaskFieldOptionRequest,
  updateTaskFieldRequest,
  type FieldHistoryPage,
} from './api';

export type { FieldHistoryPage } from './api';

/** The project's fields, archived ones included; disabled for a malformed project ID. */
export function useTaskFieldsQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.fieldDefinitions(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchTaskFields(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function useProjectColumnsQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectColumns(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchProjectColumns(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function useTaskFieldValuesQuery(actorId: string, workspaceId: string, taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskFieldValues(actorId, workspaceId, taskId),
    queryFn: ({ signal }) => fetchTaskFieldValues(workspaceId, taskId, signal),
    enabled: isUuid(taskId),
  });
}

export interface ProjectFieldValues {
  /** Values of every batch loaded so far; complete only once `isPending` is false. */
  data: TaskFieldValueDto[];
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
  /** The first failed batch's error. */
  error: Error | null;
  refetch: () => Promise<void>;
}

function combineValueBatches(results: UseQueryResult<TaskFieldValueDto[]>[]): ProjectFieldValues {
  return {
    data: results.flatMap((result) => result.data ?? []),
    isPending: results.some((result) => result.isPending),
    isFetching: results.some((result) => result.isFetching),
    isError: results.some((result) => result.isError),
    error: results.find((result) => result.error !== null)?.error ?? null,
    refetch: async () => {
      await Promise.all(results.map((result) => result.refetch()));
    },
  };
}

/**
 * Values of the loaded tasks of a project, one request per batch of up to 200 task IDs.
 * Malformed IDs are skipped; with no valid task or a malformed project ID nothing is requested
 * and the result is empty, not pending.
 */
export function useProjectFieldValuesQuery(
  actorId: string,
  workspaceId: string,
  projectId: string,
  taskIds: readonly string[],
): ProjectFieldValues {
  const chunks = isUuid(projectId) ? fieldValueTaskIdChunks(taskIds) : [];
  return useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: queryKeys.projectFieldValueChunk(actorId, workspaceId, projectId, chunk),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchProjectFieldValues(workspaceId, projectId, chunk, signal),
    })),
    combine: combineValueBatches,
  });
}

/** One field's value history on a task in server order, loaded page by page with `fetchNextPage()`. */
export function useTaskFieldHistoryQuery(actorId: string, workspaceId: string, taskId: string, fieldId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.taskFieldHistory(actorId, workspaceId, taskId, fieldId),
    queryFn: ({ signal, pageParam }) => fetchTaskFieldHistoryPage(workspaceId, taskId, fieldId, { cursor: pageParam, signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage: FieldHistoryPage) => lastPage.nextCursor,
    enabled: isUuid(taskId) && isUuid(fieldId),
  });
}

/*
 * Writes only invalidate: a confirmed answer, possibly an idempotent replay of an older one, is
 * never merged into the cache, and entries removed meanwhile (a workspace left) are not recreated.
 */

export function invalidateFieldDefinitions(queryClient: QueryClient, actorId: string, workspaceId: string, projectId: string) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.fieldDefinitions(actorId, workspaceId, projectId), exact: true });
}

export function invalidateProjectColumns(queryClient: QueryClient, actorId: string, workspaceId: string, projectId: string) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.projectColumns(actorId, workspaceId, projectId), exact: true });
}

/** A changed value: the task's values, the project's batches and that field's history. */
export function invalidateFieldValue(queryClient: QueryClient, actorId: string, workspaceId: string, value: TaskFieldValueDto) {
  return Promise.all([
    invalidateTaskTimelines(queryClient, actorId, workspaceId, [value.taskId]),
    queryClient.invalidateQueries({ queryKey: queryKeys.taskFieldValues(actorId, workspaceId, value.taskId), exact: true }),
    queryClient.invalidateQueries({ queryKey: queryKeys.projectFieldValues(actorId, workspaceId, value.projectId) }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.taskFieldHistory(actorId, workspaceId, value.taskId, value.fieldId),
      exact: true,
    }),
  ]);
}

export interface CreateTaskFieldVariables extends IdempotentVariables {
  input: CreateTaskFieldInput;
}

/** A new field is appended to the project's columns, so those refetch too. */
export function useCreateTaskFieldMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: CreateTaskFieldVariables) => createTaskFieldRequest(workspaceId, input),
    onSuccess: (field) => {
      void invalidateFieldDefinitions(queryClient, actorId, workspaceId, field.projectId);
      void invalidateProjectColumns(queryClient, actorId, workspaceId, field.projectId);
    },
  });
}

export interface UpdateTaskFieldVariables extends IdempotentVariables {
  fieldId: string;
  input: UpdateTaskFieldInput;
}

/** Archive and restore reconcile the columns and may change which values are listed. */
export function useUpdateTaskFieldMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ fieldId, input }: UpdateTaskFieldVariables) => updateTaskFieldRequest(workspaceId, fieldId, input),
    onSuccess: (field, { input }) => {
      void invalidateFieldDefinitions(queryClient, actorId, workspaceId, field.projectId);
      void invalidateProjectColumns(queryClient, actorId, workspaceId, field.projectId);
      if (input.archived !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workCategoryBinding(actorId, workspaceId, field.projectId), exact: true });
        void queryClient.invalidateQueries({ queryKey: queryKeys.fieldValues(actorId, workspaceId) });
      }
    },
  });
}

export interface CreateTaskFieldOptionVariables extends IdempotentVariables {
  fieldId: string;
  input: CreateTaskFieldOptionInput;
}

export function useCreateTaskFieldOptionMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ fieldId, input }: CreateTaskFieldOptionVariables) => createTaskFieldOptionRequest(workspaceId, fieldId, input),
    onSuccess: (field) => void invalidateFieldDefinitions(queryClient, actorId, workspaceId, field.projectId),
  });
}

export interface UpdateTaskFieldOptionVariables extends IdempotentVariables {
  fieldId: string;
  optionId: string;
  input: UpdateTaskFieldOptionInput;
}

export function useUpdateTaskFieldOptionMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ fieldId, optionId, input }: UpdateTaskFieldOptionVariables) =>
      updateTaskFieldOptionRequest(workspaceId, fieldId, optionId, input),
    onSuccess: (field) => void invalidateFieldDefinitions(queryClient, actorId, workspaceId, field.projectId),
  });
}

export interface UpdateProjectColumnsVariables extends IdempotentVariables {
  projectId: string;
  input: UpdateProjectColumnsInput;
}

export function useUpdateProjectColumnsMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ projectId, input }: UpdateProjectColumnsVariables) => updateProjectColumnsRequest(workspaceId, projectId, input),
    onSuccess: (columns) => void invalidateProjectColumns(queryClient, actorId, workspaceId, columns.projectId),
  });
}

export interface SetTaskFieldValueVariables extends IdempotentVariables {
  taskId: string;
  fieldId: string;
  input: SetTaskFieldValueInput;
}

export function useSetTaskFieldValueMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ taskId, fieldId, input }: SetTaskFieldValueVariables) =>
      setTaskFieldValueRequest(workspaceId, taskId, fieldId, input),
    onSuccess: (value) => void invalidateFieldValue(queryClient, actorId, workspaceId, value),
  });
}
