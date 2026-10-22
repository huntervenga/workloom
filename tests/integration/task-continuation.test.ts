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
    expect(result.continued).toMatchObject({ title: 'Rework billing 2', projectId: weekTwo.id, priority: 'high', estimateMinutes: 60, dueDate: null, responsibleMembershipId: task.responsibleMembershipId });
    const dependencies = (await h.db.sql`select predecessor_task_id, successor_task_id, state from task_dependencies where id = ${result.dependencyId}`)[0];
    expect(dependencies).toMatchObject({ predecessor_task_id: task.id, successor_task_id: result.continued.id });
  });

  it('carries priority, tags and the section by name — not by id — into a project that has a same-named section', async () => {
    const { weekOne, weekTwo, task } = await setup();
    const mine = (await h.owner.tasks.createSection(weekOne.id, { name: 'Mark' }));
    await h.owner.tasks.createSection(weekOne.id, { name: 'Other' });
    const markTwo = await h.owner.tasks.createSection(weekTwo.id, { name: ' mark ' });
    const tag = await h.owner.tasks.createTag({ name: `ops-${randomUUID().slice(0, 6)}` });
    const sectioned = expectEnvelope(await h.owner.patch(`/tasks/${task.id}`, { expectedRevision: task.revision, sectionId: mine.id, tagIds: [tag.id] }), 200, taskResponseSchema).data;
    const result = expectEnvelope(await post(sectioned.id, { targetProjectId: weekTwo.id }), 201, continueTaskResponseSchema).data;
    expect(result.continued).toMatchObject({ sectionId: markTwo.id, priority: 'high' });
    expect(result.continued.tags.map(t => t.id)).toEqual([tag.id]);
    expect(result.continued.sectionId).not.toBe(mine.id);
    // No same-named section there: the task simply has no section.
    const alone = await h.owner.tasks.createProject(`Week 3 ${randomUUID().slice(0, 6)}`);
    const second = expectEnvelope(await post(result.continued.id, { targetProjectId: alone.id }), 201, continueTaskResponseSchema).data;
    expect(second.continued.sectionId).toBeNull();
  });

  it('carries a choice field such as a custom Priority by field and option name, and leaves hours to the new project', async () => {
    const { weekOne, weekTwo, task } = await setup();
    const options = [{ name: 'P1' }, { name: 'P2' }];
    const from = await h.owner.createField({ projectId: weekOne.id, name: 'Priority', type: 'single_select', options });
    const to = await h.owner.createField({ projectId: weekTwo.id, name: ' priority ', type: 'single_select', options });
    const hoursFrom = await h.owner.createField({ projectId: weekOne.id, name: 'Hours Est', type: 'duration' });
    await h.owner.createField({ projectId: weekTwo.id, name: 'Hours Est', type: 'duration' });
    const pick = (field: typeof from, name: string) => field.options.find(o => o.name === name)?.id ?? null;
    await h.owner.setValue(task.id, from.id, { expectedRevision: 0, expectedDefinitionRevision: from.revision, value: { type: 'single_select', value: pick(from, 'P2') } });
    await h.owner.setValue(task.id, hoursFrom.id, { expectedRevision: 0, expectedDefinitionRevision: hoursFrom.revision, value: { type: 'duration', value: 120 } });
    const result = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id }), 201, continueTaskResponseSchema).data;
    const values = await h.owner.listTaskValues(result.continued.id);
    expect(values.map(v => JSON.stringify(v.value))).toEqual([JSON.stringify({ type: 'single_select', value: pick(to, 'P2') })]);
    // Only when asked: the duration field is copied as it is, matched by name and type.
    const second = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id, carryFieldIds: [hoursFrom.id] }, `copy-${randomUUID()}`), 201, continueTaskResponseSchema).data;
    expect((await h.owner.listTaskValues(second.continued.id)).map(v => JSON.stringify(v.value)).sort()).toEqual([JSON.stringify({ type: 'duration', value: 120 }), JSON.stringify({ type: 'single_select', value: pick(to, 'P2') })].sort());
  });

  it('leaves the old task open when the chosen project refuses the new one, and finishes on a later retry', async () => {
    const { weekOne, weekTwo, task } = await setup();
    await h.db.sql`update projects set archived_at = now() where id = ${weekTwo.id}`;
    const key = `refuse-${randomUUID()}`;
    const refused = await post(task.id, { targetProjectId: weekTwo.id }, key);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const after = expectEnvelope(await h.owner.get(`/tasks/${task.id}`), 200, taskResponseSchema).data;
    expect((await h.owner.tasks.listStatuses(weekOne.id)).find(s => s.id === after.statusId)?.group).not.toBe('done');
    await h.db.sql`update projects set archived_at = null where id = ${weekTwo.id}`;
    const retried = expectEnvelope(await post(task.id, { targetProjectId: weekTwo.id }, key), 201, continueTaskResponseSchema).data;
    expect((await h.owner.tasks.listStatuses(weekOne.id)).find(s => s.id === retried.closed.statusId)?.group).toBe('done');
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
