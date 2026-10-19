import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { GraphLayoutDto } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { projectUndoFor, undoScope } from '../undo/projectUndo';
import { layoutReceiptKey, newestLayout, reconcileLayoutAck } from './layoutReceiptCache';
import { useDependencyCommands } from './queries';
import { layout, PROJECT_ID, rootPath, taskAt } from './test/fixtures';

const clients: QueryClient[] = [];
function setup() {
  const client = createQueryClient({ retry: false }); clients.push(client);
  const key = layoutReceiptKey(anna.id, alpha.id, PROJECT_ID);
  client.setQueryData(key, layout());
  return { client, key };
}
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
describe('confirmed personal layout cache heads', () => {
  it('cancels an older read, preserves a newer concurrent ACK through cancellation, and rejects stale GET regression', async () => {
    const { client, key } = setup(); const stale = deferred<GraphLayoutDto>(); let signal: AbortSignal | undefined;
    const reading = client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: context => { signal = context.signal; return stale.promise; } }).catch(() => undefined);
    const newer = layout([{ taskId: taskAt(1).id, x: 33, y: 55 }], 3);
    client.setQueryData(key, newer);
    await reconcileLayoutAck(client, anna.id, alpha.id, PROJECT_ID, layout([], 2));
    expect(signal?.aborted).toBe(true); expect(client.getQueryData(key)).toEqual(newer);
    stale.resolve(layout()); await reading; expect(client.getQueryData(key)).toEqual(newer);
    expect(newestLayout(newer, layout([], 1))).toEqual(newer);
  });
  it('isolates actor/workspace/project/personal membership identities and never recreates removed actor scopes', async () => {
    const { client, key } = setup(); const original = layout();
    const otherActorKey = layoutReceiptKey(taskAt(9).id, alpha.id, PROJECT_ID);
    client.setQueryData(otherActorKey, original);
    await reconcileLayoutAck(client, anna.id, alpha.id, PROJECT_ID, { ...layout([], 1), workspaceId: taskAt(9).id });
    await reconcileLayoutAck(client, anna.id, alpha.id, PROJECT_ID, { ...layout([], 1), projectId: taskAt(9).id });
    await reconcileLayoutAck(client, anna.id, alpha.id, PROJECT_ID, { ...layout([], 1), membershipId: taskAt(9).id });
    expect(client.getQueryData(key)).toEqual(original); expect(client.getQueryData(otherActorKey)).toEqual(original);
    const barrier = deferred<undefined>(); vi.spyOn(client, 'cancelQueries').mockImplementation(() => barrier.promise);
    const updating = reconcileLayoutAck(client, anna.id, alpha.id, PROJECT_ID, layout([], 1));
    client.removeQueries({ queryKey: queryKeys.actor(anna.id) }); barrier.resolve(undefined); await updating;
    expect(client.getQueryState(key)).toBeUndefined(); expect(client.getQueryData(otherActorKey)).toEqual(original);
  });
  it('keeps two rapid confirmed saves independently undoable while their authoritative GETs remain pending', async () => {
    const { client, key } = setup(); client.setQueryData(queryKeys.me, { actor: { id: anna.id } });
    const store = projectUndoFor(client); store.activate(undoScope(anna.id, alpha.id, PROJECT_ID), true);
    const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const positions = [[], [{ taskId: taskAt(1).id, x: 40, y: 70 }], [{ taskId: taskAt(1).id, x: 90, y: 110 }]];
    let writes = 0;
    const { calls } = installFakeApi({ [`PUT ${rootPath}/projects/${PROJECT_ID}/graph-layout`]: request => {
      const body = request.body as { expectedRevision: number; positions: GraphLayoutDto['positions'] };
      expect(body.expectedRevision).toBe(writes); writes += 1;
      return ok(layout(body.positions, writes));
    } });
    const view = renderHook(() => useDependencyCommands(anna.id, alpha.id, PROJECT_ID), { wrapper: Wrapper });
    try {
      for (const revision of [0, 1]) {
        const stale = deferred<GraphLayoutDto>(); let signal: AbortSignal | undefined;
        const reading = client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: context => { signal = context.signal; return stale.promise; } }).catch(() => undefined);
        await act(async () => { await view.result.current.layout.mutateAsync({ input: { expectedRevision: revision, positions: positions[revision + 1] ?? [] } }); });
        expect(signal?.aborted).toBe(true); expect(client.getQueryData<GraphLayoutDto>(key)?.revision).toBe(revision + 1);
        expect(store.getSnapshot().count).toBe(revision + 1);
        stale.resolve(layout([], revision)); await reading;
      }
      await act(async () => { await store.undo(); });
      expect(client.getQueryData<GraphLayoutDto>(key)).toEqual(layout(positions[1], 3));
      await act(async () => { await store.undo(); });
      expect(client.getQueryData<GraphLayoutDto>(key)).toEqual(layout([], 4));
      expect(store.getSnapshot()).toMatchObject({ count: 0, notice: 'done' });
      expect(calls.map(call => (call.body as { positions: unknown }).positions)).toEqual([positions[1], positions[2], positions[1], []]);
    } finally { view.unmount(); }
  });
});
