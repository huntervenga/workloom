import { useCallback, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryGenericHeaderWidgetsInput, ProjectDto, WorkspaceDto, CaptureGenericInitialInput, CreateGenericReportInput, PlanFactTemplateInput, QueryGenericAggregatesInput, QueryGenericReportInput, SetGenericAggregateSettingsInput, UpdateGenericReportInput } from '@workloom/contracts';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { queryKeys } from '../../lib/queryKeys';
import * as api from './api';
export const reportKeys = {
  root: (actorId: string, workspaceId: string) => [...queryKeys.workspace(actorId, workspaceId), 'generic-reports'] as const,
  list: (actorId: string, workspaceId: string, projectId: string) => [...reportKeys.root(actorId, workspaceId), 'list', projectId] as const,
  definition: (actorId: string, workspaceId: string, reportId: string) => [...reportKeys.root(actorId, workspaceId), 'definition', reportId] as const,
  snapshots: (actorId: string, workspaceId: string, reportId: string) => [...reportKeys.root(actorId, workspaceId), 'snapshots', reportId] as const,
  settings: (actorId: string, workspaceId: string, projectId: string) => [...reportKeys.root(actorId, workspaceId), 'aggregate-settings', projectId] as const,
};
export function useReports(actorId: string, workspaceId: string, projectId: string) { return useQuery({ queryKey: reportKeys.list(actorId, workspaceId, projectId), queryFn: ({ signal }) => api.fetchReports(workspaceId, projectId, signal) }); }
export function useReport(actorId: string, workspaceId: string, reportId: string) { return useQuery({ queryKey: reportKeys.definition(actorId, workspaceId, reportId), queryFn: ({ signal }) => api.fetchReport(workspaceId, reportId, signal), enabled: reportId !== '' }); }
export function useInitialSnapshots(actorId: string, workspaceId: string, reportId: string) { return useQuery({ queryKey: reportKeys.snapshots(actorId, workspaceId, reportId), queryFn: ({ signal }) => api.fetchInitialSnapshots(workspaceId, reportId, signal), enabled: reportId !== '' }); }
export function useReportResult(actorId: string, workspaceId: string, reportId: string, input: QueryGenericReportInput, enabled: boolean) { return useQuery({ queryKey: [...reportKeys.definition(actorId, workspaceId, reportId), 'result', input], queryFn: ({ signal }) => api.queryReport(workspaceId, reportId, input, signal), enabled: enabled && reportId !== '', staleTime: 0, retry: false }); }
export function useAggregateSettings(actorId: string, workspaceId: string, projectId: string, enabled = true) { return useQuery({ queryKey: reportKeys.settings(actorId, workspaceId, projectId), queryFn: ({ signal }) => api.fetchAggregateSettings(workspaceId, projectId, signal), enabled }); }
export function aggregateQueryOptions(actorId: string, workspaceId: string, projectId: string, input: QueryGenericAggregatesInput, enabled: boolean) { return { queryKey: [...reportKeys.root(actorId, workspaceId), 'aggregates', projectId, input], queryFn: ({ signal }: { signal: AbortSignal }) => api.queryAggregates(workspaceId, projectId, input, signal), enabled, staleTime: 0, retry: false as const }; }
export function useAggregates(actorId: string, workspaceId: string, projectId: string, input: QueryGenericAggregatesInput, enabled: boolean) { return useQuery(aggregateQueryOptions(actorId, workspaceId, projectId, input, enabled)); }
export function useReportCommands(actorId: string, workspaceId: string, projectId: string) {
  const client = useQueryClient();
  const invalidate = () => { void client.invalidateQueries({ queryKey: reportKeys.root(actorId, workspaceId) }); };
  const create = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: CreateGenericReportInput }) => api.createReportRequest(workspaceId, input), onSuccess: invalidate });
  const update = useIdempotentMutation({ prepare: ({ reportId, input }: IdempotentVariables & { reportId: string; input: UpdateGenericReportInput }) => api.updateReportRequest(workspaceId, reportId, input), onSuccess: invalidate });
  const capture = useIdempotentMutation({ prepare: ({ reportId, input }: IdempotentVariables & { reportId: string; input: CaptureGenericInitialInput }) => api.captureInitialRequest(workspaceId, reportId, input), onSuccess: invalidate });
  const template = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: PlanFactTemplateInput }) => api.applyTemplateRequest(workspaceId, projectId, input), onSuccess: () => { invalidate(); void client.invalidateQueries({ queryKey: queryKeys.fieldDefinitions(actorId, workspaceId, projectId) }); void client.invalidateQueries({ queryKey: queryKeys.projectColumns(actorId, workspaceId, projectId) }); } });
  const aggregates = useIdempotentMutation({ prepare: ({ input }: IdempotentVariables & { input: SetGenericAggregateSettingsInput }) => api.setAggregateSettingsRequest(workspaceId, projectId, input), onSuccess: invalidate });
  return { create, update, capture, template, aggregates };
}

/** Cached authorization is usable only while its exact actor/workspace/project read is current. */
export function useCurrentReportAccess(actorId: string, workspaceId: string, projectId: string) {
  const client = useQueryClient();
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(notify), [client]);
  return useSyncExternalStore(subscribe, () => {
    const identity = client.getQueryData<{ actor: { id: string } }>(queryKeys.me);
    const workspace = client.getQueryState<WorkspaceDto>(queryKeys.workspace(actorId, workspaceId));
    const project = client.getQueryState<ProjectDto>(queryKeys.project(actorId, workspaceId, projectId));
    if (identity?.actor.id !== actorId || workspace?.status !== 'success' || workspace.fetchStatus !== 'idle' || workspace.isInvalidated || project?.status !== 'success' || project.fetchStatus !== 'idle' || project.isInvalidated || project.data?.archivedAt !== null) return 'blocked';
    return workspace.data?.role ?? 'blocked';
  }, () => 'blocked');
}

export function useHeaderWidgetResults(actorId: string, workspaceId: string, projectId: string, input: QueryGenericHeaderWidgetsInput, enabled: boolean, projectRevision?: number) { return useQuery({ queryKey: [...reportKeys.root(actorId, workspaceId), 'header-widgets', projectId, input, projectRevision], queryFn: ({ signal }) => api.queryHeaderWidgets(workspaceId, projectId, input, signal), enabled, staleTime: 0, retry: false }); }
