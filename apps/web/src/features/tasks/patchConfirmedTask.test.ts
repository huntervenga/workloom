import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { makeTask } from '../task-table/taskTableFixtures';
import { patchConfirmedTaskInLists } from './queries';
import type { TaskPage } from './api';

const ACTOR = 'actor-1';
const WS = 'ws-1';

function seeded() {
  const client = new QueryClient();
  const key = queryKeys.taskList(ACTOR, WS, 'project-1', { projectId: 'project-1', limit: 100 } as never);
  const stale = makeTask({ id: 'a', revision: 1, priority: 'none' });
  const other = makeTask({ id: 'b', revision: 4 });
  client.setQueryData<InfiniteData<TaskPage>>(key, { pages: [{ tasks: [stale, other], nextCursor: null } as unknown as TaskPage], pageParams: [null] });
  return { client, key, stale, other };
}

describe('patchConfirmedTaskInLists', () => {
  it('replaces only the confirmed task and only when it is newer', () => {
    const { client, key, other } = seeded();
    const tag = { id: 't', workspaceId: WS, name: 'T', color: null, revision: 1, archivedAt: null };
    patchConfirmedTaskInLists(client, ACTOR, WS, makeTask({ id: 'a', revision: 2, tags: [tag] }));
    const tasks = client.getQueryData<InfiniteData<TaskPage>>(key)?.pages[0]?.tasks ?? [];
    expect(tasks[0]).toMatchObject({ id: 'a', revision: 2, tags: [tag] });
    expect(tasks[1]).toBe(other);
    patchConfirmedTaskInLists(client, ACTOR, WS, makeTask({ id: 'a', revision: 1, priority: 'high' }));
    expect(client.getQueryData<InfiniteData<TaskPage>>(key)?.pages[0]?.tasks[0]).toMatchObject({ revision: 2, priority: 'none' });
  });
  it('leaves the cache object untouched when nothing is newer', () => {
    const { client, key } = seeded();
    const before = client.getQueryData(key);
    patchConfirmedTaskInLists(client, ACTOR, WS, makeTask({ id: 'zzz', revision: 9 }));
    expect(client.getQueryData(key)).toBe(before);
  });
});
