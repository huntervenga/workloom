import {
  MATERIALIZATION_REQUIRED,
  recurrenceSeriesListQuerySchema, recurrenceInstanceListQuerySchema,
  recurrenceCreatePreviewInputSchema, createRecurrenceSeriesInputSchema,
  recurrenceEditPreviewInputSchema, editRecurrenceSeriesInputSchema,
  setRecurrenceSeriesStateInputSchema,
  recurrencePeriodPreviewInputSchema, addRecurrencePeriodsInputSchema,
  authorizeRecurrenceGenerationInputSchema,
  recurrenceExceptionPreviewInputSchema, setRecurrenceExceptionInputSchema,
  materializePeriodInputSchema,
  recurrenceSeriesResponseSchema, recurrenceSeriesListResponseSchema,
  recurrenceCreatePreviewResponseSchema, recurrenceEditPreviewResponseSchema,
  recurrencePeriodPreviewResponseSchema, recurrencePeriodsResultResponseSchema,
  recurrenceInstanceResponseSchema, recurrenceInstanceListResponseSchema,
  recurrenceExceptionPreviewResponseSchema, recurrenceMaterializationResultResponseSchema,
  recurrenceReadinessResponseSchema,
  type RecurrenceSeriesDto, type RecurrenceInstanceDto, type RecurrenceReadinessDto,
  type RecurrenceCreatePreviewInput, type RecurrenceCreatePreviewDto, type CreateRecurrenceSeriesInput,
  type RecurrenceEditPreviewInput, type RecurrenceEditPreviewDto, type EditRecurrenceSeriesInput,
  type SetRecurrenceSeriesStateInput,
  type RecurrencePeriodPreviewInput, type RecurrencePeriodPreviewDto, type AddRecurrencePeriodsInput,
  type AuthorizeRecurrenceGenerationInput,
  type RecurrenceExceptionPreviewInput, type RecurrenceExceptionPreviewDto, type SetRecurrenceExceptionInput,
  type MaterializePeriodInput,
} from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, prepareMutation, type ResponseParser } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

/** P3b recurrence transport; routes follow docs/16-p3b-contract.md §5. Previews are keyless reads, writes are keyed. */
interface ListEnvelope<T> { data: T[]; meta: { nextCursor?: string | null } }
const part = (value: string) => encodeURIComponent(value);
const path = (workspaceId: string, suffix: string) => `${workspacePath(workspaceId)}${suffix}`;
const projectPath = (workspaceId: string, projectId: string) => path(workspaceId, `/projects/${part(projectId)}`);
const seriesPath = (workspaceId: string, seriesId: string) => path(workspaceId, `/recurrence-series/${part(seriesId)}`);
const instancePath = (workspaceId: string, seriesId: string, occurrenceKey: string) =>
  `${seriesPath(workspaceId, seriesId)}/instances/${part(occurrenceKey)}`;
const periodPath = (workspaceId: string, periodId: string) => path(workspaceId, `/periods/${part(periodId)}`);

/** Serializes the shared schema's parsed query; booleans travel as the literal 'true'/'false' it accepts. */
function params(schema: ResponseParser<object>, input: object): string {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;
    result.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
  }
  return result.toString();
}

/** Reads every page by the server's nextCursor; a repeated cursor is a malformed answer, never a silent stop. */
async function allPages<T>(
  url: string, querySchema: ResponseParser<object>, query: object,
  responseSchema: ResponseParser<ListEnvelope<T>>, signal?: AbortSignal,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const search = params(querySchema, { ...query, limit: 100, ...(cursor ? { cursor } : {}) });
    const response = await apiGet(`${url}?${search}`, responseSchema, signal);
    items.push(...response.data);
    cursor = response.meta.nextCursor ?? null;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new ApiError({ kind: 'invalid_response', status: 200 });
      seen.add(cursor);
    }
  } while (cursor !== null);
  return items;
}

/** A consistent-read POST: no Idempotency-Key, nothing is written or materialized. */
async function preview<T>(
  url: string, inputSchema: ResponseParser<unknown>, input: unknown,
  responseSchema: ResponseParser<{ data: T }>, signal?: AbortSignal,
): Promise<T> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(url, { method: 'POST', body: parsed.data, signal });
  const result = responseSchema.safeParse(response.payload);
  if (!result.success) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return result.data.data;
}

/** The target period census is incomplete; recover with the readiness GET, never from error details. */
export function isMaterializationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === MATERIALIZATION_REQUIRED;
}

