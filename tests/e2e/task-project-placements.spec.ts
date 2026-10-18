// Source-only packet. Root-owned compiled QA49318 + fake Auth49319 + throwaway PG60651 only.
// Four finite cases: two scenarios at 1440 and 390; both themes checked within each case.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import {
  manualPeriodWorkLogListResponseSchema, manualPeriodWorkLogResponseSchema,
  planningPeriodResponseSchema, projectResponseSchema, projectRowsResponseSchema,
  taskProjectPlacementResponseSchema, taskProjectPlacementsResponseSchema,
  taskResponseSchema, taskStatusListResponseSchema,
  type TaskDto,
} from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import {
  PRIVATE_APP as APP, allTasks, apiRead, apiWrite, createFixtureTask, freshProject,
  observeCommands, requireValue, savedRow, type DailyProject,
} from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const pane = (page: Page) => page.locator('[data-task-panel][data-state="open"]');
const projectUrl = (f: DailyProject, projectId: string, extra = '') => `${APP}/app/w/${f.workspaceId}/projects/${projectId}?view=table${extra}`;
const readTask = async (f: DailyProject, id: string) => (await apiRead(f.page, `${f.prefix}/tasks/${id}`, taskResponseSchema)).data;
const placements = async (f: DailyProject, id: string) => (await apiRead(f.page, `${f.prefix}/tasks/${id}/placements`, taskProjectPlacementsResponseSchema)).data;
const projectRows = async (f: DailyProject, projectId: string) => {
  const result = await apiRead(f.page, `${f.prefix}/projects/${projectId}/rows?limit=100`, projectRowsResponseSchema);
  expect(result.meta.nextCursor ?? null).toBeNull(); return result.data;
};
function stableTask(task: TaskDto) {
  const { statusId: _status, revision: _revision, updatedAt: _updated, ...rest } = task; return rest;
}
async function openByUrl(f: DailyProject, projectId: string, task: TaskDto) {
  await f.page.goto(projectUrl(f, projectId, `&task=${task.id}`));
  await expect(pane(f.page).getByLabel('Task name', { exact: true })).toHaveValue(task.title);
}
async function closePane(page: Page) {
  await pane(page).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(pane(page)).toHaveCount(0);
}
async function addProject(page: Page, name: string) {
  const picker = pane(page).getByRole('combobox', { name: 'Add to project', exact: true });
  await expect(picker).toBeEnabled(); await picker.click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(pane(page).getByRole('button', { name: `Remove from ${name}`, exact: true })).toBeVisible();
}
async function assertThemesAndFit(page: Page, width: number) {
  const wasOpen = await pane(page).count() > 0;
  const taskId = new URL(page.url()).searchParams.get('task');
  const title = wasOpen ? await pane(page).getByLabel('Task name', { exact: true }).inputValue() : null;
  const reopen = async () => {
    if (!wasOpen || !taskId || title === null) return;
    const homeRow = page.locator(`[data-task-open-area="${taskId}"]`);
    if (await homeRow.count()) await homeRow.click();
    else await page.locator('tr[data-placement-id]').getByRole('button', { name: title, exact: true }).click();
    await expect(pane(page).getByLabel('Task name', { exact: true })).toHaveValue(title);
  };
  // On mobile the task pane is modal; toggle the actual global theme control between opens.
  if (wasOpen) await closePane(page);
  for (const dark of [false, true]) {
    const button = page.getByRole('button', { name: 'Dark theme', exact: true });
    if (await button.getAttribute('aria-pressed') !== String(dark)) await button.click();
    await reopen();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    if (wasOpen) {
      const panel = pane(page);
      // Visibility precedes the intentional slide completing; poll its real bounds and animation.
      await expect.poll(async () => {
        const box = await panel.boundingBox();
        const settled = await panel.evaluate(node => node.getAnimations().every(animation => !animation.pending && animation.playState !== 'running'));
        return box !== null && settled && box.x >= -1 && box.x + box.width <= width + 1;
      }).toBe(true);
      const box = requireValue(await panel.boundingBox() ?? undefined);
      expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      await expect(panel.getByLabel('Description', { exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      expect(await panel.textContent()).not.toMatch(/\{\{?p[01]/);
      await closePane(page);
    }
  }
  await reopen();
}
async function fixture(page: Page, label: string) {
  const f = await freshProject(page, provider, label);
  const home = (await apiRead(page, `${f.prefix}/projects/${f.projectId}`, projectResponseSchema)).data;
  const target = (await apiWrite(page, `${f.prefix}/projects`, { name: `Linked ${randomUUID().slice(0, 8)}` }, projectResponseSchema)).data;
  const targetStatuses = (await apiRead(page, `${f.prefix}/projects/${target.id}/statuses`, taskStatusListResponseSchema)).data;
  const task = await createFixtureTask(f, 'One canonical shared task', { responsibleMembershipId: f.owner.id, participantMembershipIds: [f.owner.id], estimateMinutes: 120, startDate: '2027-05-03', dueDate: '2027-05-06' });
  const period = async (projectId: string) => (await apiWrite(page, `${f.prefix}/periods`, { projectId, name: 'Placement accounting week', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
  const homePeriod = await period(f.projectId), targetPeriod = await period(target.id);
  const response = await page.request.put(`${APP}${f.prefix}/tasks/${task.id}/manual-period-work/${homePeriod.id}/${f.owner.id}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data: { expectedRevision: null, minutes: 90, state: 'active' } });
  expect(response.status()).toBe(200);
  const fact = manualPeriodWorkLogResponseSchema.parse(await response.json()).data;
  const facts = async (periodId: string) => {
    const result = await apiRead(page, `${f.prefix}/worklogs?periodId=${periodId}&limit=100`, manualPeriodWorkLogListResponseSchema);
    expect(result.meta.nextCursor ?? null).toBeNull(); return result.data;
  };
  const noCopiesOrHours = async () => {
    const canonical = (await allTasks(f)).filter(row => row.id === task.id);
    expect(canonical).toHaveLength(1); expect(canonical[0]?.projectId).toBe(f.projectId);
    const targetTasks = await allTasks({ ...f, projectId: target.id });
    expect(targetTasks.some(row => row.id === task.id || row.workPackageId === task.workPackageId)).toBe(false);
    expect(await facts(homePeriod.id)).toEqual([fact]); expect(await facts(targetPeriod.id)).toEqual([]);
  };
  return { f, home, target, targetStatuses, task, noCopiesOrHours };
}

test.describe('one canonical task in multiple projects', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);
  test.beforeAll(async ({ baseURL }, info) => {
    if (process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Guarded private QA49318 with one worker is required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Private Auth requires trace/video off.');
    requirePrivateMembershipDatabase();
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  for (const width of [1440, 390]) test.describe(`project placements ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test('attaches, shares one home status across two pages after ACK, detaches/restores without copying tasks or hours', async ({ page }, info) => {
      const { f, home, target, targetStatuses, task, noCopiesOrHours } = await fixture(page, `Placements ${width}`);
      const second = await page.context().newPage(); await second.setViewportSize({ width, height: 1000 });
      await second.goto(projectUrl(f, target.id));
      await expect(second.getByRole('heading', { name: target.name, exact: true })).toBeVisible();
      await openByUrl(f, f.projectId, task);
      await expect(pane(page).getByRole('button', { name: `Remove from ${home.name}`, exact: true })).toHaveCount(0);
      const homeWrites = observeCommands(page, f.prefix);
      await addProject(page, target.name);
      const attached = requireValue((await placements(f, task.id)).find(item => item.projectId === target.id && item.archivedAt === null));
      expect(attached.taskId).toBe(task.id); expect(attached.homeProjectId).toBe(f.projectId);
      expect(homeWrites.commands.filter(command => command.path === `${f.prefix}/tasks/${task.id}/placements`)).toHaveLength(1);
      await closePane(page); await second.bringToFront();
      const linked = second.locator(`tr[data-placement-id="${attached.id}"]`);
      await expect(linked.getByRole('link', { name: home.name, exact: true })).toHaveAttribute('href', `/app/w/${f.workspaceId}/projects/${f.projectId}?task=${task.id}`);
      await expect(linked.getByRole('button', { name: task.title, exact: true })).toBeVisible();
      await linked.getByRole('button', { name: task.title, exact: true }).click();
      await expect(pane(second).getByLabel('Task name', { exact: true })).toHaveValue(task.title);
      await expect(pane(second).getByRole('button', { name: 'Add subtask', exact: true })).toHaveCount(0);
      await expect(pane(second).getByRole('link', { name: 'Open home project', exact: true })).toHaveAttribute('href', `/app/w/${f.workspaceId}/projects/${f.projectId}?task=${task.id}`);
      await assertThemesAndFit(second, width);
      await second.screenshot({ path: info.outputPath(`linked-pane-${width}.png`) });
      const before = await readTask(f, task.id), done = requireValue(f.statuses.find(status => status.group === 'done'));
      expect(targetStatuses.some(status => status.id === done.id)).toBe(false);
      const writes = observeCommands(second, f.prefix);
      let release: () => void = () => undefined, stored: () => void = () => undefined;
      const hold = new Promise<void>(resolve => { release = resolve; }), committed = new Promise<void>(resolve => { stored = resolve; });
      const path = `${f.prefix}/tasks/${task.id}`;
      const matches = (url: URL) => url.pathname === path;
      const handler = async (route: Route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        const response = await route.fetch(); expect(response.status()).toBe(200); stored(); await hold; await route.fulfill({ response });
      };
      await second.route(matches, handler);
      try {
        await pane(second).getByRole('combobox', { name: 'Status', exact: true }).click();
        for (const status of targetStatuses) await expect(second.getByRole('option', { name: status.name, exact: true })).toHaveCount(f.statuses.some(home => home.name === status.name) ? 1 : 0);
        await second.getByRole('option', { name: done.name, exact: true }).click(); await committed;
        await expect(linked.locator('td').nth(1)).toHaveText(requireValue(f.statuses.find(status => status.id === before.statusId)).name);
        expect(writes.commands).toHaveLength(1);
        expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: before.revision, statusId: done.id });
        release();
        await expect(linked.locator('td').nth(1)).toHaveText(done.name);
        await closePane(second); await page.bringToFront();
        await expect(savedRow(page, task.id).locator(`button[data-task-cell="${task.id}:statusId"]`)).toContainText(done.name);
        const homeRows = await projectRows(f, f.projectId), targetRows = await projectRows(f, target.id);
        expect(homeRows.filter(row => row.canonicalTask.id === task.id)).toHaveLength(1); expect(targetRows.filter(row => row.canonicalTask.id === task.id)).toHaveLength(1);
        expect(homeRows.find(row => row.canonicalTask.id === task.id)?.canonicalStatus.id).toBe(done.id);
        expect(targetRows.find(row => row.canonicalTask.id === task.id)?.canonicalStatus.id).toBe(done.id);
        expect(stableTask(await readTask(f, task.id))).toEqual(stableTask(before));
        await noCopiesOrHours();
      } finally { release(); await second.unroute(matches, handler); writes.close(); }
      await second.bringToFront(); await linked.getByRole('button', { name: `Remove from ${target.name}`, exact: true }).click();
      await expect(linked).toHaveCount(0); expect((await readTask(f, task.id)).statusId).toBe(done.id);
      const removed = requireValue((await placements(f, task.id)).find(item => item.id === attached.id)); expect(removed.archivedAt).not.toBeNull();
      await page.bringToFront(); await openByUrl(f, f.projectId, await readTask(f, task.id));
      await pane(page).getByRole('button', { name: `Restore to ${target.name}`, exact: true }).click();
      await expect(pane(page).getByRole('button', { name: `Remove from ${target.name}`, exact: true })).toBeVisible();
      await closePane(page); await second.bringToFront(); await expect(linked).toBeVisible();
      expect((await placements(f, task.id)).filter(item => item.projectId === target.id && item.archivedAt === null)).toHaveLength(1);
      await noCopiesOrHours(); await assertThemesAndFit(second, width); homeWrites.close(); await second.close();
    });

    test('retains an unknown detach across Close and another task; retry preserves exact key/body and home accounting', async ({ page }) => {
      const { f, target, task, noCopiesOrHours } = await fixture(page, `Unknown placements ${width}`);
      const attached = (await apiWrite(page, `${f.prefix}/tasks/${task.id}/placements`, { projectId: target.id, expectedTaskRevision: task.revision }, taskProjectPlacementResponseSchema)).data;
      const targetTodo = requireValue((await apiRead(page, `${f.prefix}/projects/${target.id}/statuses`, taskStatusListResponseSchema)).data.find(status => status.group === 'todo'));
      const another = await createFixtureTask({ ...f, projectId: target.id, todoId: targetTodo.id }, 'Another target task');
      const before = await readTask(f, task.id), path = `${f.prefix}/task-project-placements/${attached.id}/detach`;
      let lose = true;
      const matches = (url: URL) => url.pathname === path;
      const handler = async (route: Route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch(); expect(response.status()).toBe(200);
        if (lose) { lose = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Private test lost ACK.' }, meta: { requestId: 'placement-ack' } }) }); }
        await route.fulfill({ response });
      };
      await page.route(matches, handler); await openByUrl(f, target.id, task); await assertThemesAndFit(page, width);
      const writes = observeCommands(page, f.prefix);
      try {
        await pane(page).getByRole('button', { name: `Remove from ${target.name}`, exact: true }).click();
        await expect(page.getByRole('button', { name: 'Retry original change', exact: true })).toBeAttached();
        await closePane(page); await savedRow(page, another.id).locator(`[data-task-open-area="${another.id}"]`).click();
        await expect(pane(page).getByLabel('Task name', { exact: true })).toHaveValue(another.title); await closePane(page);
        expect(writes.commands).toHaveLength(1); expect(await readTask(f, task.id)).toEqual(before);
        await page.getByRole('button', { name: 'Retry original change', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Retry original change', exact: true })).toHaveCount(0);
        expect(writes.commands).toHaveLength(2); expect(writes.commands[1]).toEqual(writes.commands[0]);
        expect(requireValue(writes.commands[0])).toMatchObject({ method: 'POST', path });
        expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: attached.revision });
        expect(requireValue(writes.commands[0]).key).toMatch(/^[0-9a-f-]{36}$/i);
        expect((await placements(f, task.id)).find(item => item.id === attached.id)?.archivedAt).not.toBeNull();
        expect(await readTask(f, task.id)).toEqual(before); await noCopiesOrHours(); await assertThemesAndFit(page, width);
      } finally { await page.unroute(matches, handler); writes.close(); }
    });
  });
});
