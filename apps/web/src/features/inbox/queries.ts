import { useQuery } from '@tanstack/react-query';
import { fetchInbox } from './api';

export const inboxKey = (actorId: string, workspaceId: string) => ['actor', actorId, 'workspace', workspaceId, 'inbox'] as const;

/** Refreshed when the window regains focus and once a minute while it is open. */
export function useInboxQuery(actorId: string, workspaceId: string) {
  return useQuery({
    queryKey: inboxKey(actorId, workspaceId),
    queryFn: ({ signal }) => fetchInbox(workspaceId, signal),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: false,
  });
}
