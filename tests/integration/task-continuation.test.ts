// Real PostgreSQL + real API process: close a task and continue it in another project.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { continueTaskResponseSchema, taskResponseSchema, taskDefaultsResponseSchema } from '@workloom/contracts';
import { expectEnvelope } from './support/p1a.js';
import { planningHarness, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;

describe('close and continue in another project', () => {
  beforeAll(async () => { h = await planningHarness('task_continuation'); }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  async function setup() {
    const weekOne = await h.owner.tasks.createProject(`Week 1 ${randomUUID().slice(0, 6)}`);
    const weekTwo = await h.owner.tasks.createProject(`Week 2 ${randomUUID().slice(0, 6)}`);
    const todo = (await h.owner.tasks.listStatuses(weekOne.id)).find(s => s.group === 'todo');
    if (!todo) throw new Error('status');
    const task = expectEnvelope(await h.owner.post('/tasks', { projectId: weekOne.id, title: 'Rework billing', statusId: todo.id, responsibleMembershipId: '5eed0000-0000-4000-8000-000000000301', dueDate: '2026-01-10', priority: 'high' }), 201, taskResponseSchema).data;
    return { weekOne, weekTwo, task };
  }
  const post = (taskId: string, body: unknown, key?: string) => h.owner.post(`/tasks/${taskId}/continue`, body, key);

  it('completes the task, starts "title 2" in the chosen project with its defaults, and blocks it by the finished one', async () => {
    const { weekTwo, task } = await setup();
    const put = expectEnvelope(await h.owner.put(`/projects/${weekTwo.id}/task-defaults`, { expectedRevision: 0, config: { statusId: null, priority: 'low', estimateMinutes: 60, fieldValues: [] } }), 200, taskDefaultsResponseSchema);
    expect(put.data.revision).toBe(1);
    const result = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id }), 201, continueTaskResponseSchema).data;
    expect(result.closed).toMatchObject({ id: task.id });
    const statuses = await h.owner.tasks.listStatuses(task.projectId);
    expect(statuses.find(s => s.id === result.closed.statusId)?.group).toBe('done');
    expect(result.continued).toMatchObject({ title: 'Rework billing 2', projectId: weekTwo.id, priority: 'low', estimateMinutes: 60, dueDate: null, responsibleMembershipId: task.responsibleMembershipId });
    const dependencies = (await h.db.sql`select predecessor_task_id, successor_task_id, state from task_dependencies where id = ${result.dependencyId}`)[0];
    expect(dependencies).toMatchObject({ predecessor_task_id: task.id, successor_task_id: result.continued.id });
  });

  it('numbers a chain: a second continuation becomes "title 3"', async () => {
    const { weekTwo, task } = await setup();
    const second = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id }), 201, continueTaskResponseSchema).data;
    const third = expectEnvelope(await post(second.continued.id, { targetProjectId: weekTwo.id }), 201, continueTaskResponseSchema).data;
    expect(third.continued.title).toBe('Rework billing 3');
  });

  it('is safe to repeat with the same key and never creates a second continuation', async () => {
    const { weekTwo, task } = await setup();
    const key = randomUUID();
    const first = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id }, key), 201, continueTaskResponseSchema).data;
    const again = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id }, key), 201, continueTaskResponseSchema).data;
    expect(again.continued.id).toBe(first.continued.id);
    expect(again.dependencyId).toBe(first.dependencyId);
    const rows = await h.db.sql`select count(*)::int as n from tasks where title = 'Rework billing 2' and project_id = ${weekTwo.id}`;
    expect(rows[0]?.n).toBe(1);
  });

  it('refuses a viewer, an unknown project and a cancelled task without creating anything', async () => {
    const { weekTwo, task } = await setup();
    const before = (await h.db.sql`select count(*)::int as n from tasks`)[0]?.n;
    expect((await h.viewer.post(`/tasks/${task.id}/continue`, { targetProjectId: weekTwo.id })).status).toBe(403);
    expect((await post(task.id, { targetProjectId: randomUUID() })).status).toBeGreaterThanOrEqual(400);
    const cancelled = (await h.owner.tasks.listStatuses(task.projectId)).find(s => s.group === 'cancelled');
    if (cancelled) {
      await h.owner.patch(`/tasks/${task.id}`, { expectedRevision: task.revision, statusId: cancelled.id });
      expect((await post(task.id, { targetProjectId: weekTwo.id })).status).toBe(422);
    }
    const after = (await h.db.sql`select count(*)::int as n from tasks`)[0]?.n;
    expect(after).toBe(before);
  });
});