export function fetchRecurrenceSeries(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<RecurrenceSeriesDto[]> {
  return allPages(
    `${projectPath(workspaceId, projectId)}/recurrence-series`, recurrenceSeriesListQuerySchema, { state: 'all' },
    recurrenceSeriesListResponseSchema, signal,
  );
}

export async function fetchRecurrenceSeriesDetail(workspaceId: string, seriesId: string, signal?: AbortSignal): Promise<RecurrenceSeriesDto> {
  return (await apiGet(seriesPath(workspaceId, seriesId), recurrenceSeriesResponseSchema, signal)).data;
}

/** Every header of one bound period, cancelled header-only rows included. */
export function fetchRecurrenceInstances(workspaceId: string, seriesId: string, periodId: string, signal?: AbortSignal): Promise<RecurrenceInstanceDto[]> {
  return allPages(
    `${seriesPath(workspaceId, seriesId)}/instances`, recurrenceInstanceListQuerySchema, { periodId, includeCancelled: true },
    recurrenceInstanceListResponseSchema, signal,
  );
}

export async function fetchRecurrenceReadiness(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<RecurrenceReadinessDto> {
  return (await apiGet(`${periodPath(workspaceId, periodId)}/recurrence-readiness`, recurrenceReadinessResponseSchema, signal)).data;
}

export function previewRecurrenceCreate(workspaceId: string, projectId: string, input: RecurrenceCreatePreviewInput, signal?: AbortSignal): Promise<RecurrenceCreatePreviewDto> {
  return preview(`${projectPath(workspaceId, projectId)}/recurrence-preview`, recurrenceCreatePreviewInputSchema, input, recurrenceCreatePreviewResponseSchema, signal);
}

export function previewRecurrenceEdit(workspaceId: string, seriesId: string, input: RecurrenceEditPreviewInput, signal?: AbortSignal): Promise<RecurrenceEditPreviewDto> {
  return preview(`${seriesPath(workspaceId, seriesId)}/edit-preview`, recurrenceEditPreviewInputSchema, input, recurrenceEditPreviewResponseSchema, signal);
}

export function previewRecurrencePeriods(workspaceId: string, seriesId: string, input: RecurrencePeriodPreviewInput, signal?: AbortSignal): Promise<RecurrencePeriodPreviewDto> {
  return preview(`${seriesPath(workspaceId, seriesId)}/period-preview`, recurrencePeriodPreviewInputSchema, input, recurrencePeriodPreviewResponseSchema, signal);
}

export function previewRecurrenceException(
  workspaceId: string, seriesId: string, occurrenceKey: string, input: RecurrenceExceptionPreviewInput, signal?: AbortSignal,
): Promise<RecurrenceExceptionPreviewDto> {
  return preview(
    `${instancePath(workspaceId, seriesId, occurrenceKey)}/exception-preview`, recurrenceExceptionPreviewInputSchema, input,
    recurrenceExceptionPreviewResponseSchema, signal,
  );
}

export function createRecurrenceSeriesRequest(workspaceId: string, projectId: string, input: CreateRecurrenceSeriesInput) {
  return prepareMutation({ method: 'POST', path: `${projectPath(workspaceId, projectId)}/recurrence-series`, input, inputSchema: createRecurrenceSeriesInputSchema, responseSchema: recurrenceSeriesResponseSchema });
}

export function editRecurrenceSeriesRequest(workspaceId: string, seriesId: string, input: EditRecurrenceSeriesInput) {
  return prepareMutation({ method: 'POST', path: `${seriesPath(workspaceId, seriesId)}/edit`, input, inputSchema: editRecurrenceSeriesInputSchema, responseSchema: recurrenceSeriesResponseSchema });
}

export function setRecurrenceSeriesStateRequest(workspaceId: string, seriesId: string, input: SetRecurrenceSeriesStateInput) {
  return prepareMutation({ method: 'PATCH', path: `${seriesPath(workspaceId, seriesId)}/state`, input, inputSchema: setRecurrenceSeriesStateInputSchema, responseSchema: recurrenceSeriesResponseSchema });
}

export function addRecurrencePeriodsRequest(workspaceId: string, seriesId: string, input: AddRecurrencePeriodsInput) {
  return prepareMutation({ method: 'POST', path: `${seriesPath(workspaceId, seriesId)}/periods`, input, inputSchema: addRecurrencePeriodsInputSchema, responseSchema: recurrencePeriodsResultResponseSchema });
}

export function authorizeRecurrenceGenerationRequest(workspaceId: string, seriesId: string, input: AuthorizeRecurrenceGenerationInput) {
  return prepareMutation({ method: 'POST', path: `${seriesPath(workspaceId, seriesId)}/generation-authorization`, input, inputSchema: authorizeRecurrenceGenerationInputSchema, responseSchema: recurrenceSeriesResponseSchema });
}

export function setRecurrenceExceptionRequest(workspaceId: string, seriesId: string, occurrenceKey: string, input: SetRecurrenceExceptionInput) {
  return prepareMutation({ method: 'POST', path: `${instancePath(workspaceId, seriesId, occurrenceKey)}/exception`, input, inputSchema: setRecurrenceExceptionInputSchema, responseSchema: recurrenceInstanceResponseSchema });
}

/** One bounded chunk per call; continuing with nextCursor is an explicit caller action, never a hidden loop. */
export function materializeRecurrencePeriodRequest(workspaceId: string, periodId: string, input: MaterializePeriodInput) {
  return prepareMutation({ method: 'POST', path: `${periodPath(workspaceId, periodId)}/materialize-meetings`, input, inputSchema: materializePeriodInputSchema, responseSchema: recurrenceMaterializationResultResponseSchema });
}
