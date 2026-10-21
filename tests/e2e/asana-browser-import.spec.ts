// Synthetic source pair only; compiled private API49318 and signed fake Auth49319.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { projectListResponseSchema, taskFieldDefinitionListResponseSchema, taskFieldValueListResponseSchema, taskListResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, apiRead, freshProject, requireValue } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ baseURL }, info) => {
  if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw new Error('Explicit private49318 single-worker acceptance required.');
  if (info.project.use.trace !== 'off' || info.project.use.video !== 'off' || info.project.use.screenshot !== 'off') throw new Error('Auth traces, video and automatic screenshots must be off.');
  provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
});
test.afterAll(async () => { await provider?.close(); });

function exportPair() {
  const project = { gid: '200', name: 'Synthetic uploaded delivery' }, workspace = { gid: '100', name: 'Synthetic organization' }, section = { gid: '300', name: 'Delivery' };
  const tasks = [0, 1].map(index => ({
    gid: String(1000 + index), name: index === 0 ? 'Imported zero-value task' : 'Imported completed task', resource_subtype: 'default_task', workspace,
    projects: [project], memberships: [{ project, section }], parent: null, assignee: null, tags: [], notes: 'Synthetic import notes only.', completed: index === 1,
    created_at: '2026-10-01T12:00:00.000Z', modified_at: '2026-10-02T12:00:00.000Z', completed_at: index === 1 ? '2026-10-03T12:00:00.000Z' : null,
    start_on: '2026-10-19', due_on: '2026-10-23', start_at: null, due_at: null, followers: [],
    custom_fields: [{ gid: '701', name: 'Effort points', resource_subtype: 'number', precision: 2, number_value: index === 0 ? 0 : 3 }], subtasks: [],
  }));
  const headers = ['Task ID', 'Created At', 'Completed At', 'Last Modified', 'Name', 'Section/Column', 'Assignee', 'Assignee Email', 'Start Date', 'Due Date', 'Tags', 'Notes', 'Projects', 'Parent task', 'Blocked By (Dependencies)', 'Blocking (Dependencies)', 'Effort points'];
  const rows = tasks.map(task => [task.gid, task.created_at, task.completed_at ?? '', task.modified_at, task.name, section.name, '', '', task.start_on, task.due_on, '', task.notes, project.name, '', '', '', task.custom_fields[0]?.number_value ?? '']);
  const csv = [headers, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n';
  return { json: Buffer.from(JSON.stringify({ data: tasks })), csv: Buffer.from(csv), projectName: project.name };
}
async function uploadPair(dialog: Locator, pair: ReturnType<typeof exportPair>) {
  await dialog.getByLabel('Asana JSON export', { exact: true }).setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: pair.json });
  await dialog.getByLabel('Asana CSV export', { exact: true }).setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: pair.csv });
}
async function openImport(page: Page, workspaceId: string) {
  await page.goto(`${APP}/app/w/${workspaceId}/projects`);
  await page.getByRole('button', { name: 'Import from Asana', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import an Asana project', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
}

test('owner previews and imports a real export pair, opens the project and reopens the same import without duplicate tasks', async ({ page }, info) => {
  const f = await freshProject(page, provider, 'Browser import owner'), pair = exportPair();
  const projectsBefore = await apiRead(page, `${f.prefix}/projects`, projectListResponseSchema);
  const dialog = await openImport(page, f.workspaceId);
  await expect(dialog.getByRole('button', { name: 'Check files', exact: true })).toBeDisabled();
  await uploadPair(dialog, pair); await dialog.getByRole('button', { name: 'Check files', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: pair.projectName, exact: true })).toBeVisible();
  await expect(dialog.getByText('Effort points', { exact: true })).toBeVisible();
  const importAction = dialog.getByRole('button', { name: 'Import project', exact: true });
  await expect(importAction).toBeEnabled();
  // toBeVisible also accepts off-viewport controls. Check geometry before Playwright can
  // scroll the action into view; primary and Close must be present at initial scroll.
  expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
  const dialogBox = await dialog.boundingBox(), viewport = page.viewportSize();
  if (!dialogBox || !viewport) throw new Error('Native dialog geometry unavailable.');
  expect(viewport).toEqual({ width: 1280, height: 720 });
  for (const control of [importAction, dialog.getByRole('button', { name: 'Close', exact: true }).last()]) {
    const box = await control.boundingBox(); if (!box) throw new Error('Native import footer is not rendered.');
    expect(box.y).toBeGreaterThanOrEqual(Math.max(0, dialogBox.y));
    expect(box.y + box.height).toBeLessThanOrEqual(Math.min(viewport.height, dialogBox.y + dialogBox.height) + 0.5);
    expect(box.x).toBeGreaterThanOrEqual(Math.max(0, dialogBox.x));
    expect(box.x + box.width).toBeLessThanOrEqual(Math.min(viewport.width, dialogBox.x + dialogBox.width) + 0.5);
  }
  expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
  expect((await apiRead(page, `${f.prefix}/projects`, projectListResponseSchema)).data).toEqual(projectsBefore.data);
  expect((await apiRead(page, `${f.prefix}/tasks?projectId=${f.projectId}&limit=200`, taskListResponseSchema)).data).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('synthetic-import-preview.png'), fullPage: false });
  await dialog.getByRole('button', { name: 'Import project', exact: true }).click();
  const open = dialog.getByRole('link', { name: 'Open project', exact: true }); await expect(open).toBeVisible();
  const href = await open.getAttribute('href'); if (!href) throw new Error('Imported project link missing.');
  const projectId = requireValue(href.split('/projects/')[1]);
  await open.click(); await expect(page).toHaveURL(new RegExp(`/projects/${projectId}$`));
  await expect(page.getByRole('heading', { name: pair.projectName, exact: true })).toBeVisible();
  const tasks = (await apiRead(page, `${f.prefix}/tasks?projectId=${projectId}&limit=200`, taskListResponseSchema)).data;
  expect(tasks).toHaveLength(2); expect(tasks.map(task => task.title).sort()).toEqual(['Imported completed task', 'Imported zero-value task']);
  const definitions = (await apiRead(page, `${f.prefix}/fields?projectId=${projectId}`, taskFieldDefinitionListResponseSchema)).data;
  const field = requireValue(definitions.find(definition => definition.name === 'Effort points'));
  const values = (await apiRead(page, `${f.prefix}/projects/${projectId}/field-values?taskIds=${tasks.map(task => task.id).join(',')}`, taskFieldValueListResponseSchema)).data;
  expect(values.filter(value => value.fieldId === field.id).map(value => value.value.value).sort()).toEqual([0, 3]);
  const repeatDialog = await openImport(page, f.workspaceId); await uploadPair(repeatDialog, pair);
  await repeatDialog.getByRole('button', { name: 'Check files', exact: true }).click();
  const sameProject = repeatDialog.getByRole('link', { name: 'Open project', exact: true }); await expect(sameProject).toBeVisible();
  expect(await sameProject.getAttribute('href')).toBe(href);
  await expect(repeatDialog.getByRole('button', { name: 'Import project', exact: true })).toHaveCount(0);
  expect((await apiRead(page, `${f.prefix}/projects`, projectListResponseSchema)).data).toHaveLength(projectsBefore.data.length + 1);
  expect((await apiRead(page, `${f.prefix}/tasks?projectId=${projectId}&limit=200`, taskListResponseSchema)).data).toHaveLength(2);
  await repeatDialog.getByRole('button', { name: 'Import another project', exact: true }).click();
  await expect(repeatDialog.getByLabel('Asana JSON export', { exact: true })).toHaveValue('');
  await expect(repeatDialog.getByLabel('Asana CSV export', { exact: true })).toHaveValue('');
  await expect(repeatDialog.getByRole('button', { name: 'Check files', exact: true })).toBeDisabled();
  await expect(repeatDialog.getByRole('button', { name: 'Import project', exact: true })).toHaveCount(0);
  expect((await apiRead(page, `${f.prefix}/projects`, projectListResponseSchema)).data).toHaveLength(projectsBefore.data.length + 1);
  expect((await apiRead(page, `${f.prefix}/tasks?projectId=${projectId}&limit=200`, taskListResponseSchema)).data).toHaveLength(2);
  await repeatDialog.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(repeatDialog).toHaveCount(0);
});

test('invalid source pair shows a recoverable message and leaves project navigation usable without imports', async ({ page }) => {
  const f = await freshProject(page, provider, 'Invalid browser import'), pair = exportPair(), dialog = await openImport(page, f.workspaceId);
  await uploadPair(dialog, { ...pair, json: Buffer.from('{not valid JSON') });
  await dialog.getByRole('button', { name: 'Check files', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Check files', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Import project', exact: true })).toHaveCount(0);
  expect((await apiRead(page, `${f.prefix}/projects`, projectListResponseSchema)).data).toHaveLength(1);
  expect((await apiRead(page, `${f.prefix}/tasks?projectId=${f.projectId}&limit=200`, taskListResponseSchema)).data).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New project', exact: true })).toBeVisible();
});
