// Private compiled native acceptance only. Real mouse/key input and actual guarded HTTP writes.
import { expect, test, type Page, type Locator } from '@playwright/test';
import { taskResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, allTasks, apiRead, center, choose, createFixtureTask, freshProject, manualOrder, openTable, savedRow, requireValue, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const responseAt = (method: string, path: string) => (response: { url(): string; request(): { method(): string } }) => response.request().method() === method && new URL(response.url()).pathname === path;
// Observe the rejection immediately so a failed mouse target does not create an orphan timeout.
const responseDuring = (page: Page, method: string, path: string) => page.waitForResponse(responseAt(method, path)).then(response => response, () => undefined);
const orderState = async (f: DailyProject) => manualOrder(await allTasks(f)).map(row => ({ id: row.id, position: row.position, responsibleMembershipId: row.responsibleMembershipId, statusId: row.statusId, sectionId: row.sectionId, parentTaskId: row.parentTaskId }));
async function drop(page: Page, handle: Locator, target: Locator, placement: 'before' | 'after', ghost: string) {
  const start = await center(handle); await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 9, start.y + 1);
  await expect(page.getByTestId(ghost)).toBeVisible(); await target.scrollIntoViewIfNeeded(); const rect = await target.boundingBox(); if (!rect) throw Error('Actual drop target unavailable');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + (placement === 'before' ? 4 : rect.height - 4), { steps: 8 });
}
async function undo(page: Page, f: DailyProject, taskId: string, focus: Locator) {
  // UI readiness in addition to the confirmed HTTP ACK: never mistake a pending preview for a saved command.
  await expect(focus).toBeEnabled(); await focus.focus(); const saved = responseDuring(page, 'POST', `${f.prefix}/tasks/${taskId}/restore-move`);
  await page.keyboard.press('ControlOrMeta+z'); expect(requireValue(await saved).status()).toBe(200);
}
test.describe('native confirmed task and Gantt drag Undo', () => {
  test.use({ viewport: { width: 1440, height: 1000 } }); test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Owned private compiled49318 and one worker required');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth trace/video forbidden');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  test('assignee table mouse move and keyboard Undo restore both person and complete order', async ({ page }) => {
    const f = await freshProject(page, provider, 'Undo assignee drag', true); const teammate = requireValue(f.teammates[0]);
    const a = await createFixtureTask(f, 'Move across assignees', { responsibleMembershipId: f.owner.id });
    await createFixtureTask(f, 'Keep owner row', { responsibleMembershipId: f.owner.id });
    const c = await createFixtureTask(f, 'Target other person', { responsibleMembershipId: teammate.id }); const original = await orderState(f);
    await openTable(f); await choose(page, page.getByRole('main'), 'Group by', 'Assignee');
    await expect(page.getByRole('combobox', { name: 'Group by', exact: true })).toHaveText('Assignee');
    await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveText('Manual');
    await expect(savedRow(page, a.id)).toBeVisible(); await expect(savedRow(page, c.id)).toBeVisible();
    const handle = savedRow(page, a.id).getByRole('button', { name: `Move task: ${a.title}`, exact: true });
    await expect(handle).toBeEnabled();
    const saved = responseDuring(page, 'POST', `${f.prefix}/tasks/${a.id}/move`);
    await drop(page, handle, savedRow(page, c.id), 'after', 'task-drag-preview'); await page.mouse.up();
    const response = requireValue(await saved); expect(response.status()).toBe(200); expect((await response.json()).data.moveUndo).toBeDefined();
    await expect.poll(async () => (await apiRead(page, `${f.prefix}/tasks/${a.id}`, taskResponseSchema)).data.responsibleMembershipId).toBe(teammate.id);
    await expect(savedRow(page, a.id).getByRole('button', { name: `Move task: ${a.title}`, exact: true })).toBeEnabled();
    await undo(page, f, a.id, savedRow(page, a.id).getByRole('button', { name: `Select task: ${a.title}`, exact: true }));
    await expect.poll(() => orderState(f)).toEqual(original);
  });
  test('Board mouse move and keyboard Undo restore lane and exact card order', async ({ page }) => {
    const f = await freshProject(page, provider, 'Undo Board drag');
    const a = await createFixtureTask(f, 'Board movable'); await createFixtureTask(f, 'Board stays');
    const c = await createFixtureTask(f, 'Board done anchor', { statusId: f.doneId }); const original = await orderState(f);
    await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=board`);
    const card = page.locator(`[data-board-card="${a.id}"]`); const saved = responseDuring(page, 'POST', `${f.prefix}/tasks/${a.id}/move`);
    await drop(page, card.getByRole('button', { name: `Drag task: ${a.title}`, exact: true }), page.locator(`[data-board-card="${c.id}"]`), 'before', 'board-drag-preview'); await page.mouse.up(); expect(requireValue(await saved).status()).toBe(200);
    await expect(page.locator(`[data-board-status="${f.doneId}"] [data-board-card="${a.id}"]`)).toBeVisible();
    await expect(card.getByRole('button', { name: `Drag task: ${a.title}`, exact: true })).toBeEnabled();
    await undo(page, f, a.id, card.getByRole('button', { name: a.title, exact: true })); await expect.poll(() => orderState(f)).toEqual(original);
  });
  test('Gantt mouse range move and keyboard Undo restore the original nullable date pair', async ({ page }) => {
    const f = await freshProject(page, provider, 'Undo Gantt drag');
    const a = await createFixtureTask(f, 'Due-only movable', { dueDate: '2035-04-06' });
    await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=gantt`);
    const timeline = page.getByRole('region', { name: 'Project timeline', exact: true }); await expect(timeline).toBeVisible();
    await timeline.getByRole('combobox', { name: 'Days in window', exact: true }).selectOption('28'); await timeline.getByLabel('Window start', { exact: true }).fill('2035-04-01');
    const bar = timeline.locator(`[data-gantt-movable="${a.id}"]`); const start = await center(bar);
    const forward = responseDuring(page, 'POST', `${f.prefix}/projects/${f.projectId}/schedule-apply`);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(start.x + 72, start.y, { steps: 8 }); await expect(page.getByTestId('gantt-date-move-ghost')).toBeVisible(); await page.mouse.up(); expect(requireValue(await forward).status()).toBe(200);
    await expect.poll(async () => (await apiRead(page, `${f.prefix}/tasks/${a.id}`, taskResponseSchema)).data.dueDate).toBe('2035-04-08'); await expect(bar).toBeVisible();
    await timeline.getByRole('button', { name: a.title, exact: true }).focus(); const inverse = responseDuring(page, 'POST', `${f.prefix}/projects/${f.projectId}/schedule-apply`); await page.keyboard.press('ControlOrMeta+z'); expect(requireValue(await inverse).status()).toBe(200);
    await expect.poll(async () => { const row = (await apiRead(page, `${f.prefix}/tasks/${a.id}`, taskResponseSchema)).data; return { startDate: row.startDate, dueDate: row.dueDate }; }).toEqual({ startDate: null, dueDate: '2035-04-06' });
  });
});
