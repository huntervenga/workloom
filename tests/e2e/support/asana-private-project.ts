// Native-test fixture writes use the actual API after real shared-Auth login, only on private QA.
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, type Request } from '@playwright/test';
import {
  membershipListResponseSchema, projectResponseSchema, taskListResponseSchema, taskResponseSchema,
  taskStatusListResponseSchema, workspaceListResponseSchema,
  type MembershipDto, type TaskDto, type TaskStatusDto,
} from '@workloom/contracts';
import { addPrivateSyntheticMembers } from './private-membership-fixture.js';
import type { FakeSharedAuth } from './fake-shared-auth.js';
import { attachPrivateBrowserDiagnostics, privateBrowserPhase } from './private-browser-diagnostics.js';

export const PRIVATE_APP = 'http://127.0.0.1:49318';
export type Parser<T> = { parse(value: unknown): T };
export interface DailyProject {
  page: Page; actorId: string; workspaceId: string; prefix: string; projectId: string;
  owner: MembershipDto; teammates: MembershipDto[]; statuses: TaskStatusDto[]; todoId: string; doneId: string;
}
export interface ObservedCommand { path: string; method: string; body: string; key: string | undefined }
export function requireValue<T>(value: T | undefined): T { if (value === undefined) throw new Error('Private native fixture is missing.'); return value; }
export async function apiRead<T>(page: Page, path: string, parser: Parser<T>): Promise<T> {
  const response = await page.request.get(`${PRIVATE_APP}${path}`); expect(response.status()).toBe(200);
  return parser.parse(await response.json());
}
export async function apiWrite<T>(page: Page, path: string, data: object, parser: Parser<T>, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const response = await page.request.fetch(`${PRIVATE_APP}${path}`, { method, data, headers: { Origin: PRIVATE_APP, 'Idempotency-Key': randomUUID() } });
  expect([200, 201].includes(response.status())).toBe(true); return parser.parse(await response.json());
}
export async function freshProject(page: Page, provider: FakeSharedAuth, label: string, withTeammates = false): Promise<DailyProject> {
  await attachPrivateBrowserDiagnostics(page, () => provider.stats());
  const identity = provider.registerIdentity(`${label} ${randomUUID()}`);
  await privateBrowserPhase(page, 'auth.goto', () => page.goto(`${PRIVATE_APP}/app`));
  await privateBrowserPhase(page, 'auth.sign-in', () => page.getByRole('link', { name: 'Sign in', exact: true }).click());
  await privateBrowserPhase(page, 'auth.chooser-visible', () => expect(page.getByRole('heading', { name: 'Private test identity', exact: true })).toBeVisible());
  // The provider click arrives at the standalone callback; the app document is a later navigation.
  // Arm its lifecycle boundary before clicking, using the existing navigation/test deadlines.
  // Observe rejection immediately and report only a fixed error, never navigation URLs/fragments.
  const finalAppDocument = page.waitForURL(
    url => url.origin === PRIVATE_APP && url.pathname === '/app',
    { waitUntil: 'domcontentloaded' },
  ).then(() => true, () => false);
  await privateBrowserPhase(page, 'auth.identity-click', () => page.getByRole('button', { name: identity.buttonName, exact: true }).click());
  await privateBrowserPhase(page, 'auth.final-document', async () => {
    if (!await finalAppDocument) throw new Error('Final private app document did not reach DOMContentLoaded.');
  });
  await privateBrowserPhase(page, 'auth.sign-out', () => expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeAttached());
  const meResponse = await privateBrowserPhase(page, 'auth.me-read', async () => {
    const response = await page.request.get(`${PRIVATE_APP}/api/v1/me`); expect(response.status()).toBe(200); return response;
  });
  const me = await meResponse.json() as { data: { actor: { id: string; kind: string }; authMode: string } };
  expect(me.data.actor.kind).toBe('real'); expect(me.data.authMode).toBe('shared');
  const workspaces = (await apiRead(page, '/api/v1/workspaces', workspaceListResponseSchema)).data;
  expect(workspaces).toHaveLength(1); const workspace = requireValue(workspaces[0]); expect(workspace.role).toBe('owner');
  const inserted = withTeammates ? await addPrivateSyntheticMembers(workspace.id, me.data.actor.id) : [];
  const prefix = `/api/v1/workspaces/${workspace.id}`;
  const members = (await apiRead(page, `${prefix}/memberships`, membershipListResponseSchema)).data;
  const owner = requireValue(members.find(member => member.userId === me.data.actor.id));
  const teammates = inserted.map(member => requireValue(members.find(dto => dto.id === member.id)));
  expect(members).toHaveLength(1 + inserted.length);
  const project = (await apiWrite(page, `${prefix}/projects`, { name: `${label} ${randomUUID()}` }, projectResponseSchema)).data;
  const statuses = (await apiRead(page, `${prefix}/projects/${project.id}/statuses`, taskStatusListResponseSchema)).data;
  return { page, actorId: me.data.actor.id, workspaceId: workspace.id, prefix, projectId: project.id, owner, teammates, statuses,
    todoId: requireValue(statuses.find(status => status.group === 'todo')).id,
    doneId: requireValue(statuses.find(status => status.group === 'done')).id };
}
export async function createFixtureTask(f: DailyProject, title: string, extra: Record<string, unknown> = {}): Promise<TaskDto> {
  return (await apiWrite(f.page, `${f.prefix}/tasks`, { projectId: f.projectId, statusId: f.todoId, title, ...extra }, taskResponseSchema)).data;
}
export async function allTasks(f: DailyProject): Promise<TaskDto[]> {
  const response = await apiRead(f.page, `${f.prefix}/tasks?projectId=${f.projectId}&includeArchived=true&limit=200`, taskListResponseSchema);
  expect(response.meta.nextCursor ?? null).toBeNull(); return response.data;
}
export const manualOrder = (rows: readonly TaskDto[]) => [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
export const savedRow = (page: Page, id: string) => page.locator(`tr[data-task-row="${id}"]`);
export async function openTable(f: DailyProject, query = '') {
  await f.page.goto(`${PRIVATE_APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table${query}`);
  await expect(f.page.getByRole('button', { name: 'Add task without a section', exact: true })).toBeVisible();
}
export async function showColumns(page: Page, names: readonly string[]) {
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My task columns', exact: true }); let changed = false;
  for (const name of names) {
    const choice = dialog.getByRole('checkbox', { name, exact: true }); await expect(choice).toBeEnabled();
    if (!await choice.isChecked()) { await choice.check(); changed = true; } await expect(choice).toBeChecked();
  }
  if (changed) { await dialog.getByRole('button', { name: 'Save columns', exact: true }).click(); await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible(); }
  await dialog.press('Escape'); await expect(dialog).toHaveCount(0);
}
export function observeCommands(page: Page, prefix: string) {
  const commands: ObservedCommand[] = [];
  const listener = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(prefix) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) commands.push({ path, method: request.method(), body: request.postData() ?? '', key: request.headers()['idempotency-key'] });
  };
  page.on('request', listener); return { commands, close: () => page.off('request', listener) };
}
export async function choose(page: Page, parent: Locator, name: string, option: string) {
  await parent.getByRole('combobox', { name, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click();
}
export async function center(locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox();
  if (!box) throw new Error('Actual mouse target is not visible.'); return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
