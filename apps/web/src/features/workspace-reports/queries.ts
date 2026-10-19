import { useQuery } from '@tanstack/react-query';
import type { WorkspaceReportQueryInput } from '@workloom/contracts';
import { ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { fetchWorkspaceReportSources, queryWorkspaceReport } from './api';
export const workspaceReportKeys = {
  root: (actorId: string, workspaceId: string) => [...queryKeys.workspace(actorId, workspaceId), 'workspace-reports'] as const,
};
export function useWorkspaceReportSources(actorId: string, workspaceId: string) {
  return useQuery({ queryKey: [...workspaceReportKeys.root(actorId, workspaceId), 'sources'], queryFn: ({ signal }) => fetchWorkspaceReportSources(workspaceId, signal), retry: false });
}
export function useWorkspaceReportResult(actorId: string, workspaceId: string, input: WorkspaceReportQueryInput | null) {
  return useQuery({ queryKey: [...workspaceReportKeys.root(actorId, workspaceId), 'result', input], queryFn: ({ signal }) => { if (!input) throw new ApiError({ kind: 'invalid_input', status: null }); return queryWorkspaceReport(workspaceId, input, signal); }, enabled: input !== null, retry: false, staleTime: 0 });
}
