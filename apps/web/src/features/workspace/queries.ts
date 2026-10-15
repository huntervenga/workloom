import { useQuery } from '@tanstack/react-query';
import {
  membershipListResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
} from '@workloom/contracts';
import { apiGet } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';

export function workspacePath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function useWorkspacesQuery(actorId: string) {
  return useQuery({
    queryKey: queryKeys.workspaces(actorId),
    queryFn: async ({ signal }) => (await apiGet('/api/v1/workspaces', workspaceListResponseSchema, signal)).data,
  });
}

/** Disabled for missing or malformed IDs, which are treated as unavailable without a request. */
export function useWorkspaceQuery(actorId: string, workspaceId: string | null) {
  const id = workspaceId ?? '';
  return useQuery({
    queryKey: queryKeys.workspace(actorId, id),
    queryFn: async ({ signal }) => (await apiGet(workspacePath(id), workspaceResponseSchema, signal)).data,
    enabled: isUuid(id),
  });
}

export function useMembershipsQuery(actorId: string, workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.memberships(actorId, workspaceId),
    queryFn: async ({ signal }) =>
      (await apiGet(`${workspacePath(workspaceId)}/memberships`, membershipListResponseSchema, signal)).data,
  });
}
