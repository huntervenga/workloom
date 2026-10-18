// Root-owned private compiled API + disposable PostgreSQL only. No runtime lifecycle or main DB.
import { expect, test, type Page } from '@playwright/test';
import { projectColumnsResponseSchema, tagResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueListResponseSchema, taskStatusListResponseSchema, type TaskDto } from '@workloom/contracts';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, allTasks, apiRead, apiWrite, createFixtureTask, freshProject, observeCommands, openTable, requireValue, savedRow, showColumns, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const row = (f: DailyProject, task: TaskDto) => savedRow(f.page, task.id);
const gutter = (page: Page, title: string) => page.getByRole('button', { name: `Select task: ${title}`, exact: true });
async function fixture(page: Page, label: string) {
  const f = await freshProject(page, provider, label, true);
  const a = await createFixtureTask(f, 'First selected', { estimateMinutes: 60, responsibleMembershipId: f.owner.id });
  const b = await createFixtureTask(f, 'Second selected', { estimateMinutes: 120, responsibleMembershipId: f.owner.id });
  const c = await createFixtureTask(f, 'Third selected', { estimateMinutes: 180, responsibleMembershipId: f.owner.id });
  const outside = await createFixtureTask(f, 'Unselected row', { estimateMinutes: 240, responsibleMembershipId: f.owner.id });
  return { f, selected: [a, b, c], outside };
}
async function select(f: DailyProject, rows: TaskDto[]) {
  await gutter(f.page, requireValue(rows[0]).title).click(); await gutter(f.page, requireValue(rows[rows.length - 1]).title).click({ modifiers: ['Shift'] });
  for (const task of rows) await expect(gutter(f.page, task.title)).toHaveAttribute('aria-pressed', 'true');
}
function assertBulk(command: { path: string; method: string; body: string; key: string | undefined }, f: DailyProject, selected: TaskDto[], changes: object, extras: (task: TaskDto) => object = () => ({})) {
  expect(command.method).toBe('POST'); expect(command.path).toBe(`${f.prefix}/tasks/bulk-update`); expect(command.key).toMatch(/^[0-9a-f-]{36}$/i);
  expect(JSON.parse(command.body)).toEqual({ projectId: f.projectId, tasks: selected.map(task => ({ taskId: task.id, expectedRevision: task.revision, ...extras(task) })), changes });
}
/** A request being observed is not an acknowledgement. Read independent authoritative heads
 * before the next edit; expected revisions come from fixture heads and the intended change. */
