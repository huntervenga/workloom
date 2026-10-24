// Real PostgreSQL + real API process: permanent delete of a task and of a whole project.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeResponseSchema, taskResponseSchema } from '@workloom/contracts';
import { expectEnvelope } from './support/p1a.js';
import { planningHarness, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;

describe('permanent delete', () => {
  beforeAll(async () => { h = await planningHarness('purge'); }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  async function setup() {
    const project = await h.owner.tasks.createProject(`Purge ${randomUUID().slice(0, 6)}`);
    const keep = await h.owner.tasks.createProject(`Keep ${randomUUID().slice(0, 6)}`);
    const todo = (await h.owner.tasks.listStatuses(project.id)).find(s => s.group === 'todo');
    const keepTodo = (await h.owner.tasks.listStatuses(keep.id)).find(s => s.group === 'todo');
    if (!todo || !keepTodo) throw new Error('status');
    const make = async (projectId: string, statusId: string, title: string, parentTaskId?: string) =>
      expectEnvelope(await h.owner.post('/tasks', { projectId, title, statusId, ...(parentTaskId ? { parentTaskId } : {}) }), 201, taskResponseSchema).data;
    return { project, keep, make: (title: string, parentTaskId?: string) => make(project.id, todo.id, title, parentTaskId), makeKept: (title: string) => make(keep.id, keepTodo.id, title) };
  }

  it('removes a task with its subtasks and leaves siblings alone', async () => {
    const { make } = await setup();
    const parent = await make('Parent'), child = await make('Child', parent.id), sibling = await make('Sibling');
    expect((await h.owner.post(`/tasks/${parent.id}/purge`, { confirmTitle: 'wrong' })).status).toBe(400);
    const done = expectEnvelope(await h.owner.post(`/tasks/${parent.id}/purge`, { confirmTitle: 'Parent' }), 200, purgeResponseSchema).data;
    expect(done.deleted['tasks']).toBe(2);
    expect((await h.owner.get(`/tasks/${parent.id}`)).status).toBe(404);
    expect((await h.owner.get(`/tasks/${child.id}`)).status).toBe(404);
    expect((await h.owner.get(`/tasks/${sibling.id}`)).status).toBe(200);
  });

  it('removes a project with its tasks, keeps other projects and records the purge', async () => {
    const { project, keep, make, makeKept } = await setup();
    const a = await make('Inside A'), b = await make('Inside B'), outside = await makeKept('Outside');
    expect((await h.owner.post(`/projects/${project.id}/purge`, { confirmName: 'nope' })).status).toBe(400);
    const done = expectEnvelope(await h.owner.post(`/projects/${project.id}/purge`, { confirmName: project.name }), 200, purgeResponseSchema).data;
    expect(done.deleted['projects']).toBe(1);
    expect(done.deleted['tasks']).toBe(2);
    expect((await h.owner.get(`/tasks/${a.id}`)).status).toBe(404);
    expect((await h.owner.get(`/tasks/${b.id}`)).status).toBe(404);
    expect((await h.owner.get(`/tasks/${outside.id}`)).status).toBe(200);
    expect((await h.owner.get(`/projects/${keep.id}`)).status).toBe(200);
    expect((await h.owner.get(`/projects/${project.id}`)).status).toBe(404);
  });

  it('refuses people who are not owner or admin, and unknown ids', async () => {
    const { project, make } = await setup();
    const task = await make('Protected');
    expect((await h.member.post(`/tasks/${task.id}/purge`, { confirmTitle: 'Protected' })).status).toBe(403);
    expect((await h.viewer.post(`/projects/${project.id}/purge`, { confirmName: project.name })).status).toBe(403);
    expect((await h.owner.get(`/tasks/${task.id}`)).status).toBe(200);
    expect((await h.owner.post(`/tasks/${randomUUID()}/purge`, { confirmTitle: 'x' })).status).toBe(404);
  });
});
