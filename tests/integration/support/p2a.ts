// Actual P2a HTTP catalog frozen in docs/13; no guessed application exports.
import {
  freezePreviewResponseSchema, manualPeriodWorkLogListResponseSchema, manualPeriodWorkLogResponseSchema,
  packageBaselineResponseSchema, periodCommitmentListResponseSchema, periodCommitmentResponseSchema,
  planBaselineListResponseSchema, planBaselineResponseSchema, planningPackageListResponseSchema,
  planningPeriodListResponseSchema, planningPeriodResponseSchema,
  weeklyPlanFactReportRunListResponseSchema, weeklyPlanFactReportRunResponseSchema, weeklyPlanFactRowListResponseSchema,
  type CreatePeriodCommitmentInput, type CreatePlanningPeriodInput, type CreateWeeklyPlanFactReportInput,
  type FreezeScope, type ManualPeriodWorkLogDto, type PeriodCommitmentDto, type PlanBaselineDto,
  type PlanningPackageDto, type PlanningPeriodDto, type SetManualPeriodWorkInput,
  type UpdatePeriodCommitmentInput, type UpdatePlanningPeriodInput, type WeeklyPlanFactReportRunDto, type WeeklyPlanFactRowDto,
} from '@workloom/contracts';

import { expectEnvelope } from './p1a.js';
import { P1bClient } from './p1b.js';
import type { RawResponse } from './http.js';

interface Envelope<T> { readonly data: T[]; readonly meta: { readonly nextCursor?: string | null } }
interface Parser<T> { parse(value: unknown): T }
export interface Page<T> { readonly items: T[]; readonly nextCursor: string | null }

export class P2aClient extends P1bClient {
  async page<T>(path: string, schema: Parser<Envelope<T>>, params: Record<string, string | number | undefined> = {}): Promise<Page<T>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const body = expectEnvelope(await this.get(`${path}${query.size ? `?${query}` : ''}`), 200, schema);
    if (body.meta.nextCursor === undefined) throw new Error('Paged P2a response omitted nextCursor.');
    return { items: body.data, nextCursor: body.meta.nextCursor };
  }

  async all<T>(path: string, schema: Parser<Envelope<T>>, params: Record<string, string | number | undefined> = {}, limit = 2): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let index = 0; index < 100; index++) {
      const page = await this.page(path, schema, { ...params, limit, cursor });
      items.push(...page.items);
      if (page.nextCursor === null) return items;
      if (seen.has(page.nextCursor)) throw new Error('P2a list repeated cursor.');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error('P2a list exceeded bounded pagination.');
  }

  async createPeriod(input: Omit<CreatePlanningPeriodInput, 'protectEstimate' | 'protectedFieldIds'> & Partial<Pick<CreatePlanningPeriodInput, 'protectEstimate' | 'protectedFieldIds'>>) {
    return expectEnvelope(await this.post('/periods', input), 201, planningPeriodResponseSchema).data;
  }
  async getPeriod(id: string) { return expectEnvelope(await this.get(`/periods/${id}`), 200, planningPeriodResponseSchema).data; }
  async updatePeriod(id: string, input: UpdatePlanningPeriodInput) {
    return expectEnvelope(await this.patch(`/periods/${id}`, input), 200, planningPeriodResponseSchema).data;
  }
  periods(projectId: string): Promise<PlanningPeriodDto[]> { return this.all('/periods', planningPeriodListResponseSchema, { projectId }); }
  packages(projectId: string): Promise<PlanningPackageDto[]> { return this.all('/planning-packages', planningPackageListResponseSchema, { projectId }); }

  async createCommitment(periodId: string, input: Omit<CreatePeriodCommitmentInput, 'allocations'> & Partial<Pick<CreatePeriodCommitmentInput, 'allocations'>>) {
    return expectEnvelope(await this.post(`/periods/${periodId}/commitments`, input), 201, periodCommitmentResponseSchema).data;
  }
  async updateCommitment(periodId: string, id: string, input: UpdatePeriodCommitmentInput) {
    return expectEnvelope(await this.put(`/periods/${periodId}/commitments/${id}`, input), 200, periodCommitmentResponseSchema).data;
  }
  commitments(periodId: string, membershipId?: string): Promise<PeriodCommitmentDto[]> {
    return this.all(`/periods/${periodId}/commitments`, periodCommitmentListResponseSchema, { membershipId });
  }

  async preview(periodId: string, scope: FreezeScope = 'project') {
    return expectEnvelope(await this.post(`/periods/${periodId}/freeze-preview`, { scope }, null), 200, freezePreviewResponseSchema).data;
  }
  freezeRequest(periodId: string, scope: FreezeScope, previewHash: string, key?: string): Promise<RawResponse> {
    return this.post(`/periods/${periodId}/freeze`, { scope, previewHash }, key);
  }
  async freeze(periodId: string, scope: FreezeScope = 'project') {
    const preview = await this.preview(periodId, scope);
    return expectEnvelope(await this.freezeRequest(periodId, scope, preview.previewHash), 200, planBaselineResponseSchema).data;
  }
  baselines(periodId: string): Promise<PlanBaselineDto[]> { return this.all(`/periods/${periodId}/baselines`, planBaselineListResponseSchema); }
  async baseline(id: string) { return expectEnvelope(await this.get(`/baselines/${id}`), 200, planBaselineResponseSchema).data; }
  async packageBaseline(id: string) { return expectEnvelope(await this.get(`/package-baselines/${id}`), 200, packageBaselineResponseSchema).data; }

  workPath(taskId: string, periodId: string, membershipId: string) {
    return `/tasks/${taskId}/manual-period-work/${periodId}/${membershipId}`;
  }
  async setWork(taskId: string, periodId: string, membershipId: string, input: Omit<SetManualPeriodWorkInput, 'state' | 'reason'> & Partial<Pick<SetManualPeriodWorkInput, 'state' | 'reason'>>, key?: string) {
    return expectEnvelope(await this.put(this.workPath(taskId, periodId, membershipId), input, key), 200, manualPeriodWorkLogResponseSchema).data;
  }
  workLogs(periodId: string, extra: { taskId?: string; membershipId?: string } = {}): Promise<ManualPeriodWorkLogDto[]> {
    return this.all('/worklogs', manualPeriodWorkLogListResponseSchema, { periodId, ...extra });
  }
  async report(input: Omit<CreateWeeklyPlanFactReportInput, 'membershipIds' | 'knownEstimatesOnly'> & Partial<Pick<CreateWeeklyPlanFactReportInput, 'membershipIds' | 'knownEstimatesOnly'>>, key?: string) {
    return expectEnvelope(await this.post('/report-runs', input, key), 201, weeklyPlanFactReportRunResponseSchema).data;
  }
  async getReport(id: string) { return expectEnvelope(await this.get(`/report-runs/${id}`), 200, weeklyPlanFactReportRunResponseSchema).data; }
  reports(periodId: string): Promise<WeeklyPlanFactReportRunDto[]> { return this.all('/report-runs', weeklyPlanFactReportRunListResponseSchema, { periodId }); }
  reportRows(id: string, limit = 2): Promise<WeeklyPlanFactRowDto[]> { return this.all(`/report-runs/${id}/rows`, weeklyPlanFactRowListResponseSchema, {}, limit); }
}
