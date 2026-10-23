// Real PostgreSQL + real API process: the "one project per task" rule and its copy into the next project.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { duplicateProjectResponseSchema, projectRulesResponseSchema, taskResponseSchema } from '@workloom/contracts';
import { expectEnvelope } from './support/p1a.js';
import { planningHarness, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;

describe('project rules', () => {
  beforeAll(async () => { h = await planningHarness('project_rules'); }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  async function setup() {
    const a = await h.owner.tasks.createProject(`Rules A ${randomUUID().slice(0, 6)}`);
    const b = await h.owner.tasks.createProject(`Rules B ${randomUUID().slice(0, 6)}`);
    const todo = (await h.owner.tasks.listStatuses(a.id)).find(s => s.group === 'todo');
    if (!todo) throw new Error('status');
    const task = expectEnvelope(await h.owner.post('/tasks', { projectId: a.id, title: 'Shared plan', statusId: todo.id }), 201, taskResponseSchema).data;
    return { a, b, task };
  }
  const setRule = async (projectId: string, singleProject: boolean, expectedRevision = 0) =>
    expectEnvelope(await h.owner.put(`/projects/${projectId}/rules`, { expectedRevision, config: { singleProject } }), 200, projectRulesResponseSchema).data;
  const attach = (taskId: string, projectId: string, expectedTaskRevision: number) => h.owner.post(`/tasks/${taskId}/placements`, { projectId, expectedTaskRevision });

  it('starts with every rule off, saves with a revision and refuses a stale save', async () => {
    const { a } = await setup();
    expect(expectEnvelope(await h.owner.get(`/projects/${a.id}/rules`), 200, projectRulesResponseSchema).data).toMatchObject({ revision: 0, config: { singleProject: false } });
    expect(await setRule(a.id, true)).toMatchObject({ revision: 1, config: { singleProject: true } });
    expect((await h.owner.put(`/projects/${a.id}/rules`, { expectedRevision: 0, config: { singleProject: false } })).status).toBe(409);
  });

  it('refuses to add a task to a project with the rule, and to share a task whose own project has it', async () => {
    const { a, b, task } = await setup();
    expect((await attach(task.id, b.id, task.revision)).status, 'allowed while no rule is on').toBe(201);
    const second = await setup();
    await setRule(second.b.id, true);
    const intoRuleProject = await attach(second.task.id, second.b.id, second.task.revision);
    expect(intoRuleProject.status).toBe(422);
    expect(intoRuleProject.text()).toContain('one project only');
    const third = await setup();
    await setRule(third.a.id, true);
    expect((await attach(third.task.id, third.b.id, third.task.revision)).status).toBe(422);
    void a;
  });

  it('does not touch placements that already exist when the rule is switched on', async () => {
    const { a, b, task } = await setup();
    expect((await attach(task.id, b.id, task.revision)).status).toBe(201);
    await setRule(a.id, true);
    const placements = expectEnvelope(await h.owner.get(`/tasks/${task.id}/placements`), 200, { parse: (value: unknown) => value as { data: { archivedAt: string | null }[] } }).data;
    expect(placements.filter(p => p.archivedAt === null)).toHaveLength(2);
  });

  it('copies the rule into the next copy of a project', async () => {
    const { a } = await setup();
    await setRule(a.id, true);
    const copy = expectEnvelope(await h.owner.post(`/projects/${a.id}/duplicate`, { name: `Rules copy ${randomUUID().slice(0, 6)}`, shiftDays: 0 }), 201, duplicateProjectResponseSchema).data;
    expect(expectEnvelope(await h.owner.get(`/projects/${copy.projectId}/rules`), 200, projectRulesResponseSchema).data.config.singleProject).toBe(true);
  });
});
