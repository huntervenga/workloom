// Real PostgreSQL + real API process: deleting a parent takes its subtasks along, and restoring brings back exactly them.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskResponseSchema } from '@workloom/contracts';
import { expectEnvelope } from './support/p1a.js';
import { planningHarness, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;

describe('archiving a task with subtasks', () => {
  beforeAll(async () => { h = await planningHarness('task_archive_cascade'); }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  async function tree() {
    const project = await h.owner.tasks.createProject(`Cascade ${randomUUID().slice(0, 6)}`);
    const todo = (await h.owner.tasks.listStatuses(project.id)).find(s => s.group === 'todo');
    if (!todo) throw new Error('status');
    const make = async (title: string, parentTaskId?: string) => expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title, statusId: todo.id, ...(parentTaskId ? { parentTaskId } : {}) }), 201, taskResponseSchema).data;
    const parent = await make('Parent');
    const child = await make('Child', parent.id);
    const grandchild = await make('Grandchild', child.id);
    const other = await make('Other child', parent.id);
    return { parent, child, grandchild, other };
  }
  const get = async (id: string) => expectEnvelope(await h.owner.get(`/tasks/${id}`), 200, taskResponseSchema).data;

  it('archives every active descendant with the parent and restores exactly those with it', async () => {
    const { parent, child, grandchild, other } = await tree();
    // One child was deleted on its own earlier and must stay deleted when the parent comes back.
    await h.owner.tasks.archiveTask(other.id, other.revision);
    await h.owner.tasks.archiveTask(parent.id, parent.revision);
    for (const task of [parent, child, grandchild]) expect((await get(task.id)).archivedAt).not.toBeNull();
    const archivedParent = await get(parent.id);
    expect((await get(child.id)).archivedAt).toBe(archivedParent.archivedAt);
    await h.owner.tasks.restoreTask(parent.id, archivedParent.revision);
    for (const task of [parent, child, grandchild]) expect((await get(task.id)).archivedAt).toBeNull();
    expect((await get(other.id)).archivedAt).not.toBeNull();
  });

  it('refuses to restore a subtask while its parent is deleted', async () => {
    const { parent, child } = await tree();
    const archivedChild = await h.owner.tasks.archiveTask(child.id, child.revision);
    await h.owner.tasks.archiveTask(parent.id, parent.revision);
    const refused = await h.owner.post(`/tasks/${child.id}/restore`, { expectedRevision: archivedChild.revision });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await get(child.id)).archivedAt).not.toBeNull();
  });
});
