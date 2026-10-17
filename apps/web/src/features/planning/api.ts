import {
  createPlanningPeriodInputSchema, updatePlanningPeriodInputSchema,
  createPeriodCommitmentInputSchema, updatePeriodCommitmentInputSchema,
  freezePreviewInputSchema, freezePreviewResponseSchema, freezePlanInputSchema,
  setManualPeriodWorkInputSchema, createWeeklyPlanFactReportInputSchema,
  planningPeriodResponseSchema, planningPeriodListResponseSchema, planningPeriodListQuerySchema,
  planningPackageListResponseSchema, planningPackageListQuerySchema,
  periodCommitmentResponseSchema, periodCommitmentListResponseSchema, periodCommitmentListQuerySchema,
  planBaselineResponseSchema, planBaselineListResponseSchema, packageBaselineResponseSchema, originalPackageEstimateResponseSchema,
  manualPeriodWorkLogResponseSchema, manualPeriodWorkLogListResponseSchema, workLogListQuerySchema,
  weeklyPlanFactReportRunResponseSchema, weeklyPlanFactReportRunListResponseSchema,
  weeklyPlanFactRowListResponseSchema, reportRunListQuerySchema, planningPageQuerySchema,
  type CreatePlanningPeriodInput, type UpdatePlanningPeriodInput,
  type CreatePeriodCommitmentInput, type UpdatePeriodCommitmentInput,
  type FreezePreviewInput, type FreezePreviewDto, type FreezePlanInput,
  type SetManualPeriodWorkInput, type CreateWeeklyPlanFactReportInput,
  type PlanningPeriodDto, type PlanningPackageDto, type PeriodCommitmentDto,
  type PlanBaselineDto, type ManualPeriodWorkLogDto, type WeeklyPlanFactReportRunDto,
  type WeeklyPlanFactRowDto, type OriginalPackageEstimateDto,
} from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, prepareMutation, type ResponseParser } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export interface PlanningPage<T> { items: T[]; nextCursor: string | null }
interface ListEnvelope<T> { data: T[]; meta: { nextCursor?: string | null } }
const part = (id: string) => encodeURIComponent(id);
const path = (workspaceId: string, suffix: string) => `${workspacePath(workspaceId)}${suffix}`;
const periodPath = (workspaceId: string, periodId: string) => path(workspaceId, `/periods/${part(periodId)}`);

function params(schema: ResponseParser<object>, input: object): string {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const result = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) result.set(key, String(value));
  }
  return result.toString();
}

/** Fully reads a paginated planning collection; no arbitrary first-page totals or silent cap. */
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

