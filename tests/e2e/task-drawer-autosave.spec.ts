// Root-owned compiled private API + disposable database only; no runtime lifecycle here.
import { expect, test, type Page } from '@playwright/test';
import { taskFieldDefinitionResponseSchema, taskFieldValueListResponseSchema, type TaskDto } from '@workloom/contracts';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, allTasks, apiRead, apiWrite, createFixtureTask, freshProject, observeCommands, openTable, requireValue, savedRow, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const pane = (page: Page) => page.locator('[data-task-panel][data-state="open"]');
async function openPane(f: DailyProject, task: TaskDto) {
  await savedRow(f.page, task.id).locator(`[data-task-open-area="${task.id}"]`).click();
  await expect(pane(f.page)).toBeVisible();
  await expect(pane(f.page).getByLabel('Task name', { exact: true })).toHaveValue(task.title);
}
async function head(f: DailyProject, task: TaskDto, expected: Record<string, unknown>) {
  await expect.poll(async () => requireValue((await allTasks(f)).find(row => row.id === task.id)), { timeout: 5_000 }).toMatchObject(expected);
  return requireValue((await allTasks(f)).find(row => row.id === task.id));
}
async function fixture(page: Page, label: string) {
  const f = await freshProject(page, provider, label, true);
  const a = await createFixtureTask(f, 'Autosave task A', { responsibleMembershipId: f.owner.id });
  const b = await createFixtureTask(f, 'Autosave task B', { responsibleMembershipId: f.owner.id });
  await openTable(f);
  return { f, a, b };
}
function patch(command: { method: string; path: string; body: string; key: string | undefined }, f: DailyProject, task: TaskDto, input: object) {
  expect(command).toMatchObject({ method: 'PATCH', path: `${f.prefix}/tasks/${task.id}` });
  expect(command.key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(JSON.parse(command.body)).toEqual(input);
}
test.describe('saved task field autosave and compact pane', () => {
  test.describe.configure({ mode: 'serial' }); test.setTimeout(150_000);
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Private QA49318 with one worker required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Private Auth gate requires trace and video off.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 900 }); });
  test.afterAll(async () => { await provider?.close(); });

  test('keeps the global header full width, shows Description in the first viewport and saves blur/Enter/choice without Save', async ({ page }, info) => {
    const { f, a } = await fixture(page, 'Compact autosave pane');
    const header = page.locator('header.sticky').first(); const before = requireValue(await header.boundingBox() ?? undefined);
    await openPane(f, a);
    const panel = requireValue(await pane(page).boundingBox() ?? undefined), after = requireValue(await header.boundingBox() ?? undefined);
    expect(panel.y).toBeCloseTo(before.y + before.height, 0); expect(panel.width).toBeGreaterThanOrEqual(600);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(2); expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(2);
    const description = pane(page).getByLabel('Description', { exact: true }); const descriptionBox = requireValue(await description.boundingBox() ?? undefined);
    expect(descriptionBox.y + descriptionBox.height).toBeLessThanOrEqual(900); await expect(description).toBeVisible();
    await expect(pane(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('compact-task-pane.png') });
    const writes = observeCommands(page, f.prefix);
    await pane(page).getByLabel('Task name', { exact: true }).fill('Autosaved visible title');
    expect(writes.commands).toHaveLength(0); await description.click();
    const first = await head(f, a, { title: 'Autosaved visible title', revision: a.revision + 1 });
    patch(requireValue(writes.commands[0]), f, a, { expectedRevision: a.revision, title: first.title });
    await description.fill('First line'); await description.press('Enter'); await description.press('End'); await description.press('ControlOrMeta+Enter');
    const next = await head(f, a, { description: 'First line\n', revision: first.revision + 1 });
    patch(requireValue(writes.commands[1]), f, a, { expectedRevision: first.revision, description: next.description });
    await pane(page).getByRole('combobox', { name: 'Assignee', exact: true }).click(); await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
    await head(f, a, { responsibleMembershipId: null, revision: next.revision + 1 });
    patch(requireValue(writes.commands[2]), f, a, { expectedRevision: next.revision, responsibleMembershipId: null });
    expect(writes.commands).toHaveLength(3); await page.reload(); await expect(pane(page).getByLabel('Description', { exact: true })).toHaveValue('First line\n'); writes.close();
  });

  test('queues later text through Close and another task while a real committed answer is held', async ({ page }) => {
    const { f, a, b } = await fixture(page, 'Queued field autosave'); let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; }); let first = true;
    await page.route(`**${f.prefix}/tasks/${a.id}`, async route => { if (route.request().method() !== 'PATCH' || !first) return route.continue(); first = false; const response = await route.fetch(); expect(response.status()).toBe(200); await gate; await route.fulfill({ response }); });
    await openPane(f, a); const writes = observeCommands(page, f.prefix);
    await pane(page).getByLabel('Task name', { exact: true }).fill('Held first title'); await pane(page).getByLabel('Description', { exact: true }).click();
    await expect.poll(() => writes.commands.length).toBe(1);
    await pane(page).getByLabel('Description', { exact: true }).fill('Latest description before close'); await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
    await openPane(f, b); await pane(page).getByLabel('Task name', { exact: true }).fill('Queued task B title'); await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
    expect(writes.commands).toHaveLength(1); await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    release();
    await head(f, a, { title: 'Held first title', description: 'Latest description before close', revision: a.revision + 2 });
    await head(f, b, { title: 'Queued task B title', revision: b.revision + 1 });
    expect(writes.commands).toHaveLength(3);
    patch(requireValue(writes.commands[0]), f, a, { expectedRevision: a.revision, title: 'Held first title' });
    patch(requireValue(writes.commands.slice(1).find(command => command.path === `${f.prefix}/tasks/${a.id}`)), f, a, { expectedRevision: a.revision + 1, description: 'Latest description before close' });
    patch(requireValue(writes.commands.slice(1).find(command => command.path === `${f.prefix}/tasks/${b.id}`)), f, b, { expectedRevision: b.revision, title: 'Queued task B title' });
    await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeFocused(); writes.close();
  });

  test('keeps a lost acknowledgement immutable across Close and Retry without automatic resubmission', async ({ page }) => {
    const { f, a } = await fixture(page, 'Unknown field autosave'); let lose = true;
    await page.route(`**${f.prefix}/tasks/${a.id}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); const response = await route.fetch(); expect(response.status()).toBe(200); if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ response }); });
    await openPane(f, a); const writes = observeCommands(page, f.prefix);
    await pane(page).getByLabel('Task name', { exact: true }).fill('Exactly once title'); await pane(page).getByLabel('Description', { exact: true }).click();
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Resume original editor', exact: true }).click(); await expect(pane(page)).toBeVisible(); expect(writes.commands).toHaveLength(1);
    await pane(page).getByRole('button', { name: 'Retry', exact: true }).click(); await head(f, a, { title: 'Exactly once title', revision: a.revision + 1 });
    await expect(pane(page).getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    expect(writes.commands).toHaveLength(2); expect(writes.commands[1]).toEqual(writes.commands[0]);
    patch(requireValue(writes.commands[0]), f, a, { expectedRevision: a.revision, title: 'Exactly once title' }); writes.close();
  });

  test('keeps invalid text recoverable while an unrelated valid field saves and clears ordinary drafts before bulk editing', async ({ page }) => {
    const { f, a, b } = await fixture(page, 'Independent field validation'); await openPane(f, a); const writes = observeCommands(page, f.prefix);
    await pane(page).getByLabel('Task name', { exact: true }).fill(''); await pane(page).getByLabel('Description', { exact: true }).fill('Valid independent description');
    await pane(page).getByLabel('Description', { exact: true }).press('ControlOrMeta+Enter');
    const fresh = await head(f, a, { description: 'Valid independent description', title: a.title, revision: a.revision + 1 });
    expect(writes.commands).toHaveLength(1); patch(requireValue(writes.commands[0]), f, a, { expectedRevision: a.revision, description: fresh.description });
    await pane(page).getByRole('button', { name: 'Close', exact: true }).click(); await page.getByRole('button', { name: 'Resume original editor', exact: true }).click();
    await expect(pane(page).getByLabel('Task name', { exact: true })).toHaveValue('');
    await pane(page).getByLabel('Task name', { exact: true }).fill(a.title); await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume original editor', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Select task: ${a.title}`, exact: true }).click(); await page.getByRole('button', { name: `Select task: ${b.title}`, exact: true }).click({ modifiers: ['Shift'] });
    await savedRow(page, a.id).locator(`button[data-task-cell="${a.id}:statusId"]`).click(); await page.getByRole('option', { name: requireValue(f.statuses.find(status => status.id === f.doneId)).name, exact: true }).click();
    await head(f, a, { statusId: f.doneId }); await head(f, b, { statusId: f.doneId });
    expect(writes.commands).toHaveLength(2); expect(requireValue(writes.commands[1]).path).toBe(`${f.prefix}/tasks/bulk-update`); writes.close();
  });

  test('autosaves a custom zero through its guarded value writer with no Save value action', async ({ page }) => {
    const { f, a } = await fixture(page, 'Custom value autosave');
    const field = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Autosave score', type: 'number', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data;
    // The field was created through the fixture API, outside the page's query cache.
    await openTable(f);
    await openPane(f, a); await pane(page).locator('summary').filter({ hasText: 'More fields' }).click();
    await pane(page).getByRole('button', { name: 'Edit “Autosave score”', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Value of “Autosave score”', exact: true }); const writes = observeCommands(page, f.prefix);
    await dialog.getByRole('textbox', { name: field.name, exact: true }).fill('0'); await dialog.getByRole('textbox', { name: field.name, exact: true }).press('Tab');
    await expect(dialog).toHaveCount(0);
    expect(writes.commands).toHaveLength(1); const command = requireValue(writes.commands[0]); expect(command.method).toBe('PUT');
    expect(JSON.parse(command.body)).toEqual({ expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'number', value: 0 } });
    expect((await apiRead(page, `${f.prefix}/tasks/${a.id}/field-values`, taskFieldValueListResponseSchema)).data.find(value => value.fieldId === field.id)?.value).toEqual({ type: 'number', value: 0 });
    await expect(pane(page)).toBeVisible(); writes.close();
  });
});
