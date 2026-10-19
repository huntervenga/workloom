import { workspaceReportQueryInputSchema, workspaceReportResultResponseSchema, workspaceReportSourcesResponseSchema, type WorkspaceReportQueryInput } from '@workloom/contracts';
import { ApiError, apiGet, apiRequest } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
export const workspaceReportsPath = (workspaceId: string) => `${workspacePath(workspaceId)}/workspace-reports`;
export async function fetchWorkspaceReportSources(workspaceId: string, signal?: AbortSignal) {
  return (await apiGet(`${workspaceReportsPath(workspaceId)}/sources`, workspaceReportSourcesResponseSchema, signal)).data;
}
/** POST performs a bounded read; no idempotent mutation/session or database write is created. */
export async function queryWorkspaceReport(workspaceId: string, input: WorkspaceReportQueryInput, signal?: AbortSignal) {
  const parsed = workspaceReportQueryInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const response = await apiRequest(`${workspaceReportsPath(workspaceId)}/query`, { method: 'POST', body: parsed.data, signal });
  const output = workspaceReportResultResponseSchema.safeParse(response.payload);
  if (!output.success) throw new ApiError({ kind: 'invalid_response', status: response.status });
  return output.data.data;
}
