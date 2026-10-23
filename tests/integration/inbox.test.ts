// Real PostgreSQL + real API process: what lands in a person's inbox, and what never does.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inboxResponseSchema, taskResponseSchema } from '@workloom/contracts';
import { expectEnvelope } from './support/p1a.js';
import { planningHarness, MEMBERS, type PlanningHarness } from './support/p2a-fixture.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';

requireTestDatabaseUrl();
let h: PlanningHarness;

describe('inbox', () => {
  beforeAll(async () => { h = await planningHarness('inbox'); }, 90_000);
  afterAll(async () => { if (h) await h.close(); }, 30_000);

  async function newTask(assignee: string | null) {
    const project = await h.owner.tasks.createProject(`Inbox ${randomUUID().slice(0, 6)}`);
    const todo = (await h.owner.tasks.listStatuses(project.id)).find(s => s.group === 'todo');
    if (!todo) throw new Error('status');
    const task = expectEnvelope(await h.owner.post('/tasks', { projectId: project.id, title: 'Plan the launch', statusId: todo.id, ...(assignee ? { responsibleMembershipId: assignee } : {}) }), 201, taskResponseSchema).data;
    return { project, task };
  }
  const inbox = async (client: PlanningHarness['member']) => expectEnvelope(await client.get('/inbox'), 200, inboxResponseSchema).data;

  it('shows an assignment made by someone else, then a comment from someone else, and nothing about own actions', async () => {
    const { project, task } = await newTask(MEMBERS.teamMemberA);
    const first = await inbox(h.member);
    expect(first.filter(item => item.task?.id === task.id).map(item => item.kind)).toEqual(['assigned']);
    expect(first.find(item => item.task?.id === task.id)).toMatchObject({ task: { title: 'Plan the launch', projectId: project.id, projectName: project.name }, excerpt: null });
    const commented = await h.owner.post(`/tasks/${task.id}/comments`, { body: 'Can you take this before Friday?' });
    expect(commented.status, commented.text()).toBe(201);
    const second = await inbox(h.member);
    expect(second.filter(item => item.task?.id === task.id).map(item => item.kind)).toEqual(['comment', 'assigned']);
    expect(second[0]).toMatchObject({ kind: 'comment', excerpt: 'Can you take this before Friday?' });
    // The author's own inbox does not echo what they did themselves.
    expect((await inbox(h.owner)).some(item => item.task?.id === task.id)).toBe(false);
    // Assigning yourself is not news either.
    const own = await newTask(MEMBERS.teamOwner);
    expect((await inbox(h.owner)).some(item => item.task?.id === own.task.id)).toBe(false);
  });

  it('delivers an @mention to the named person once, even without involvement, and ignores self and outsiders', async () => {
    const { task } = await newTask(null);
    const posted = await h.owner.post(`/tasks/${task.id}/comments`, { body: '@Member can you look?', mentionedMembershipIds: [MEMBERS.teamMemberA, MEMBERS.teamOwner, MEMBERS.outsideOwner] });
    expect(posted.status, posted.text()).toBe(201);
    const mine = (await inbox(h.member)).filter(item => item.task?.id === task.id);
    expect(mine.map(item => item.kind)).toEqual(['mention']);
    expect(mine[0]?.excerpt).toBe('@Member can you look?');
    expect((await inbox(h.owner)).some(item => item.task?.id === task.id)).toBe(false);
    expect((await inbox(h.outsider)).some(item => item.task?.id === task.id)).toBe(false);
    expect((await h.db.sql`select count(*)::int as n from task_comment_mentions`)[0]?.n).toBeGreaterThanOrEqual(1);
    // A person already on the task who is also named sees one item, not two.
    const assigned = await newTask(MEMBERS.teamMemberA);
    await h.owner.post(`/tasks/${assigned.task.id}/comments`, { body: '@Member please confirm', mentionedMembershipIds: [MEMBERS.teamMemberA] });
    expect((await inbox(h.member)).filter(item => item.task?.id === assigned.task.id).map(item => item.kind).sort()).toEqual(['assigned', 'mention']);
  });

  it('is empty for someone with no involvement, and never crosses workspaces', async () => {
    const { task } = await newTask(MEMBERS.teamMemberA);
    expect((await inbox(h.viewer)).some(item => item.task?.id === task.id)).toBe(false);
    expect((await inbox(h.outsider)).some(item => item.task?.id === task.id)).toBe(false);
  });
});
