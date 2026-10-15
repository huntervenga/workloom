import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';

/**
 * Cancels and forgets everything loaded for a workspace the user has left, and
 * every recorded write. Writes are not keyed by workspace, so all of them go;
 * a late answer to one only updates entries that are still cached.
 */
export async function discardWorkspaceData(queryClient: QueryClient, actorId: string, workspaceId: string): Promise<void> {
  const scope = queryKeys.workspace(actorId, workspaceId);
  const cancelled = queryClient.cancelQueries({ queryKey: scope });
  queryClient.removeQueries({ queryKey: scope });
  queryClient.getMutationCache().clear();
  await cancelled;
}
