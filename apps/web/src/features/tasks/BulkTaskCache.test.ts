import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna } from '../../test/fakeApi';
import { makeTag } from '../task-table/taskTableFixtures';
import { task } from '../planning/test/fixtures';
import { storeConfirmedTasks } from './queries';

describe('atomic bulk confirmation cache', () => {
  it('stores three confirmed details with one invalidation each for list, reports, schedule and dependencies', async () => {
    const client = new QueryClient();
    const rows = [1, 2, 3].map(index => ({ ...task, id: `task-${index}`, revision: 2 }));
    for (const row of rows) client.setQueryData(queryKeys.task(anna.id, alpha.id, row.id), { ...row, revision: 1 });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await storeConfirmedTasks(client, anna.id, alpha.id, rows);
    expect(invalidate).toHaveBeenCalledTimes(4);
    const workspace = queryKeys.workspace(anna.id, alpha.id);
    for (const queryKey of [queryKeys.tasks(anna.id, alpha.id), [...workspace, 'generic-reports'], [...workspace, 'schedule'], [...workspace, 'dependencies']]) {
      expect(invalidate.mock.calls.filter(([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(queryKey))).toHaveLength(1);
    }
    const listCall = invalidate.mock.calls.find(([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(queryKeys.tasks(anna.id, alpha.id)));
    expect(listCall).toBeDefined();
    for (const row of rows) expect(client.getQueryData(queryKeys.task(anna.id, alpha.id, row.id))).toEqual(row);
    client.clear();
  });
  it('preserves newer task and independently versioned tag details while invalidating those exact reads', async () => {
    const client = new QueryClient(); const key = queryKeys.task(anna.id, alpha.id, task.id);
    const newerTag = makeTag({ id: 'tag', name: 'Renamed', revision: 3 });
    const cached = { ...task, tags: [newerTag] };
    client.setQueryData(key, cached);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await storeConfirmedTasks(client, anna.id, alpha.id, [{ ...task, revision: 2, tags: [{ ...newerTag, name: 'Old', revision: 1 }] }]);
    expect(client.getQueryData(key)).toEqual(cached);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key, exact: true });
    client.setQueryData(key, { ...task, revision: 5 });
    await storeConfirmedTasks(client, anna.id, alpha.id, [{ ...task, revision: 2 }]);
    expect(client.getQueryData(key)).toEqual({ ...task, revision: 5 });
    client.clear();
  });
});
