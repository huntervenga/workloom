import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  membershipListResponseSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
} from '@workloom/contracts';
import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { WorkspaceHeadRechecks } from '../../lib/workspaceHeadRechecks';
import { isWorkspaceRefreshProtected, observeWorkspaceRefreshInteraction } from '../../lib/workspaceRefreshProtection';
import { clearWorkspaceHeadDenial, useWorkspaceHeadDenial, workspaceHeadDenial } from '../../lib/workspaceHeadDenial';

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
  const client = useQueryClient();
  const headDenial = useWorkspaceHeadDenial(client, actorId, id);
  const recovery = useRef<WorkspaceHeadRechecks | null>(null);
  const [recoveringHeadAccess, setRecoveringHeadAccess] = useState(false);
  useEffect(() => {
    const stopIfUnsafe = () => {
      if (document.visibilityState !== 'visible' || isWorkspaceRefreshProtected(client)) recovery.current?.stop();
    };
    const interaction = observeWorkspaceRefreshInteraction(client, stopIfUnsafe);
    document.addEventListener('visibilitychange', stopIfUnsafe);
    return () => { recovery.current?.stop(); interaction(); document.removeEventListener('visibilitychange', stopIfUnsafe); };
  }, [actorId, client, id]);
  const query = useQuery({
    queryKey: queryKeys.workspace(actorId, id),
    queryFn: async ({ signal }) => {
      const owner = recovery.current;
      const guard = () => { if (owner && !owner.isCurrent()) throw new CancelledError({ revert: true, silent: true }); };
      try {
        guard();
        const answer = (await apiGet(workspacePath(id), workspaceResponseSchema, signal)).data;
        guard();
        return answer;
      } catch (error) { guard(); throw error; }
    },
    enabled: () => isUuid(id) && workspaceHeadDenial(client, actorId, id) === null,
  });
  return { ...query, headDenial, recoveringHeadAccess, refetch: async (...args: Parameters<typeof query.refetch>) => {
    if (!headDenial) return query.refetch(...args);
    if (recovery.current !== null) return query;
    const owner = new WorkspaceHeadRechecks(client, actorId, id,
      () => document.visibilityState === 'visible' && !isWorkspaceRefreshProtected(client));
    recovery.current = owner; setRecoveringHeadAccess(true);
    try {
      const me = await owner.verifyIdentity();
      // A safe changed actor is published by the owned reader and follows AppShell's existing
      // reset path. It must never authorize another root/content request under the old keys.
      if (!me || me.actor.id.toLowerCase() !== actorId.toLowerCase() || !owner.isCurrent()) return query;
      const result = await owner.rootRefetch(() => query.refetch(...args));
      if (result?.isSuccess && owner.isCurrent() && result.data.id.toLowerCase() === id.toLowerCase()) {
        clearWorkspaceHeadDenial(client, actorId, id, headDenial);
      }
      return result ?? query;
    } finally {
      owner.stop();
      if (recovery.current === owner) { recovery.current = null; setRecoveringHeadAccess(false); }
    }
  } };
}

export function useMembershipsQuery(actorId: string, workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.memberships(actorId, workspaceId),
    queryFn: async ({ signal }) =>
      (await apiGet(`${workspacePath(workspaceId)}/memberships`, membershipListResponseSchema, signal)).data,
  });
}
