import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { type MembershipDto, type WorkspaceDto } from '@workloom/contracts';
import { useEffect } from 'react';
import { ApiError } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { WorkspaceHeadRechecks } from '../../lib/workspaceHeadRechecks';
import { fetchWorkspaceChangeHead, WorkspaceHeadBindingError, workspaceChangeHeadKey } from './workspaceChangeHead';
import { WorkspaceLiveRefreshController } from './workspaceLiveRefreshController';
import { refreshWorkspaceLiveQueries } from './workspaceLiveQueries';
import { isWorkspaceRefreshProtected, observeWorkspaceRefreshInteraction, setWorkspaceRefreshComposing } from './workspaceRefreshInteraction';

function ownMembership(client: QueryClient, actorId: string, workspaceId: string): string | null {
  return client.getQueryData<MembershipDto[]>(queryKeys.memberships(actorId, workspaceId))
    ?.find(member => member.userId.toLowerCase() === actorId.toLowerCase())?.id ?? null;
}

/** Mounted once by ShellFrame only after the current workspace was successfully authorized. */
export function useWorkspaceLiveRefresh(actorId: string, workspaceId: string | null, enabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled || workspaceId === null || !isUuid(actorId) || !isUuid(workspaceId)) return;
    const key = workspaceChangeHeadKey(actorId, workspaceId);
    let composing = false;
    const rechecks = new WorkspaceHeadRechecks(client, actorId, workspaceId,
      () => document.visibilityState === 'visible' && !isWorkspaceRefreshProtected(client, composing));
    const recheckAccess = rechecks.access;
    const controller = new WorkspaceLiveRefreshController({
      readHead: async (signal, previous) => {
        const cancel = () => { void client.cancelQueries({ queryKey: key, exact: true }); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          return await client.fetchQuery({ queryKey: key, retry: false, staleTime: 0,
            queryFn: async ({ signal: querySignal }) => {
              let head;
              try { head = await fetchWorkspaceChangeHead(actorId, workspaceId, ownMembership(client, actorId, workspaceId), querySignal); }
              catch (error) {
                if (!signal.aborted && error instanceof ApiError && error.kind === 'unauthenticated') rechecks.identity();
                throw error;
              }
              if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
              if (previous !== null && (BigInt(head.changeSeq) < BigInt(previous.changeSeq) ||
                BigInt(head.permissionEpoch) < BigInt(previous.permissionEpoch))) throw new WorkspaceHeadBindingError({ binding: 'workspace' });
              const workspace = client.getQueryData<WorkspaceDto>(queryKeys.workspace(actorId, workspaceId));
              if (previous === null && workspace?.role !== head.role) recheckAccess();
              return head;
            },
          });
        } finally { signal.removeEventListener('abort', cancel); }
      },
      refresh: (signal, safe) => refreshWorkspaceLiveQueries(client, actorId, workspaceId, signal, safe),
      protected: () => isWorkspaceRefreshProtected(client, composing),
      recheckAccess,
      rejectedHead: error => {
        if (!(error instanceof WorkspaceHeadBindingError)) return;
        if (error.binding === 'actor') rechecks.identity();
        else if (error.binding === 'membership') recheckAccess();
      },
    });
    const interactionChanged = () => {
      if (isWorkspaceRefreshProtected(client, composing)) rechecks.cancel();
      controller.interactionChanged();
    };
    const interaction = observeWorkspaceRefreshInteraction(client, interactionChanged);
    const visibility = () => {
      if (document.visibilityState !== 'visible') rechecks.cancel();
      controller.setVisible(document.visibilityState === 'visible');
    };
    const focus = () => { if (document.visibilityState === 'visible') controller.wake(); };
    const compositionStart = () => { composing = true; setWorkspaceRefreshComposing(client, true); interactionChanged(); };
    const compositionEnd = () => { composing = false; setWorkspaceRefreshComposing(client, false); interactionChanged(); };
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('compositionstart', compositionStart, true);
    document.addEventListener('compositionend', compositionEnd, true);
    window.addEventListener('focus', focus);
    visibility();
    return () => {
      rechecks.stop(); controller.stop(); interaction(); setWorkspaceRefreshComposing(client, false);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('compositionstart', compositionStart, true);
      document.removeEventListener('compositionend', compositionEnd, true);
      window.removeEventListener('focus', focus);
    };
  }, [actorId, client, enabled, workspaceId]);
}
