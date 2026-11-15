import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { fetchDependencyCounts } from './api';
import { useDependencyCounts } from './queries';
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
