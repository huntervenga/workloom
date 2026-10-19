import { subscribeMutationAcknowledgements } from '../../lib/mutationAcknowledgements';
import type { QueryClient } from '@tanstack/react-query';
import { createIdempotencyKey } from '../../lib/idempotency';
import { isUncertainOutcome } from '../../lib/api';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import { UndoStore } from './UndoStore';
const stores = new WeakMap<QueryClient, UndoStore>();
export const undoScope = (actorId: string, workspaceId: string, projectId: string) => [actorId, workspaceId, projectId].map(id => id.toLowerCase()).join('/');
export function projectUndoFor(client: QueryClient): UndoStore {
  const known = stores.get(client); if (known) return known;
  const registry = protectedCommandsFor(client);
  let slot = registry.register();
  const store = new UndoStore({
    blocked: () => slot.hasOthers() || protectedDraftsFor(client).protecting,
    protect: active => slot.set(active), uncertain: isUncertainOutcome, key: createIdempotencyKey,
  });
  stores.set(client, store);
  subscribeMutationAcknowledgements(client, ack => {
    const workspace = /^\/api\/v1\/workspaces\/([^/]+)(?:\/|$)/.exec(ack.path)?.[1];
    if (workspace && /^[0-9a-f-]{36}$/i.test(workspace)) store.acknowledge(ack.receipt, workspace, ack.actorId, ack.observerFailed);
  });
  // Auth invalidation also drops old-actor closures before a new project mounts.
  let actor = (client.getQueryData(queryKeys.me) as { actor?: { id?: string } } | undefined)?.actor?.id;
  client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated' || event.query.queryKey[0] !== 'me') return;
    const next = (event.query.state.data as { actor?: { id?: string } } | undefined)?.actor?.id;
    if (next !== actor) { store.activate(null, false); slot.dispose(); slot = registry.register(); slot.set(store.hasOutstanding); actor = next; }
  });
  return store;
}
