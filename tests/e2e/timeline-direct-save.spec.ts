// Source-authored private Chrome acceptance. Root owns API/PG lifecycle; this file starts only
// the in-memory fake shared-Auth provider. Every task belongs to a fresh real private-QA owner.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { taskDependencyResponseSchema, taskResponseSchema, type TaskDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { privateBrowserPhase } from './support/private-browser-diagnostics.js';
import { allTasks, apiWrite, createFixtureTask, freshProject, observeCommands, PRIVATE_APP, requireValue, type DailyProject } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const timeline = (page: Page) => page.getByRole('region', { name: 'Project timeline', exact: true });
const row = (page: Page, task: TaskDto) => timeline(page).getByRole('group', { name: `Calendar dates: ${task.title}`, exact: true });
const body = (page: Page, task: TaskDto) => timeline(page).locator(`[data-gantt-anchor="${task.id}"] [data-gantt-move-handle]`);
const movable = (page: Page, task: TaskDto) => timeline(page).locator(`[data-gantt-movable="${task.id}"]`);
const ghost = (page: Page) => page.getByTestId('gantt-date-move-ghost');
const manualDialog = (page: Page) => page.getByRole('dialog', { name: 'Edit task dates', exact: true });
const previewPath = (f: DailyProject) => `${f.prefix}/projects/${f.projectId}/schedule-preview`;
const applyPath = (f: DailyProject) => `${f.prefix}/projects/${f.projectId}/schedule-apply`;
const taskById = async (f: DailyProject, id: string) => requireValue((await allTasks(f)).find(task => task.id === id));
const conserved = (task: TaskDto) => ({ title: task.title, statusId: task.statusId, parentTaskId: task.parentTaskId, sectionId: task.sectionId,
  estimateMinutes: task.estimateMinutes, workPackageId: task.workPackageId, workPackageRevision: task.workPackageRevision, participantsRevision: task.participantsRevision });
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function open(f: DailyProject) {
  await f.page.goto(`${PRIVATE_APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=gantt`);
  await expect(timeline(f.page)).toBeVisible();
  const zoom = timeline(f.page).getByRole('combobox', { name: 'Days in window', exact: true });
  await expect(zoom).toBeVisible();
  await zoom.selectOption('28');
  await timeline(f.page).getByLabel('Window start', { exact: true }).fill('2035-05-01');
  await expect(timeline(f.page).getByRole('list', { name: 'Calendar window days' }).getByRole('listitem').first()).toHaveAttribute('title', '2035-05-01');
}
async function point(locator: Locator) {
  const box = await locator.boundingBox(); if (!box) throw new Error('Saved Gantt body is not visible.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function begin(f: DailyProject, task: TaskDto, days: number) {
  const target = movable(f.page, task); await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded();
  const pitch = await timeline(f.page).getByRole('list', { name: 'Calendar window days' }).getByRole('listitem').evaluateAll(nodes => {
    const first = nodes[0], second = nodes[1]; if (!first || !second) throw new Error('Day axis missing.');
    return second.getBoundingClientRect().left - first.getBoundingClientRect().left;
  });
  expect(pitch).toBe(36);
  // Expose enough real horizontal scrollport for the whole gesture before capture (notably the 390px diamond).
  const calendar = timeline(f.page).locator('[aria-label="Loaded task calendar"]');
  const frame = await calendar.boundingBox(), label = await row(f.page, task).locator(':scope > div').first().boundingBox();
  if (!frame || !label) throw new Error('Timeline scrollport or sticky task label is not visible.');
  const fromBeforeScroll = await point(target), delta = days * pitch;
  const min = label.x + label.width + 12 + Math.max(0, -delta), max = frame.x + frame.width - 12 - Math.max(0, delta);
  if (min > max) throw new Error('The requested pointer gesture does not fit the actual visible track.');
  const desired = Math.min(max, Math.max(min, fromBeforeScroll.x));
  if (Math.abs(fromBeforeScroll.x - desired) > 1) {
    await calendar.hover(); await f.page.mouse.wheel(fromBeforeScroll.x - desired, 0);
    await expect.poll(async () => Math.abs((await point(target)).x - desired)).toBeLessThanOrEqual(1);
    await expect.poll(() => calendar.evaluate(element => new Promise<boolean>(resolve => {
      const before = element.scrollLeft; requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollLeft === before)));
    }))).toBe(true);
  }
  const from = await point(target), to = { x: from.x + delta, y: from.y };
  expect(from.x).toBeGreaterThanOrEqual(label.x + label.width + 8); expect(to.x).toBeGreaterThanOrEqual(label.x + label.width + 8);
  expect(from.x).toBeLessThanOrEqual(frame.x + frame.width - 8); expect(to.x).toBeLessThanOrEqual(frame.x + frame.width - 8);
  await f.page.mouse.move(from.x, from.y); await f.page.mouse.down(); await f.page.mouse.move(to.x, to.y, { steps: 12 });
  await expect(row(f.page, task).getByTestId('gantt-date-move-ghost')).toHaveCount(1); return to;
}
async function drag(f: DailyProject, task: TaskDto, days: number) { await begin(f, task, days); await f.page.mouse.up(); }
async function dates(f: DailyProject, task: TaskDto, startDate: string | null, dueDate: string | null) {
  await expect.poll(async () => { const saved = await taskById(f, task.id); return { startDate: saved.startDate, dueDate: saved.dueDate }; }).toEqual({ startDate, dueDate });
  const saved = await taskById(f, task.id); expect(conserved(saved)).toEqual(conserved(task)); return saved;
}
function latch() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test.describe('Timeline direct save', () => {
  test.describe.configure({ mode: 'serial' });
  test.beforeAll(async ({ baseURL }) => {
    if (baseURL !== PRIVATE_APP || process.env.WORKLOOM_QA_BASE_URL !== PRIVATE_APP) throw new Error('Explicit private compiled QA origin is required.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: PRIVATE_APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  test('range release saves directly; held ghost preserves saved dates, next drag works, click and keyboard open the task', async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const f = await freshProject(page, provider, 'Timeline direct range');
    const task = await createFixtureTask(f, 'Range', { startDate: '2035-05-03', dueDate: '2035-05-05', estimateMinutes: 90 });
    const successor = await createFixtureTask(f, 'Dependent range', { startDate: '2035-05-07', dueDate: '2035-05-10', estimateMinutes: 30 });
    const dependency = (await apiWrite(page, `${f.prefix}/dependencies`, { predecessorTaskId: task.id, successorTaskId: successor.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data;
    await open(f);
    const theme = page.getByRole('button', { name: 'Dark theme', exact: true });
    if (await theme.getAttribute('aria-pressed') === 'true') await theme.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const observed = observeCommands(page, f.prefix);
    await begin(f, task, 3);
    expect((await taskById(f, task.id)).startDate).toBe('2035-05-03');
    await expect(body(page, task)).toHaveAttribute('aria-label', /start 2035-05-03, due 2035-05-05/);
    expect(observed.commands).toEqual([]);
    await page.screenshot({ path: info.outputPath('held-range.png') }); await page.mouse.up();
    await dates(f, task, '2035-05-06', '2035-05-08'); await expect(ghost(page)).toHaveCount(0); await expect(manualDialog(page)).toHaveCount(0);
    const warningArrow = timeline(page).locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(warningArrow).toHaveAttribute('data-state', 'conflict');
    await expect(warningArrow.locator('path').first()).toHaveAttribute('stroke', 'var(--color-gantt-conflict)');
    await expect.poll(async () => conserved(await taskById(f, successor.id))).toEqual(conserved(successor));
    expect({ startDate: (await taskById(f, successor.id)).startDate, dueDate: (await taskById(f, successor.id)).dueDate }).toEqual({ startDate: '2035-05-07', dueDate: '2035-05-10' });
    expect(observed.commands.map(command => command.path)).toEqual([previewPath(f), applyPath(f)]);
    const first = JSON.parse(requireValue(observed.commands[1]).body) as { rows: unknown[]; previewHash: string };
    expect(first.rows).toEqual([{ taskId: task.id, expectedRevision: task.revision, startDate: '2035-05-06', dueDate: '2035-05-08' }]);
    expect(first.previewHash).toMatch(/^[a-f0-9]{64}$/); expect(requireValue(observed.commands[1]).key).toBeTruthy();
    await drag(f, task, 1); await dates(f, task, '2035-05-07', '2035-05-09'); await expect(ghost(page)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('saved-timeline-light-1440.png') });
    await theme.click(); await expect(theme).toHaveAttribute('aria-pressed', 'true'); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await frames(page); await page.screenshot({ path: info.outputPath('saved-timeline-dark-1440.png') });
    await privateBrowserPhase(page, 'timeline.bar-open', () => body(page, task).click());
    const pane = page.getByRole('dialog', { name: task.title, exact: true });
    await privateBrowserPhase(page, 'timeline.pane-visible', () => expect(pane).toBeVisible());
    const name = pane.getByRole('textbox', { name: 'Task name', exact: true });
    await privateBrowserPhase(page, 'timeline.focus', () => name.focus());
    await privateBrowserPhase(page, 'timeline.escape', () => name.press('Escape'));
    await privateBrowserPhase(page, 'timeline.pane-closed', () => expect(pane).toHaveCount(0));
    await privateBrowserPhase(page, 'timeline.keyboard-focus', () => body(page, task).focus());
    await privateBrowserPhase(page, 'timeline.keyboard-open', () => page.keyboard.press('Enter'));
    await privateBrowserPhase(page, 'timeline.keyboard-visible', () => expect(pane).toBeVisible());
    expect(observed.commands.filter(command => command.path === applyPath(f))).toHaveLength(2); observed.close();
  });

  test('fast unsent moves coalesce by immutable source and different tasks serialize without confirmation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const f = await freshProject(page, provider, 'Timeline queue');
    const a = await createFixtureTask(f, 'Queued A', { startDate: '2035-05-03', dueDate: '2035-05-05' });
    const b = await createFixtureTask(f, 'Queued B', { startDate: '2035-05-06', dueDate: '2035-05-08' });
    await open(f); const observed = observeCommands(page, f.prefix), held = latch(); let previews = 0;
    const previewHandlers: Promise<void>[] = [];
    await page.route(`**${previewPath(f)}`, route => {
      const handled = (async () => { const response = await route.fetch(); if (++previews === 1) await held.promise; await route.fulfill({ response }); })();
      previewHandlers.push(handled);
      return handled;
    });
    try {
      await drag(f, a, 1); await expect.poll(() => previews).toBe(1);
      await drag(f, a, 3); await drag(f, b, 2);
      expect(observed.commands.filter(command => command.path === applyPath(f))).toHaveLength(0); await expect(manualDialog(page)).toHaveCount(0);
      held.release(); await dates(f, a, '2035-05-06', '2035-05-08'); await dates(f, b, '2035-05-08', '2035-05-10');
      await expect(ghost(page)).toHaveCount(0);
      const writes = observed.commands.filter(command => command.path === applyPath(f)); expect(writes).toHaveLength(2);
      expect(writes.map(command => (JSON.parse(command.body) as { rows: { taskId: string }[] }).rows[0]?.taskId)).toEqual([a.id, b.id]);
      expect((JSON.parse(requireValue(writes[0]).body) as { rows: unknown[] }).rows).toEqual([{ taskId: a.id, expectedRevision: a.revision, startDate: '2035-05-06', dueDate: '2035-05-08' }]);
    } finally {
      held.release();
      // Finish our intercepted response before removing its handler, including on an assertion failure.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(previewHandlers),
          new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Held preview route did not finish after release.')), 5_000); }),
        ]);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        await page.unroute(`**${previewPath(f)}`);
        observed.close();
      }
    }
  });

  test('a retained manual draft blocks only its own task and preserves its exact dates while another bar saves', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const f = await freshProject(page, provider, 'Timeline retained dates');
    const a = await createFixtureTask(f, 'Retained A', { startDate: '2035-05-03', dueDate: '2035-05-05' });
    const b = await createFixtureTask(f, 'Movable B', { startDate: '2035-05-06', dueDate: '2035-05-08' });
    await open(f); const observed = observeCommands(page, f.prefix);
    await row(page, a).getByRole('button', { name: 'Edit dates', exact: true }).click();
    await manualDialog(page).getByLabel('Start date', { exact: true }).fill('2035-05-04');
    await manualDialog(page).getByLabel('Close', { exact: true }).click();
    await expect(movable(page, a)).toHaveCount(0); await expect(movable(page, b)).toBeVisible();
    await drag(f, b, 2); await dates(f, b, '2035-05-08', '2035-05-10');
    expect((await taskById(f, a.id)).startDate).toBe('2035-05-03');
    await page.getByRole('button', { name: 'Continue date draft', exact: true }).click();
    await expect(manualDialog(page).getByLabel('Start date', { exact: true })).toHaveValue('2035-05-04');
    await expect(manualDialog(page).getByLabel('Due date', { exact: true })).toHaveValue('2035-05-05');
    expect(observed.commands.filter(command => command.path === applyPath(f))).toHaveLength(1); observed.close();
  });

  test('a lost committed acknowledgement holds the exact move; explicit retry preserves newer authoritative dates', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const f = await freshProject(page, provider, 'Timeline unknown');
    const a = await createFixtureTask(f, 'Unknown A', { startDate: '2035-05-03', dueDate: '2035-05-05' });
    const b = await createFixtureTask(f, 'Blocked B', { startDate: '2035-05-06', dueDate: '2035-05-08' });
    await open(f); const observed = observeCommands(page, f.prefix); let sends = 0;
    await page.route(`**${applyPath(f)}`, async route => { const response = await route.fetch(); if (++sends === 1) await route.abort('failed'); else await route.fulfill({ response }); });
    try {
      await drag(f, a, 2); await expect(page.getByRole('button', { name: 'Retry original date submission', exact: true })).toBeVisible();
      const committed = await dates(f, a, '2035-05-05', '2035-05-07'); await expect(movable(page, b)).toHaveCount(0);
      const at = await point(body(page, b)); await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 72, at.y, { steps: 8 }); await page.mouse.up(); await frames(page);
      expect(observed.commands.filter(command => command.path === applyPath(f))).toHaveLength(1);
      expect(observed.commands).toHaveLength(2); await expect(ghost(page)).toHaveCount(1);
      const newer = (await apiWrite(page, `${f.prefix}/tasks/${a.id}`, { expectedRevision: committed.revision, startDate: '2035-05-09', dueDate: '2035-05-11' }, taskResponseSchema, 'PATCH')).data;
      await page.getByRole('button', { name: 'Retry original date submission', exact: true }).click();
      await expect.poll(() => sends).toBe(2); await expect(ghost(page)).toHaveCount(0);
      const writes = observed.commands.filter(command => command.path === applyPath(f)); expect(writes).toHaveLength(2);
      expect(writes[1]?.body).toBe(writes[0]?.body); expect(writes[1]?.key).toBe(writes[0]?.key);
      expect(await taskById(f, a.id)).toEqual(newer); await expect(movable(page, b)).toBeVisible();
      await expect(manualDialog(page)).toHaveCount(0);
    } finally { await page.unroute(`**${applyPath(f)}`); observed.close(); }
  });

  test('visible due-only diamonds keep neutral dependency arrows; Escape cancels without writes and a point saves with start still null', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await freshProject(page, provider, 'Timeline point arrow');
    const a = await createFixtureTask(f, 'Predecessor point', { startDate: null, dueDate: '2035-05-03', estimateMinutes: 30 });
    const b = await createFixtureTask(f, 'Successor point', { startDate: null, dueDate: '2035-05-08', estimateMinutes: 45 });
    const dependency = (await apiWrite(page, `${f.prefix}/dependencies`, { predecessorTaskId: a.id, successorTaskId: b.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data;
    await open(f); const observed = observeCommands(page, f.prefix), arrow = timeline(page).locator(`[data-dependency-id="${dependency.id}"]`);
    await expect(arrow).toBeVisible(); await expect(arrow).toHaveAttribute('data-state', 'neutral'); await expect(arrow.locator('path')).toHaveCount(2);
    const path = await arrow.locator('path').first().getAttribute('d'); await begin(f, b, 2);
    await expect(arrow.locator('path').first()).toHaveAttribute('d', requireValue(path ?? undefined));
    await page.screenshot({ path: info.outputPath('point-arrow-held.png') }); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(ghost(page)).toHaveCount(0); expect(observed.commands).toEqual([]);
    await drag(f, b, 3); await dates(f, b, null, '2035-05-11'); await expect(ghost(page)).toHaveCount(0);
    await expect(arrow).toHaveAttribute('data-state', 'neutral'); expect(observed.commands.filter(command => command.path === applyPath(f))).toHaveLength(1); observed.close();
  });
});
