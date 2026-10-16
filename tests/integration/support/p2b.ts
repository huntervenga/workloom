// Actual eight-route P2b HTTP catalog from docs/14. Real API/PG harness only.
import {
  categorizedWorkLogResponseSchema, projectWorkCategoryBindingResponseSchema,
  taskTimeSummaryResponseSchema, workTypeReportRowListResponseSchema,
  workTypeReportRunListResponseSchema, workTypeReportRunResponseSchema,
  type CreateWorkTypeReportRunInput, type RecategorizeWorkLogInput,
  type UpdateProjectWorkCategoryBindingInput, type WorkTypeReportRowDto, type WorkTypeReportRunDto,
} from '@workloom/contracts';

import { expectEnvelope } from './p1a.js';
import { P2aClient } from './p2a.js';

export class P2bClient extends P2aClient {
  bindingPath(projectId: string): string { return `/projects/${projectId}/work-category-binding`; }
  async binding(projectId: string) {
    return expectEnvelope(await this.get(this.bindingPath(projectId)), 200, projectWorkCategoryBindingResponseSchema).data;
  }
  async bind(projectId: string, input: UpdateProjectWorkCategoryBindingInput, key?: string) {
    return expectEnvelope(await this.patch(this.bindingPath(projectId), input, key), 200, projectWorkCategoryBindingResponseSchema).data;
  }
  async recategorize(workLogId: string, input: RecategorizeWorkLogInput, key?: string) {
    return expectEnvelope(await this.post(`/worklogs/${workLogId}/recategorize`, input, key), 200, categorizedWorkLogResponseSchema).data;
  }
  async typeReport(input: Omit<CreateWorkTypeReportRunInput, 'membershipIds'> & Partial<Pick<CreateWorkTypeReportRunInput, 'membershipIds'>>, key?: string) {
    return expectEnvelope(await this.post('/work-type-report-runs', input, key), 201, workTypeReportRunResponseSchema).data;
  }
  async getTypeReport(id: string) {
    return expectEnvelope(await this.get(`/work-type-report-runs/${id}`), 200, workTypeReportRunResponseSchema).data;
  }
  typeReports(periodId: string): Promise<WorkTypeReportRunDto[]> {
    return this.all('/work-type-report-runs', workTypeReportRunListResponseSchema, { periodId });
  }
  typeRows(id: string, limit = 2): Promise<WorkTypeReportRowDto[]> {
    return this.all(`/work-type-report-runs/${id}/rows`, workTypeReportRowListResponseSchema, {}, limit);
  }
  summaryPath(projectId: string, periodId: string, taskIds: readonly string[], membershipId?: string) {
    const query = new URLSearchParams({ taskIds: taskIds.join(',') });
    if (membershipId !== undefined) query.set('membershipId', membershipId);
    return `/projects/${projectId}/periods/${periodId}/task-time-summary?${query}`;
  }
  async timeSummary(projectId: string, periodId: string, taskIds: readonly string[], membershipId?: string) {
    return expectEnvelope(await this.get(this.summaryPath(projectId, periodId, taskIds, membershipId)), 200, taskTimeSummaryResponseSchema).data;
  }
}
