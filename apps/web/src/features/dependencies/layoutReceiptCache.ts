import type { QueryClient } from '@tanstack/react-query';
import type { GraphLayoutDto } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';

export const layoutReceiptKey = (actor: string, workspace: string, project: string) => [...queryKeys.workspace(actor, workspace), 'dependencies', 'layout', project.toLowerCase()] as const;
export function sameLayoutIdentity(a: GraphLayoutDto, b: GraphLayoutDto): boolean {
  return a.workspaceId === b.workspaceId && a.projectId === b.projectId && a.membershipId === b.membershipId && a.viewKey === b.viewKey;
}
/** Only compare revisions inside the same independent personal-layout identity. */
export function newestLayout(cached: GraphLayoutDto | undefined, incoming: GraphLayoutDto): GraphLayoutDto {
  return cached && sameLayoutIdentity(cached, incoming) && cached.revision >= incoming.revision ? cached : incoming;
}
/** Cancel the older read before installing an exact persisted ACK; never recreate a departed actor scope. */
export async function reconcileLayoutAck(client: QueryClient, actor: string, workspace: string, project: string, incoming: GraphLayoutDto): Promise<void> {
  if (incoming.workspaceId !== workspace || incoming.projectId !== project) return;
  const queryKey = layoutReceiptKey(actor, workspace, project);
  const query = client.getQueryCache().find({ queryKey, exact: true });
  const snapshot = query?.state.data as GraphLayoutDto | undefined;
  if (!query || !snapshot || !sameLayoutIdentity(snapshot, incoming)) return;
  await client.cancelQueries({ queryKey, exact: true });
  if (client.getQueryCache().find({ queryKey, exact: true }) !== query) return;
  const current = client.getQueryData<GraphLayoutDto>(queryKey);
  if (current && !sameLayoutIdentity(current, incoming)) return;
  // Cancellation can revert an even newer ACK to its fetch-start snapshot.
  client.setQueryData(queryKey, newestLayout(newestLayout(current, snapshot), incoming));
}