export function fetchPlanningPeriods(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<PlanningPeriodDto[]> {
  return allPages(path(workspaceId, '/periods'), planningPeriodListQuerySchema, { projectId }, planningPeriodListResponseSchema, signal);
}
export async function fetchPlanningPeriod(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<PlanningPeriodDto> {
  return (await apiGet(periodPath(workspaceId, periodId), planningPeriodResponseSchema, signal)).data;
}
export function fetchPlanningPackages(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<PlanningPackageDto[]> {
  return allPages(path(workspaceId, '/planning-packages'), planningPackageListQuerySchema, { projectId }, planningPackageListResponseSchema, signal);
}
export function fetchPeriodCommitments(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<PeriodCommitmentDto[]> {
  return allPages(`${periodPath(workspaceId, periodId)}/commitments`, periodCommitmentListQuerySchema, {}, periodCommitmentListResponseSchema, signal);
}
export function fetchPlanBaselines(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<PlanBaselineDto[]> {
  return allPages(`${periodPath(workspaceId, periodId)}/baselines`, planningPageQuerySchema, {}, planBaselineListResponseSchema, signal);
}
export async function fetchPlanBaseline(workspaceId: string, baselineId: string, signal?: AbortSignal) {
  return (await apiGet(path(workspaceId, `/baselines/${part(baselineId)}`), planBaselineResponseSchema, signal)).data;
}
export async function fetchPackageBaseline(workspaceId: string, baselineId: string, signal?: AbortSignal) {
  return (await apiGet(path(workspaceId, `/package-baselines/${part(baselineId)}`), packageBaselineResponseSchema, signal)).data;
}
/** Read-only first-freeze projection of one whole package; it never carries the current estimate. */
export async function fetchOriginalPackageEstimate(workspaceId: string, packageId: string, signal?: AbortSignal): Promise<OriginalPackageEstimateDto> {
  return (await apiGet(path(workspaceId, `/planning-packages/${part(packageId)}/original-estimate`), originalPackageEstimateResponseSchema, signal)).data;
}
export function fetchPeriodWorkLogs(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<ManualPeriodWorkLogDto[]> {
  return allPages(path(workspaceId, '/worklogs'), workLogListQuerySchema, { periodId }, manualPeriodWorkLogListResponseSchema, signal);
}
export function fetchReportRuns(workspaceId: string, periodId: string, signal?: AbortSignal): Promise<WeeklyPlanFactReportRunDto[]> {
  return allPages(path(workspaceId, '/report-runs'), reportRunListQuerySchema, { periodId }, weeklyPlanFactReportRunListResponseSchema, signal);
}
export async function fetchReportRun(workspaceId: string, runId: string, signal?: AbortSignal): Promise<WeeklyPlanFactReportRunDto> {
  return (await apiGet(path(workspaceId, `/report-runs/${part(runId)}`), weeklyPlanFactReportRunResponseSchema, signal)).data;
}
export async function fetchReportRows(workspaceId: string, runId: string, cursor: string | null, signal?: AbortSignal): Promise<PlanningPage<WeeklyPlanFactRowDto>> {
  const search = params(planningPageQuerySchema, { limit: 50, ...(cursor ? { cursor } : {}) });
  const response = await apiGet(path(workspaceId, `/report-runs/${part(runId)}/rows?${search}`), weeklyPlanFactRowListResponseSchema, signal);
  return { items: response.data, nextCursor: response.meta.nextCursor ?? null };
}

/** This POST is a consistent read: no Idempotency-Key and no automatic freeze. */
export async function fetchFreezePreview(workspaceId: string, periodId: string, input: FreezePreviewInput, signal?: AbortSignal): Promise<FreezePreviewDto> {
  const parsed = freezePreviewInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(`${periodPath(workspaceId, periodId)}/freeze-preview`, { method: 'POST', body: parsed.data, signal });
  const result = freezePreviewResponseSchema.safeParse(response.payload);
  if (!result.success) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return result.data.data;
}

export function createPlanningPeriodRequest(workspaceId: string, input: CreatePlanningPeriodInput) {
  return prepareMutation({ method: 'POST', path: path(workspaceId, '/periods'), input, inputSchema: createPlanningPeriodInputSchema, responseSchema: planningPeriodResponseSchema });
}

export function updatePlanningPeriodRequest(workspaceId: string, periodId: string, input: UpdatePlanningPeriodInput) {
  return prepareMutation({ method: 'PATCH', path: periodPath(workspaceId, periodId), input, inputSchema: updatePlanningPeriodInputSchema, responseSchema: planningPeriodResponseSchema });
}

export function createPeriodCommitmentRequest(workspaceId: string, periodId: string, input: CreatePeriodCommitmentInput) {
  return prepareMutation({ method: 'POST', path: `${periodPath(workspaceId, periodId)}/commitments`, input, inputSchema: createPeriodCommitmentInputSchema, responseSchema: periodCommitmentResponseSchema });
}

export function updatePeriodCommitmentRequest(workspaceId: string, periodId: string, commitmentId: string, input: UpdatePeriodCommitmentInput) {
  return prepareMutation({ method: 'PUT', path: `${periodPath(workspaceId, periodId)}/commitments/${part(commitmentId)}`, input, inputSchema: updatePeriodCommitmentInputSchema, responseSchema: periodCommitmentResponseSchema });
}

export function freezePlanRequest(workspaceId: string, periodId: string, input: FreezePlanInput) {
  return prepareMutation({ method: 'POST', path: `${periodPath(workspaceId, periodId)}/freeze`, input, inputSchema: freezePlanInputSchema, responseSchema: planBaselineResponseSchema });
}

export function setManualPeriodWorkRequest(workspaceId: string, taskId: string, periodId: string, membershipId: string, input: SetManualPeriodWorkInput) {
  return prepareMutation({ method: 'PUT', path: path(workspaceId, `/tasks/${part(taskId)}/manual-period-work/${part(periodId)}/${part(membershipId)}`), input, inputSchema: setManualPeriodWorkInputSchema, responseSchema: manualPeriodWorkLogResponseSchema });
}

export function createWeeklyReportRequest(workspaceId: string, input: CreateWeeklyPlanFactReportInput) {
  return prepareMutation({ method: 'POST', path: path(workspaceId, '/report-runs'), input, inputSchema: createWeeklyPlanFactReportInputSchema, responseSchema: weeklyPlanFactReportRunResponseSchema });
}
