import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Response } from '@playwright/test';
import {
  createTaskInputSchema, membershipListResponseSchema, projectResponseSchema,
  sectionResponseSchema, taskResponseSchema, taskStatusListResponseSchema,
  type CreateTaskInput, type TaskDto,
} from '@workloom/contracts';
import { loadLiveData } from './live-api.js';

/** Fresh QA projects stay in the historical fixture workspace; never alter Workloom Studio. */
export async function dailyFixture(request: APIRequestContext, baseURL: string | undefined, label: string) {
  if (!baseURL) throw new Error('Browser baseURL is required.');
  const live = await loadLiveData(request);
  const workspace = live.workspaces.find(row => row.id === '5eed0000-0000-4000-8000-000000000201');
  if (!workspace) throw new Error('Historical synthetic QA workspace is required; do not seed or mutate the showcase.');
  const prefix = `/api/v1/workspaces/${workspace.id}`;
  const members = membershipListResponseSchema.parse(await (await request.get(`${prefix}/memberships`)).json()).data;
  const own = members.find(member => member.userId === live.me.actor.id);
  const other = members.find(member => member.userId !== live.me.actor.id && member.role === 'member');
  if (!own || !other) throw new Error('Current actor and a second synthetic member are required.');
  const origin = new URL(baseURL).origin;
  async function post<T>(path: string, data: unknown, schema: { parse(value: unknown): T }, status = 201) {
    const response = await request.post(prefix + path, { headers: { origin, 'idempotency-key': randomUUID() }, data });
    expect(response.status(), await response.text()).toBe(status);
    return schema.parse(await response.json());
  }
  const token = `DailyQA-${randomUUID().slice(0, 8)}`;
  const project = (await post('/projects', { name: `${label} ${token}` }, projectResponseSchema)).data;
  const statuses = taskStatusListResponseSchema.parse(await (await request.get(`${prefix}/projects/${project.id}/statuses`)).json()).data;
  const todo = statuses.find(status => status.group === 'todo');
  const progress = statuses.find(status => status.group === 'in_progress');
  const done = statuses.find(status => status.group === 'done');
  if (!todo || !progress || !done) throw new Error('Expected current default status groups.');
  const section = (await post(`/projects/${project.id}/sections`, { name: 'QA section', position: 0 }, sectionResponseSchema)).data;
  const createTask = async (title: string, patch: Partial<CreateTaskInput> = {}): Promise<TaskDto> => {
    return (await post('/tasks', createTaskInputSchema.parse({ projectId: project.id, sectionId: section.id,
      title, statusId: todo.id, responsibleMembershipId: own.id, participantMembershipIds: [own.id], ...patch }), taskResponseSchema)).data;
  };
  async function task(id: string): Promise<TaskDto> {
    const response = await request.get(`${prefix}/tasks/${id}`);
    expect(response.status(), await response.text()).toBe(200);
    return taskResponseSchema.parse(await response.json()).data;
  }
  return { request, live, workspace, members, own, other, prefix, origin, project, section, statuses, todo, progress, done,
    token, post, createTask, task, path: `/w/${workspace.id}/projects/${project.id}` };
}
export function apiCall(response: Response, method: string, path: string): boolean {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}
export async function taskResult(response: Response, status: number): Promise<TaskDto> {
  expect(response.status(), await response.text()).toBe(status);
  return taskResponseSchema.parse(await response.json()).data;
}
export function gate() {
  let release: () => void = () => { throw new Error('Gate not initialized.'); };
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