async function confirmedHeads(f: DailyProject, targets: readonly TaskDto[], project: (row: TaskDto) => object, expected: readonly object[]): Promise<TaskDto[]> {
  let confirmed: TaskDto[] = [];
  await expect.poll(async () => {
    const heads = await allTasks(f);
    confirmed = targets.map(target => requireValue(heads.find(row => row.id === target.id)));
    return confirmed.map(project);
  }, { timeout: 5_000 }).toEqual(expected);
  return confirmed;
}
const cell = (f: DailyProject, task: TaskDto, field: string) => row(f, task).locator(`button[data-task-cell="${task.id}:${field}"]`);
const saved = (page: Page) => expect(page.getByText('Saved 3 selected tasks.', { exact: true })).toBeVisible();
test.describe('editing through a selected task cell', () => {
  test.describe.configure({ mode: 'serial' }); test.setTimeout(150_000);
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth native gate requires traces and video off.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); }); test.afterAll(async () => { await provider?.close(); });
  test('status cell atomically applies its chosen status to three selected tasks and survives reload', async ({ page }) => {
    const { f, selected, outside } = await fixture(page, 'Native bulk status'); await openTable(f); await select(f, selected);
    const statuses = (await apiRead(page, `${f.prefix}/projects/${f.projectId}/statuses`, taskStatusListResponseSchema)).data;
    const target = requireValue(statuses.find(status => status.group === 'in_progress')); const writes = observeCommands(page, f.prefix);
    await cell(f, requireValue(selected[0]), 'statusId').click(); await expect(page.getByText('Applies to 3 selected tasks', { exact: true })).toBeVisible();
    await page.getByRole('option', { name: target.name, exact: true }).click(); await saved(page); expect(writes.commands).toHaveLength(1);
    assertBulk(requireValue(writes.commands[0]), f, selected, { statusId: target.id });
    let rows = await allTasks(f); for (const task of selected) expect(rows.find(row => row.id === task.id)?.statusId).toBe(target.id); expect(rows.find(row => row.id === outside.id)).toEqual(outside);
    await page.reload(); for (const task of selected) await expect(cell(f, task, 'statusId')).toContainText(target.name);
    rows = await allTasks(f); expect(rows.find(row => row.id === outside.id)).toEqual(outside); writes.close();
  });
  test('priority, tags and assignee each send one atomic chosen-value command; an unselected row stays single', async ({ page }) => {
    const { f, selected, outside } = await fixture(page, 'Native bulk choices');
    const tag = (await apiWrite(page, `${f.prefix}/tags`, { name: 'Shared selected tag' }, tagResponseSchema)).data;
    await openTable(f); await showColumns(page, ['Priority', 'Tags']); await select(f, selected);
    const writes = observeCommands(page, f.prefix);
    await cell(f, requireValue(selected[0]), 'priority').click(); await page.getByRole('option', { name: 'High', exact: true }).click(); await saved(page);
    expect(writes.commands).toHaveLength(1); assertBulk(requireValue(writes.commands[0]), f, selected, { priority: 'high' });
    const next = await confirmedHeads(f, selected, task => ({ id: task.id, revision: task.revision, priority: task.priority }), selected.map(task => ({ id: task.id, revision: task.revision + 1, priority: 'high' })));
    await expect(cell(f, requireValue(selected[0]), 'priority')).toBeVisible();
    await cell(f, requireValue(selected[1]), 'tagIds').click(); const tags = page.getByRole('dialog', { name: 'Edit tags', exact: true });
    const tagCheckbox = tags.getByRole('checkbox', { name: tag.name, exact: true });
    const tagLabel = tags.locator('label').filter({ has: page.getByRole('checkbox', { name: tag.name, exact: true }) });
    await expect(tagLabel).toHaveCount(1); await tagLabel.click();
    await expect(tagCheckbox).toBeChecked(); await tags.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => writes.commands.length).toBe(2); assertBulk(requireValue(writes.commands[1]), f, next, { tagIds: [tag.id] });
    const assigned = await confirmedHeads(f, next, task => ({ id: task.id, revision: task.revision, tagIds: task.tags.map(value => value.id) }), next.map(task => ({ id: task.id, revision: task.revision + 1, tagIds: [tag.id] })));
    await expect(tags).toHaveCount(0);
    await expect(cell(f, requireValue(selected[1]), 'tagIds')).toContainText(tag.name);
    await cell(f, requireValue(selected[0]), 'responsibleMembershipId').click(); await page.getByRole('option', { name: 'Unassigned', exact: true }).click();
    await expect.poll(() => writes.commands.length).toBe(3); assertBulk(requireValue(writes.commands[2]), f, assigned, { responsibleMembershipId: null });
    await confirmedHeads(f, assigned, task => ({ id: task.id, revision: task.revision, responsibleMembershipId: task.responsibleMembershipId }), assigned.map(task => ({ id: task.id, revision: task.revision + 1, responsibleMembershipId: null })));
    await expect(cell(f, requireValue(selected[0]), 'responsibleMembershipId')).toBeVisible();
    await cell(f, outside, 'priority').click(); await page.getByRole('option', { name: 'Urgent', exact: true }).click();
    await expect.poll(() => writes.commands.length).toBe(4); expect(writes.commands[3]).toMatchObject({ method: 'PATCH', path: `${f.prefix}/tasks/${outside.id}` });
    await confirmedHeads(f, [outside], task => ({ id: task.id, revision: task.revision, priority: task.priority }), [{ id: outside.id, revision: outside.revision + 1, priority: 'urgent' }]);
    await expect(cell(f, outside, 'priority')).toBeVisible();
    const heads = await allTasks(f); for (const task of selected) expect(heads.find(row => row.id === task.id)).toMatchObject({ priority: 'high', responsibleMembershipId: null, tags: [expect.objectContaining({ id: tag.id })] });
    writes.close();
  });
  test('date cell preserves untouched endpoints and completion applies one common target, not per-row toggles', async ({ page }) => {
    const { f, selected } = await fixture(page, 'Native bulk dates'); await openTable(f); await select(f, selected); const writes = observeCommands(page, f.prefix);
    await cell(f, requireValue(selected[1]), 'dueDate').click(); const dates = page.getByRole('dialog', { name: 'Edit dates', exact: true });
    await dates.getByLabel('Due date', { exact: true }).fill('2030-04-20'); await dates.getByRole('button', { name: 'Save', exact: true }).click(); await saved(page);
    expect(writes.commands).toHaveLength(1); assertBulk(requireValue(writes.commands[0]), f, selected, { dueDate: '2030-04-20' });
    const fresh = await confirmedHeads(f, selected, task => ({ id: task.id, revision: task.revision, dueDate: task.dueDate, startDate: task.startDate ?? null }), selected.map(task => ({ id: task.id, revision: task.revision + 1, dueDate: '2030-04-20', startDate: null })));
    await expect(dates).toHaveCount(0);
    await expect(cell(f, requireValue(selected[1]), 'dueDate')).toBeVisible();
    await row(f, requireValue(selected[0])).getByRole('button', { name: `Mark ${requireValue(selected[0]).title} complete`, exact: true }).click();
    await expect.poll(() => writes.commands.length).toBe(2); assertBulk(requireValue(writes.commands[1]), f, fresh, { statusId: f.doneId });
    await confirmedHeads(f, fresh, task => ({ id: task.id, revision: task.revision, statusId: task.statusId, dueDate: task.dueDate, startDate: task.startDate ?? null }), fresh.map(task => ({ id: task.id, revision: task.revision + 1, statusId: f.doneId, dueDate: '2030-04-20', startDate: null })));
    for (const task of selected) await expect(row(f, task).getByRole('button', { name: `Reopen ${task.title}`, exact: true })).toBeVisible();
    writes.close();
  });
  test('custom number and shared estimate use per-value and per-package guards without separate value writes', async ({ page }) => {
    const { f, selected } = await fixture(page, 'Native bulk custom estimate');
    const definition = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Team score', type: 'number', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data;
    const columns = (await apiRead(page, `${f.prefix}/projects/${f.projectId}/columns`, projectColumnsResponseSchema)).data;
    await apiWrite(page, `${f.prefix}/projects/${f.projectId}/columns`, { expectedRevision: columns.revision, columns: [{ fieldId: definition.id, position: 0, width: 160, visible: true }] }, projectColumnsResponseSchema, 'PATCH');
    await openTable(f); await showColumns(page, ['Team score']); await select(f, selected); const writes = observeCommands(page, f.prefix);
    await row(f, requireValue(selected[0])).getByRole('button', { name: `Edit Team score for ${requireValue(selected[0]).title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Edit Team score for ${requireValue(selected[0]).title}`, exact: true });
    await dialog.getByLabel('Team score', { exact: true }).fill('0'); await dialog.getByLabel('Team score', { exact: true }).press('Tab'); await saved(page);
    expect(writes.commands).toHaveLength(1); assertBulk(requireValue(writes.commands[0]), f, selected, { customField: { fieldId: definition.id, expectedDefinitionRevision: definition.revision, value: { type: 'number', value: 0 } } }, () => ({ expectedFieldValueRevision: 0 }));
    for (const task of selected) expect((await apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)).data.find(value => value.fieldId === definition.id)?.value).toEqual({ type: 'number', value: 0 });
    await cell(f, requireValue(selected[0]), 'estimate').click(); const estimate = row(f, requireValue(selected[0])).getByRole('textbox', { name: 'Team estimate (hours)', exact: true });
    await estimate.fill('2'); await estimate.press('Enter'); await expect.poll(() => writes.commands.length).toBe(2);
    assertBulk(requireValue(writes.commands[1]), f, selected, { estimateMinutes: 120 }, task => ({ expectedWorkPackageRevision: task.workPackageRevision }));
    await confirmedHeads(f, selected, task => ({ id: task.id, revision: task.revision, estimateMinutes: task.estimateMinutes, workPackageRevision: task.workPackageRevision }), selected.map(task => ({ id: task.id, revision: task.revision, estimateMinutes: 120, workPackageRevision: task.workPackageRevision + (task.estimateMinutes === 120 ? 0 : 1) })));
    await expect(estimate).toHaveCount(0);
    await expect(cell(f, requireValue(selected[0]), 'estimate')).toBeVisible();
    writes.close();
  });
  test('neutral Escape clears selection and picker Escape only closes the owned editor first', async ({ page }) => {
    const { f, selected } = await fixture(page, 'Native selection escape'); await openTable(f); await select(f, selected); const writes = observeCommands(page, f.prefix);
    await cell(f, requireValue(selected[0]), 'statusId').click(); await page.keyboard.press('Escape');
    for (const task of selected) await expect(gutter(page, task.title)).toHaveAttribute('aria-pressed', 'true');
    await gutter(page, requireValue(selected[1]).title).focus(); await page.keyboard.press('Escape');
    for (const task of selected) await expect(gutter(page, task.title)).toHaveAttribute('aria-pressed', 'false');
    expect(writes.commands).toHaveLength(0); writes.close();
  });
  test('a committed lost acknowledgement retains exact selected IDs, revisions, body and key across explicit retry', async ({ page }) => {
    const { f, selected, outside } = await fixture(page, 'Native bulk exact retry'); await openTable(f); await showColumns(page, ['Priority']); await select(f, selected);
    let lose = true; await page.route(`**${f.prefix}/tasks/bulk-update`, async route => { const response = await route.fetch(); expect(response.status()).toBe(200); if (lose) { lose = false; await route.abort('failed'); } else await route.fulfill({ response }); });
    const writes = observeCommands(page, f.prefix);
    await cell(f, requireValue(selected[0]), 'priority').click(); await page.getByRole('option', { name: 'High', exact: true }).click();
    const bar = page.getByRole('region', { name: 'Edit selected tasks', exact: true }); await expect(bar.getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    const blockedGutter = gutter(page, outside.title);
    await expect(blockedGutter).toHaveAttribute('aria-disabled', 'true');
    await blockedGutter.scrollIntoViewIfNeeded();
    const blockedBox = requireValue(await blockedGutter.boundingBox() ?? undefined);
    expect(await blockedGutter.evaluate(node => {
      const box = node.getBoundingClientRect();
      const hit = node.ownerDocument.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === node || hit !== null && node.contains(hit);
    })).toBe(true);
    await page.mouse.click(blockedBox.x + blockedBox.width / 2, blockedBox.y + blockedBox.height / 2);
    for (const task of selected) await expect(gutter(page, task.title)).toHaveAttribute('aria-pressed', 'true');
    await expect(gutter(page, outside.title)).toHaveAttribute('aria-pressed', 'false'); expect(writes.commands).toHaveLength(1);
    await bar.getByRole('button', { name: 'Retry original', exact: true }).click(); await expect.poll(() => writes.commands.length).toBe(2);
    expect(writes.commands[1]).toEqual(writes.commands[0]);
    await confirmedHeads(f, selected, task => ({ id: task.id, revision: task.revision, priority: task.priority }), selected.map(task => ({ id: task.id, revision: task.revision + 1, priority: 'high' })));
    await expect(gutter(page, outside.title)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(bar.getByRole('button', { name: 'Retry original', exact: true })).toHaveCount(0);
    writes.close();
  });
});
