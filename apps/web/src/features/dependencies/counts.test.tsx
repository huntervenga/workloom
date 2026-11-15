import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { fetchDependencyCounts } from './api';
import { dependencyKeys, useDependencyCounts } from './queries';
import { queryKeys } from '../../lib/queryKeys';
import { isWorkspaceLiveKey } from '../workspace/workspaceLiveQueries';
import { rootPath, taskAt } from './test/fixtures';

const countsPath = `${rootPath}/dependencies/counts`;
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });

it('sends sorted task IDs once and refuses more than 100 locally', async () => {
  const [a, b] = [taskAt(2), taskAt(1)];
  const { calls } = installFakeApi({ [`GET ${countsPath}`]: () => ok([{ taskId: b.id, waitingOn: 1, blocking: 0 }]) });
  expect(await fetchDependencyCounts(alpha.id, [a.id, b.id])).toEqual([{ taskId: b.id, waitingOn: 1, blocking: 0 }]);
  expect(calls[0]?.searchParams.get('taskIds')).toBe([a.id, b.id].sort().join(','));
  await expect(fetchDependencyCounts(alpha.id, Array.from({ length: 101 }, (_, index) => taskAt(index + 1).id))).rejects.toMatchObject({ kind: 'invalid_input' });
  expect(calls).toHaveLength(1);
});

it('splits a long list into requests of 100 and merges the answers by task', async () => {
  const tasks = Array.from({ length: 150 }, (_, index) => taskAt(index + 1));
  const { calls } = installFakeApi({ [`GET ${countsPath}`]: request => {
    const ids = request.searchParams.get('taskIds')?.split(',') ?? [];
    return ok(ids.slice(0, 1).map(taskId => ({ taskId, waitingOn: 1, blocking: 2 })));
  } });
  const client = createQueryClient({ retry: false });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useDependencyCounts(anna.id, alpha.id, tasks.map(task => task.id)), { wrapper });
  await waitFor(() => expect(result.current.size).toBe(2));
  expect(calls.map(call => call.searchParams.get('taskIds')?.split(',').length).sort()).toEqual([100, 50].sort());
});

it('keeps loaded chunks when another page of tasks arrives, and refetches after a dependency or task change', async () => {
  const first = Array.from({ length: 100 }, (_, index) => taskAt(index + 1)), more = [taskAt(101), taskAt(102)];
  let waiting = 1;
  const { calls } = installFakeApi({ [`GET ${countsPath}`]: request => {
    const ids = request.searchParams.get('taskIds')?.split(',') ?? [];
    return ok(ids.includes(first[0]?.id ?? '') ? [{ taskId: first[0]?.id, waitingOn: waiting, blocking: 0 }] : []);
  } });
  const client = createQueryClient({ retry: false });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const { result, rerender } = renderHook(({ ids }) => useDependencyCounts(anna.id, alpha.id, ids), { wrapper, initialProps: { ids: first.map(task => task.id) } });
  await waitFor(() => expect(result.current.get(first[0]?.id ?? '')?.waitingOn).toBe(1));
  expect(calls).toHaveLength(1);
  // The next page adds one request for the new tasks only.
  rerender({ ids: [...first, ...more].map(task => task.id) });
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[1]?.searchParams.get('taskIds')).toBe(more.map(task => task.id).sort().join(','));
  expect(result.current.get(first[0]?.id ?? '')?.waitingOn).toBe(1);
  // Dependency and task writes invalidate the workspace dependency root; the badges follow, and the key stays live.
  waiting = 2;
  await client.invalidateQueries({ queryKey: [...queryKeys.workspace(anna.id, alpha.id), 'dependencies'] });
  await waitFor(() => expect(result.current.get(first[0]?.id ?? '')?.waitingOn).toBe(2));
  expect(isWorkspaceLiveKey(dependencyKeys.counts(anna.id, alpha.id, [first[0]?.id ?? '']), anna.id, alpha.id)).toBe(true);
});
