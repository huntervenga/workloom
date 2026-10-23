// Real PostgreSQL + real API process: per-project starting values for new tasks.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { taskDefaultsResponseSchema, taskResponseSchema, taskRowResponseSchema, taskFieldValueListResponseSchema } from '@workloom/contracts';
import { expectEnvelope } from './support/p1a.js';
import { MEMBERS, planningHarness, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;

describe('project task defaults', () => {
  beforeAll(async () => { h = await planningHarness('task_defaults'); }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  async function setup() {
    const project = await h.owner.tasks.createProject(`Defaults ${Date.now()}`);
    const statuses = await h.owner.tasks.listStatuses(project.id);
    const todo = statuses.find(s => s.group === 'todo');
    if (!todo) throw new Error('no todo status');
    const est = await h.owner.createField({ projectId: project.id, name: 'Hours Est', type: 'duration' });
    const fact = await h.owner.createField({ projectId: project.id, name: 'Hours Fact', type: 'duration' });
    const stage = await h.owner.createField({ projectId: project.id, name: 'Stage', type: 'single_select', options: [{ name: 'Plan' }, { name: 'Build' }] });
    return { project, todo, est, fact, stage };
  }
  const put = (projectId: string, body: unknown) => h.owner.put(`/projects/${projectId}/task-defaults`, body);

  it('starts empty, saves with a revision and rejects stale or invalid input', async () => {
    const { project, todo, est, stage } = await setup();
    const empty = expectEnvelope(await h.owner.get(`/projects/${project.id}/task-defaults`), 200, taskDefaultsResponseSchema).data;
    expect(empty).toMatchObject({ revision: 0, config: { statusId: null, priority: null, estimateMinutes: null, fieldValues: [] } });
    const config = { statusId: todo.id, priority: 'medium', estimateMinutes: 60, fieldValues: [{ fieldId: est.id, value: { type: 'duration', value: 60 } }] };
    const saved = expectEnvelope(await put(project.id, { expectedRevision: 0, config }), 200, taskDefaultsResponseSchema).data;
    expect(saved.revision).toBe(1);
    expect((await put(project.id, { expectedRevision: 0, config })).status).toBe(409);
    const wrongType = await put(project.id, { expectedRevision: 1, config: { ...config, fieldValues: [{ fieldId: est.id, value: { type: 'number', value: 1 } }] } });
    expect(wrongType.status).toBe(422);
    const foreignOption = await put(project.id, { expectedRevision: 1, config: { ...config, fieldValues: [{ fieldId: stage.id, value: { type: 'single_select', value: '5eed0000-0000-4000-8000-0000000009aa' } }] } });
    expect(foreignOption.status).toBe(422);
    const member = await h.member.put(`/projects/${project.id}/task-defaults`, { expectedRevision: 1, config });
    expect(member.status).toBe(403);
    expect(expectEnvelope(await h.member.get(`/projects/${project.id}/task-defaults`), 200, taskDefaultsResponseSchema).data.revision).toBe(1);
  });

  it('fills priority, estimate and field defaults on a plain task and lets explicit values win', async () => {
    const { project, todo, est, fact, stage } = await setup();
    const build = stage.options.find(o => o.name === 'Build');
    const config = { statusId: null, priority: 'high', estimateMinutes: 90, fieldValues: [
      { fieldId: est.id, value: { type: 'duration', value: 60 } },
      { fieldId: stage.id, value: { type: 'single_select', value: build?.id } },
    ] };
    expectEnvelope(await put(project.id, { expectedRevision: 0, config }), 200, taskDefaultsResponseSchema);

    const plain = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'Plain', statusId: todo.id }), 201, taskResponseSchema).data;
    expect(plain).toMatchObject({ priority: 'high', estimateMinutes: 90 });
    const values = await h.owner.listTaskValues(plain.id);
    expect(values.map(v => [v.fieldId, JSON.stringify(v.value)]).sort()).toEqual([[est.id, JSON.stringify({ type: 'duration', value: 60 })], [stage.id, JSON.stringify({ type: 'single_select', value: build?.id })]].sort());
    expect(values.some(v => v.fieldId === fact.id)).toBe(false);

    const explicit = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'Explicit', statusId: todo.id, priority: 'low', estimateMinutes: 15 }), 201, taskResponseSchema).data;
    expect(explicit).toMatchObject({ priority: 'low', estimateMinutes: 15 });

    const child = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'Detail child', statusId: todo.id, parentTaskId: plain.id }), 201, taskResponseSchema).data;
    expect(child.estimateMinutes).toBe(90);
    expect(child.priority).toBe('high');
  });

  it('applies to table-row creation too, without overriding a typed field value', async () => {
    const { project, todo, est } = await setup();
    expectEnvelope(await put(project.id, { expectedRevision: 0, config: { statusId: null, priority: 'urgent', estimateMinutes: null, fieldValues: [{ fieldId: est.id, value: { type: 'duration', value: 60 } }] } }), 200, taskDefaultsResponseSchema);
    const row = expectEnvelope(await h.owner.post('/tasks/rows', { task: { projectId: project.id, title: 'Row', statusId: todo.id } }), 201, taskRowResponseSchema).data;
    expect(row.task.priority).toBe('urgent');
    expect(row.fields.map(f => JSON.stringify(f.value))).toEqual([JSON.stringify({ type: 'duration', value: 60 })]);
    const typed = expectEnvelope(await h.owner.post('/tasks/rows', { task: { projectId: project.id, title: 'Typed', statusId: todo.id }, fields: [{ fieldId: est.id, expectedDefinitionRevision: est.revision, value: { type: 'duration', value: 5 } }] }), 201, taskRowResponseSchema).data;
    expect(typed.fields.map(f => JSON.stringify(f.value))).toEqual([JSON.stringify({ type: 'duration', value: 5 })]);
    const listed = expectEnvelope(await h.owner.get(`/tasks/${typed.task.id}/field-values`), 200, taskFieldValueListResponseSchema).data;
    expect(listed).toHaveLength(1);
  });

  it('silently skips a default that became unusable instead of blocking the task', async () => {
    const { project, todo, est, fact } = await setup();
    expectEnvelope(await put(project.id, { expectedRevision: 0, config: { statusId: null, priority: null, estimateMinutes: null, fieldValues: [{ fieldId: est.id, value: { type: 'duration', value: 60 } }, { fieldId: fact.id, value: { type: 'duration', value: 1 } }] } }), 200, taskDefaultsResponseSchema);
    await h.owner.updateField(est.id, { expectedRevision: est.revision, locked: true });
    const created = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'After lock', statusId: todo.id }), 201, taskResponseSchema).data;
    const values = await h.owner.listTaskValues(created.id);
    expect(values.map(v => v.fieldId)).toEqual([fact.id]);
  });

  it('takes assignee, tags, priority, estimate and chosen fields from the task above, and sets dates to today', async () => {
    const { project, todo, est } = await setup();
    const review = await h.owner.createField({ projectId: project.id, name: 'Review by', type: 'date' });
    const tag = await h.owner.tasks.createTag({ name: `Above ${Date.now()}` });
    const person = MEMBERS.teamOwner;
    const config = { statusId: null, priority: 'low', estimateMinutes: 30, assignee: { kind: 'above' }, tags: { kind: 'above' }, dueDate: { kind: 'today', offsetDays: 2 },
      fromAbove: { priority: true, estimate: true, fieldIds: [est.id] }, todayFields: [{ fieldId: review.id, offsetDays: 0 }], fieldValues: [] };
    expectEnvelope(await put(project.id, { expectedRevision: 0, config }), 200, taskDefaultsResponseSchema);
    const first = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'First', statusId: todo.id, responsibleMembershipId: person, tagIds: [tag.id], priority: 'urgent', estimateMinutes: 120, dueDate: '2030-01-01' }), 201, taskResponseSchema).data;
    await h.owner.setValue(first.id, est.id, { expectedRevision: 0, expectedDefinitionRevision: est.revision, value: { type: 'duration', value: 45 } });
    const second = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'Second', statusId: todo.id }), 201, taskResponseSchema).data;
    expect(second).toMatchObject({ responsibleMembershipId: person, priority: 'urgent', estimateMinutes: 120 });
    expect(second.tags.map(t => t.id)).toEqual([tag.id]);
    const today = new Date(); today.setUTCDate(today.getUTCDate() + 2);
    expect(Math.abs(Date.parse(`${second.dueDate}T00:00:00Z`) - Date.parse(`${today.toISOString().slice(0, 10)}T00:00:00Z`))).toBeLessThanOrEqual(2 * 86_400_000);
    const values = await h.owner.listTaskValues(second.id);
    expect(values.find(v => v.fieldId === est.id)?.value).toEqual({ type: 'duration', value: 45 });
    expect(values.find(v => v.fieldId === review.id)?.value).toMatchObject({ type: 'date' });
    // An explicit value always wins over the rule.
    const explicit = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'Explicit', statusId: todo.id, responsibleMembershipId: null, priority: 'high' }), 201, taskResponseSchema).data;
    expect(explicit).toMatchObject({ responsibleMembershipId: null, priority: 'high' });
  });
});
