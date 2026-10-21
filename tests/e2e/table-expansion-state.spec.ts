// Private compiled API49318 + signed synthetic Auth49319 only. No customer sessions or records.
import { expect, test, type Page } from '@playwright/test';
import { projectResponseSchema, sectionResponseSchema, taskProjectPlacementResponseSchema, taskResponseSchema, taskStatusListResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, observeCommands, requireValue, type DailyProject } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ baseURL }, info) => {
  if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw new Error('Explicit private49318 single-worker acceptance required.');
  if (info.project.use.trace !== 'off' || info.project.use.video !== 'off' || info.project.use.screenshot !== 'off') throw new Error('Auth traces, video and automatic screenshots must be off.');
  provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
});
test.afterAll(async () => { await provider?.close(); });
const projectUrl = (f: DailyProject, id = f.projectId) => `${APP}/app/w/${f.workspaceId}/projects/${id}?view=table`;
const nativeRow = (page: Page, id: string) => page.locator(`tr[data-task-row="${id}"]`);
const linked = (page: Page) => page.getByRole('region', { name: 'Tasks linked from other projects', exact: true });
async function anotherProject(f: DailyProject, label: string) {
  const project = (await apiWrite(f.page, `${f.prefix}/projects`, { name: label }, projectResponseSchema)).data;
  const statuses = (await apiRead(f.page, `${f.prefix}/projects/${project.id}/statuses`, taskStatusListResponseSchema)).data;
  return { project, todoId: requireValue(statuses.find(status => status.group === 'todo')).id };
}
async function attach(f: DailyProject, taskId: string, projectId: string, sectionId: string) {
  const current = (await apiRead(f.page, `${f.prefix}/tasks/${taskId}`, taskResponseSchema)).data;
  return (await apiWrite(f.page, `${f.prefix}/tasks/${taskId}/placements`, { projectId, sectionId, expectedTaskRevision: current.revision }, taskProjectPlacementResponseSchema)).data;
}

test('native nested trees default closed, restore section/nested choices after reload and isolate the same task IDs in another project', async ({ page }) => {
  const f = await freshProject(page, provider, 'Remember table expansion');
  const section = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Engineering' }, sectionResponseSchema)).data;
  const root = await createFixtureTask(f, 'Native parent', { sectionId: section.id });
  const child = await createFixtureTask(f, 'Native child', { parentTaskId: root.id, sectionId: section.id });
  const grandchild = await createFixtureTask(f, 'Native grandchild', { parentTaskId: child.id, sectionId: section.id });
  const other = await anotherProject(f, 'Separate expansion scope');
  const otherSection = (await apiWrite(page, `${f.prefix}/projects/${other.project.id}/sections`, { name: 'Other Engineering' }, sectionResponseSchema)).data;
  for (const task of [root, child, grandchild]) await attach(f, task.id, other.project.id, otherSection.id);
  const writes = observeCommands(page, f.prefix);
  try {
    await page.goto(projectUrl(f));
    await expect(nativeRow(page, root.id)).toBeVisible(); await expect(nativeRow(page, child.id)).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand subtasks of “Native parent”', exact: true }).click();
    await expect(nativeRow(page, child.id)).toBeVisible(); await expect(nativeRow(page, grandchild.id)).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand subtasks of “Native child”', exact: true }).click();
    await expect(nativeRow(page, grandchild.id)).toBeVisible();
    await page.getByRole('button', { name: 'Collapse section “Engineering”', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand section “Engineering”', exact: true })).toBeVisible();
    await expect(nativeRow(page, root.id)).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand section “Engineering”', exact: true }).click();
    await expect(nativeRow(page, grandchild.id)).toBeVisible();
    await page.goto(projectUrl(f, other.project.id));
    await expect(linked(page).getByRole('button', { name: 'Native parent', exact: true })).toBeVisible();
    await expect(linked(page).getByRole('button', { name: 'Native child', exact: true })).toHaveCount(0);
    await expect(linked(page).getByRole('button', { name: 'Expand subtasks of “Native parent”', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await page.goto(projectUrl(f));
    await expect(nativeRow(page, grandchild.id)).toBeVisible();
    expect(writes.commands).toHaveLength(0);
  } finally { writes.close(); }
});

test('one page remembers native and linked parents together without one toggle overwriting the other', async ({ page }, info) => {
  const f = await freshProject(page, provider, 'Shared expansion controller');
  const section = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Delivery' }, sectionResponseSchema)).data;
  const native = await createFixtureTask(f, 'Delivery native parent', { sectionId: section.id });
  const nativeChild = await createFixtureTask(f, 'Delivery native child', { parentTaskId: native.id, sectionId: section.id });
  const home = await anotherProject(f, 'Shared task home');
  const shared = await createFixtureTask(f, 'Delivery shared parent', { projectId: home.project.id, statusId: home.todoId });
  const sharedChild = await createFixtureTask(f, 'Delivery shared child', { projectId: home.project.id, statusId: home.todoId, parentTaskId: shared.id });
  await attach(f, shared.id, f.projectId, section.id); await attach(f, sharedChild.id, f.projectId, section.id);
  const writes = observeCommands(page, f.prefix);
  try {
    await page.goto(projectUrl(f));
    await expect(nativeRow(page, native.id)).toBeVisible();
    await expect(linked(page).getByRole('button', { name: shared.title, exact: true })).toBeVisible();
    await expect(nativeRow(page, nativeChild.id)).toHaveCount(0);
    await expect(linked(page).getByRole('button', { name: sharedChild.title, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Expand subtasks of “${native.title}”`, exact: true }).click();
    await linked(page).getByRole('button', { name: `Expand subtasks of “${shared.title}”`, exact: true }).click();
    await page.getByRole('button', { name: 'Collapse section “Delivery”', exact: true }).first().click();
    await expect(nativeRow(page, native.id)).toHaveCount(0);
    await expect(linked(page).getByRole('button', { name: shared.title, exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: 'Expand section “Delivery”', exact: true }).first().click();
    await expect(nativeRow(page, nativeChild.id)).toBeVisible();
    await expect(linked(page).getByRole('button', { name: sharedChild.title, exact: true })).toBeVisible();
    await page.reload();
    await expect(nativeRow(page, nativeChild.id)).toBeVisible();
    await expect(linked(page).getByRole('button', { name: sharedChild.title, exact: true })).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.screenshot({ path: info.outputPath('native-and-linked-expanded.png'), fullPage: false });
    expect(writes.commands).toHaveLength(0);
  } finally { writes.close(); }
});
