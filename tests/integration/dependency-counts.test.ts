// Dependency counts for list badges over real HTTP and an isolated PostgreSQL database.
// Waiting-on mirrors the blocking summary (only a done predecessor resolves it); blocking needs both ends unfinished.
import { dependencyCountsResponseSchema } from '@workloom/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectEnvelope, uniqueName } from './support/p1a.js';
import { databaseSnapshot } from './support/p1b.js';
import { planningHarness, planningProject, planningTask, type PlanningHarness } from './support/p2a-fixture.js';
import { p4aClients, type P4aClient } from './support/p4a.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;
let owner: P4aClient, viewer: P4aClient, outsider: P4aClient;

const path = (ids: readonly string[]) => `/dependencies/counts?taskIds=${ids.join(',')}`;
async function counts(client: P4aClient, ids: readonly string[]) {
  return expectEnvelope(await client.get(path(ids)), 200, dependencyCountsResponseSchema).data;
}
const byTask = (rows: readonly { taskId: string; waitingOn: number; blocking: number }[]) =>
  Object.fromEntries(rows.map(row => [row.taskId, { waitingOn: row.waitingOn, blocking: row.blocking }]));

describe('dependency counts for list badges', () => {
  beforeAll(async () => { h = await planningHarness('dependency_counts'); ({ owner, viewer, outsider } = p4aClients(h)); }, 60_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  it('counts unfinished predecessors and successors, across projects, and follows status and edge changes', async () => {
    const f = await planningProject(owner, 'Значки зависимостей');
    const [a, b, c, d] = await Promise.all(['A', 'B', 'C', 'D'].map(name => planningTask(owner, f.project, 60, uniqueName(`Значок ${name}`))));
    const other = await planningProject(owner, 'Другой проект');
    const x = await planningTask(owner, other.project, 60, uniqueName('Внешний предшественник'));
    if (!a || !b || !c || !d) throw new Error('Four tasks required.');
    await owner.createEdge(a.id, b.id);
    await owner.createEdge(a.id, c.id);
    const cd = await owner.createEdge(c.id, d.id);
    await owner.createEdge(x.id, b.id);
    const ids = [a.id, b.id, c.id, d.id];

    const before = await databaseSnapshot(h.db.sql);
    expect(byTask(await counts(owner, ids))).toEqual({
      [a.id]: { waitingOn: 0, blocking: 2 },
      [b.id]: { waitingOn: 2, blocking: 0 },
      [c.id]: { waitingOn: 1, blocking: 1 },
      [d.id]: { waitingOn: 1, blocking: 0 },
    });
    // A read changes nothing; a viewer may read; the answer is sorted by task ID and leaves out tasks without links.
    expect(await databaseSnapshot(h.db.sql)).toEqual(before);
    expect(byTask(await counts(viewer, [x.id]))).toEqual({ [x.id]: { waitingOn: 0, blocking: 1 } });
    expect((await counts(owner, [...ids].reverse())).map(row => row.taskId)).toEqual([...ids].sort());

    // A done predecessor resolves its successors and blocks nothing.
    await owner.tasks.updateTask(a.id, { expectedRevision: a.revision, statusId: f.done.id });
    expect(byTask(await counts(owner, ids))).toEqual({
      [b.id]: { waitingOn: 1, blocking: 0 },
      [c.id]: { waitingOn: 0, blocking: 1 },
      [d.id]: { waitingOn: 1, blocking: 0 },
    });
    // A removed edge no longer counts on either side.
    await owner.setEdge(cd, 'removed');
    expect(byTask(await counts(owner, ids))).toEqual({ [b.id]: { waitingOn: 1, blocking: 0 } });
    // A done successor is no longer held up, so its predecessor stops blocking.
    const currentB = await owner.tasks.getTask(b.id);
    await owner.tasks.updateTask(b.id, { expectedRevision: currentB.revision, statusId: f.done.id });
    expect(byTask(await counts(owner, [x.id, b.id]))).toEqual({ [b.id]: { waitingOn: 1, blocking: 0 } });
  });

  it('keeps counts inside each workspace', async () => {
    const mine = await planningProject(owner, 'Своё пространство');
    const [a, b] = await Promise.all(['A', 'B'].map(name => planningTask(owner, mine.project, 60, uniqueName(`Своя связь ${name}`))));
    const foreign = await planningProject(outsider, 'Чужое пространство');
    const [p, q] = await Promise.all(['P', 'Q'].map(name => planningTask(outsider, foreign.project, 60, uniqueName(`Чужая связь ${name}`))));
    if (!a || !b || !p || !q) throw new Error('Four tasks required.');
    await owner.createEdge(a.id, b.id);
    await outsider.createEdge(p.id, q.id);
    expect(await counts(owner, [p.id, q.id])).toEqual([]);
    expect(await counts(outsider, [a.id, b.id])).toEqual([]);
    expect(byTask(await counts(outsider, [p.id, q.id]))).toEqual({ [p.id]: { waitingOn: 0, blocking: 1 }, [q.id]: { waitingOn: 1, blocking: 0 } });
  });
});
