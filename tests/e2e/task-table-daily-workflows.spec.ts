// Private compiled Chrome gate: actual shared-Auth cookie/API/JWKS and root-owned throwaway PG.
// No app server/DB lifecycle here. Auth tokens are never captured; traces/video must remain off.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  manualPeriodWorkLogListResponseSchema, periodCommitmentListResponseSchema, periodCommitmentResponseSchema,
  planningPeriodResponseSchema, tagResponseSchema, type TaskDto,
} from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import {
  PRIVATE_APP as APP, allTasks, apiRead, apiWrite, center, choose, createFixtureTask, freshProject,
  manualOrder, observeCommands, openTable, requireValue, savedRow, showColumns, type DailyProject,
} from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const preview = (page: Page) => page.getByTestId('task-drag-preview');
const gutter = (page: Page, title: string) => page.getByRole('button', { name: `Select task: ${title}`, exact: true });
const bulkRegion = (page: Page) => page.getByRole('region', { name: 'Edit selected tasks', exact: true });
const group = (page: Page, memberId: string | null) => page.locator(`tbody[data-task-assignee-group="${memberId ?? ''}"]`);
const ids = (rows: readonly TaskDto[]) => manualOrder(rows).map(row => row.id);
const titles = (rows: readonly TaskDto[]) => manualOrder(rows).map(row => row.title);
function unchangedData(task: TaskDto, assignment = false) {
  const { position: _position, revision: _revision, updatedAt: _updatedAt, ...rest } = task;
  if (!assignment) return rest;
  const { responsibleMembershipId: _responsible, ...other } = rest; return other;
}
async function picture(page: Page, info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`) }); }
async function titleCell(scope: Page | Locator, id: string) { const cell = scope.locator(`tr[data-task-row="${id}"] > td:first-child`); await cell.scrollIntoViewIfNeeded(); return cell; }
async function dropPoint(scope: Page | Locator, id: string, placement: 'before' | 'after') {
  const box = await (await titleCell(scope, id)).boundingBox();
  if (!box) throw new Error('Saved title cell is not visible.');
  return { x: box.x + box.width / 2, y: box.y + box.height * (placement === 'before' ? 0.25 : 0.75) };
}
async function beginDrag(page: Page, sourceId: string, scope: Page | Locator = page) {
  await (await titleCell(scope, sourceId)).hover();
  const handle = scope.locator(`[data-task-move-handle="${sourceId}"]`); await expect(handle).toBeEnabled();
  await expect(handle).not.toHaveAttribute('aria-disabled', 'true');
  const from = await center(handle); await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(from.x + 9, from.y + 9, { steps: 3 });
  await expect(preview(page)).toHaveAttribute('data-task-drag-preview', sourceId); await expect(preview(page)).toBeVisible();
  return from;
}
async function move(page: Page, sourceId: string, targetId: string, placement: 'before' | 'after', scope: Page | Locator = page) {
  const destination = await dropPoint(scope, targetId, placement); await beginDrag(page, sourceId, scope);
  try { await page.mouse.move(destination.x, destination.y, { steps: 12 }); } finally { await page.mouse.up(); }
  await expect(preview(page)).toHaveCount(0);
}
async function selected(page: Page): Promise<string[]> {
  return page.locator('[data-task-select][aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-select') ?? ''));
}
async function selectRange(page: Page, from: string, to: string) {
  await gutter(page, from).click(); await gutter(page, to).click({ modifiers: ['Shift'] });
}
async function datePopup(page: Page, row: Locator, start: string, due: string) {
  await row.locator('button[data-task-cell$=":dueDate"]').click();
  const popup = page.getByRole('dialog', { name: 'Edit dates', exact: true }); await expect(popup).toBeVisible();
  if (await popup.getByLabel('Start date', { exact: true }).count() === 0) await popup.getByRole('button', { name: '+ Start date', exact: true }).click();
  await popup.getByLabel('Start date', { exact: true }).fill(start); await popup.getByLabel('Due date', { exact: true }).fill(due); return popup;
}
async function futurePeriod(f: DailyProject) {
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 28); const cutoff = new Date(start); cutoff.setUTCDate(cutoff.getUTCDate() + 6);
  return (await apiWrite(f.page, `${f.prefix}/periods`, { projectId: f.projectId, name: 'Native explicit week', localStart: start.toISOString().slice(0, 10), timezone: 'UTC', cutoffAt: cutoff.toISOString() }, planningPeriodResponseSchema)).data;
}
async function viewportState(page: Page, sentinelId: string) {
  return savedRow(page, sentinelId).evaluate(row => {
    const scroll = document.querySelector<HTMLElement>('[data-task-table-scroll]');
    if (!scroll) throw new Error('Table scrollport is missing.');
    return { y: window.scrollY, x: window.scrollX, tableTop: scroll.scrollTop, tableLeft: scroll.scrollLeft,
      sentinelTop: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height };
  });
}
function stableViewport(before: Awaited<ReturnType<typeof viewportState>>, after: Awaited<ReturnType<typeof viewportState>>) {
  for (const key of ['y', 'x', 'tableTop', 'tableLeft', 'sentinelTop'] as const) expect(Math.abs(after[key] - before[key]), key).toBeLessThanOrEqual(2);
  expect(Math.abs(after.height - 41)).toBeLessThanOrEqual(1);
}
async function completionNoJump(page: Page, info: TestInfo, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const f = await freshProject(page, provider, `Completion ${width}`); const rows: TaskDto[] = [];
  for (let i = 0; i < 28; i += 1) rows.push(await createFixtureTask(f, `Deep task ${String(i).padStart(2, '0')}`));
  const target = requireValue(rows[20]), sentinel = requireValue(rows[21]); await openTable(f);
  const control = savedRow(page, target.id).getByRole('button', { name: `Mark ${target.title} complete`, exact: true });
  await control.scrollIntoViewIfNeeded(); await control.hover();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const before = await viewportState(page, sentinel.id);
  expect(before.y + before.tableTop).toBeGreaterThan(0);
  let release!: () => void; let held = false; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${f.prefix}/tasks/${target.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const response = await route.fetch(); expect(response.status()).toBe(200); held = true; await gate; await route.fulfill({ response });
  });
  const writes = observeCommands(page, f.prefix);
  try {
    const buttonBox = requireValue(await control.boundingBox() ?? undefined);
    await page.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await page.mouse.down(); await page.mouse.up(); await expect.poll(() => held).toBe(true);
    stableViewport(before, await viewportState(page, sentinel.id));
    await picture(page, info, `completion-${width}-pending`);
  } finally { release(); }
  await expect(savedRow(page, target.id).getByRole('button', { name: `Reopen ${target.title}`, exact: true })).toBeVisible();
  stableViewport(before, await viewportState(page, sentinel.id));
  expect(writes.commands).toHaveLength(1);
  expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: target.revision, statusId: f.doneId });
  expect((await allTasks(f)).find(row => row.id === target.id)?.statusId).toBe(f.doneId);
  await picture(page, info, `completion-${width}-confirmed`); writes.close();
}

// A single provider/JWKS key per serial suite. Root restarts its private API between failed runs.
test.describe('daily task table visual and bulk workflows', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth native gate requires traces and video off.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });

  test('floating row follows the actual mouse and paints the insertion point before one durable drop', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Floating root');
    const a = await createFixtureTask(f, 'A'), b = await createFixtureTask(f, 'B'), c = await createFixtureTask(f, 'C with a complete visible drag title');
    const tail: TaskDto[] = [];
    for (let i = 0; i < 25; i += 1) tail.push(await createFixtureTask(f, `Scroll target ${String(i).padStart(2, '0')}`));
    await openTable(f); const before = manualOrder(await allTasks(f)); const writes = observeCommands(page, f.prefix);
    const savedBoxes = await page.locator('tr[data-task-row]').evaluateAll(rows => rows.map(row => ({ id: row.getAttribute('data-task-row'), top: row.getBoundingClientRect().top })));
    await picture(page, info, 'drag-before'); const from = await beginDrag(page, c.id);
    try {
      await page.mouse.move(from.x + 70, from.y + 40, { steps: 6 });
      await expect(preview(page)).toHaveAttribute('data-task-drag-preview', c.id); await expect(preview(page)).toContainText(c.title);
      expect(await preview(page).evaluate(node => getComputedStyle(node).pointerEvents)).toBe('none');
      await expect(preview(page).locator('button,input,select,textarea,a[href]')).toHaveCount(0);
      const first = requireValue(await preview(page).boundingBox() ?? undefined);
      await page.mouse.move(from.x + 100, from.y + 90, { steps: 6 });
      const second = requireValue(await preview(page).boundingBox() ?? undefined);
      expect(Math.abs(second.x - first.x - 30)).toBeLessThanOrEqual(2); expect(Math.abs(second.y - first.y - 50)).toBeLessThanOrEqual(2);
      const destination = await dropPoint(page, a.id, 'before'); await page.mouse.move(destination.x, destination.y, { steps: 12 });
      await expect(savedRow(page, a.id)).toHaveAttribute('data-task-drop', 'before');
      expect(await savedRow(page, a.id).evaluate(row => getComputedStyle(row).boxShadow)).not.toBe('none');
      const cellLines = await savedRow(page, a.id).locator(':scope > td').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).boxShadow));
      expect(cellLines.length).toBeGreaterThan(0);
      for (const line of cellLines) { expect(line).toContain('inset'); expect(line).toMatch(/(?:^|\s)-?2px(?:\s|$)/); }
      expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before);
      expect(await page.locator('tr[data-task-row]').evaluateAll(rows => rows.map(row => ({ id: row.getAttribute('data-task-row'), top: row.getBoundingClientRect().top })))).toEqual(savedBoxes);
      await picture(page, info, 'drag-active-insertion');
    } finally { await page.mouse.up(); }
    await expect.poll(async () => titles(await allTasks(f))).toEqual([c.title, a.title, b.title, ...tail.map(row => row.title)]);
    await expect(preview(page)).toHaveCount(0); expect(writes.commands).toHaveLength(1);
    for (const row of await allTasks(f)) expect(unchangedData(row)).toEqual(unchangedData(requireValue(before.find(old => old.id === row.id))));
    await picture(page, info, 'drag-dropped');
    const committed = manualOrder(await allTasks(f));
    // Hold a real pointer at the page edge: RAF must scroll and re-hit the insertion
    // target without another mousemove, while the proposal remains entirely local.
    const wheelAnchor = requireValue(tail[2]);
    const wheelDestination = await dropPoint(page, wheelAnchor.id, 'before');
    const edgeFrom = await beginDrag(page, b.id);
    try {
      await page.mouse.move(wheelDestination.x, wheelDestination.y, { steps: 8 });
      await expect(savedRow(page, wheelAnchor.id)).toHaveAttribute('data-task-drop', 'before');
      await expect(page.locator('tr[data-task-drop]')).toHaveCount(1);
      const wheelTarget = await page.locator('tr[data-task-drop]').getAttribute('data-task-row');
      const wheelScroll = await page.evaluate(() => window.scrollY);
      const wheelPreview = requireValue(await preview(page).boundingBox() ?? undefined);
      await page.mouse.wheel(0, 180);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(wheelScroll + 90);
      await expect.poll(() => page.locator('tr[data-task-drop]').getAttribute('data-task-row')).not.toBe(wheelTarget);
      const afterWheelPreview = requireValue(await preview(page).boundingBox() ?? undefined);
      expect(Math.abs(afterWheelPreview.x - wheelPreview.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(afterWheelPreview.y - wheelPreview.y)).toBeLessThanOrEqual(2);
      expect(writes.commands).toHaveLength(1); expect(manualOrder(await allTasks(f))).toEqual(committed);
      await picture(page, info, 'drag-held-wheel-rehit');
      await page.mouse.move(edgeFrom.x + 70, await page.evaluate(() => innerHeight - 6), { steps: 12 });
      await expect(preview(page)).toHaveAttribute('data-task-drag-preview', b.id);
      const initialScroll = await page.evaluate(() => window.scrollY);
      const initialTarget = await page.locator('tr[data-task-drop]').getAttribute('data-task-row');
      expect(initialTarget).not.toBeNull();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(initialScroll + 90);
      await expect.poll(() => page.locator('tr[data-task-drop]').getAttribute('data-task-row')).not.toBe(initialTarget);
      await expect(preview(page)).toBeVisible();
      expect(writes.commands).toHaveLength(1); expect(manualOrder(await allTasks(f))).toEqual(committed);
      await picture(page, info, 'drag-held-edge-autoscroll'); await page.keyboard.press('Escape');
    } finally { await page.mouse.up(); }
    await expect(preview(page)).toHaveCount(0);
    const stopped = await page.evaluate(async () => {
      const beforeY = window.scrollY;
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { beforeY, afterY: window.scrollY };
    });
    expect(stopped.afterY).toBe(stopped.beforeY); expect(writes.commands).toHaveLength(1);
    expect(manualOrder(await allTasks(f))).toEqual(committed);
    await page.reload(); expect(ids(await allTasks(f))).toEqual([c.id, a.id, b.id, ...tail.map(row => row.id)]); writes.close();
  });

  test('Assignee flat drag reorders roots and children, reassigns across parents and appends to empty Unassigned', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Assignee drag', true); const first = requireValue(f.teammates[0]), second = requireValue(f.teammates[1]);
    const a = await createFixtureTask(f, 'A', { responsibleMembershipId: first.id, estimateMinutes: 90, startDate: '2035-03-01', dueDate: '2035-03-03' });
    const b = await createFixtureTask(f, 'B', { responsibleMembershipId: first.id });
    const c = await createFixtureTask(f, 'C', { responsibleMembershipId: second.id }), d = await createFixtureTask(f, 'D', { responsibleMembershipId: second.id });
    const parent = await createFixtureTask(f, 'Parent P', { responsibleMembershipId: f.owner.id, estimateMinutes: 180 });
    const otherParent = await createFixtureTask(f, 'Parent Q', { responsibleMembershipId: f.owner.id, estimateMinutes: 120 });
    const child = await createFixtureTask(f, 'Child E', { parentTaskId: parent.id, responsibleMembershipId: first.id, dueDate: '2035-03-04' });
    const otherChild = await createFixtureTask(f, 'Child F', { parentTaskId: otherParent.id, responsibleMembershipId: second.id });
    const assignment = await createFixtureTask(f, 'Inline assignment sentinel');
    await openTable(f); await choose(page, page.getByRole('main'), 'Group by', 'Assignee');
    const writes = observeCommands(page, f.prefix);
    const editAssignment = savedRow(page, assignment.id).getByRole('button', { name: `Edit assignee for ${assignment.title}`, exact: true });
    await editAssignment.scrollIntoViewIfNeeded(); const assignmentViewport = await viewportState(page, otherParent.id);
    let releaseAssignment!: () => void; let assignmentHeld = false;
    const assignmentGate = new Promise<void>(resolve => { releaseAssignment = resolve; });
    await page.route(`**${f.prefix}/tasks/${assignment.id}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(200); assignmentHeld = true;
      await assignmentGate; await route.fulfill({ response });
    });
    try {
      await editAssignment.click(); await page.getByRole('option', { name: f.owner.displayName, exact: true }).click();
      await expect.poll(() => assignmentHeld).toBe(true); stableViewport(assignmentViewport, await viewportState(page, otherParent.id));
      await expect(page.getByText(`Assignee saved: ${f.owner.displayName}.`, { exact: true })).toHaveCount(0);
      await picture(page, info, 'inline-assignee-held');
    } finally { releaseAssignment(); }
    await expect(page.getByText(`Assignee saved: ${f.owner.displayName}.`, { exact: true })).toBeVisible();
    await expect(savedRow(page, assignment.id)).toContainText(f.owner.displayName);
    await expect.poll(async () => (await allTasks(f)).find(row => row.id === assignment.id)?.responsibleMembershipId).toBe(f.owner.id);
    stableViewport(assignmentViewport, await viewportState(page, otherParent.id));
    expect(writes.commands).toHaveLength(1);
    expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: assignment.revision, responsibleMembershipId: f.owner.id });
    const assigned = requireValue((await allTasks(f)).find(row => row.id === assignment.id));
    expect(unchangedData(assigned, true)).toEqual(unchangedData(assignment, true));
    await picture(page, info, 'inline-assignee-confirmed');
    await move(page, b.id, a.id, 'before'); await expect.poll(async () => titles((await allTasks(f)).filter(row => row.responsibleMembershipId === first.id))).toEqual(['B', 'A', child.title]);
    await move(page, a.id, c.id, 'after'); await expect.poll(async () => titles((await allTasks(f)).filter(row => row.responsibleMembershipId === second.id))).toEqual(['C', 'A', 'D', otherChild.title]);
    await expect(group(page, second.id).locator(`tr[data-task-row="${a.id}"]`)).toBeVisible();
    expect(JSON.parse(requireValue(writes.commands.at(-1)).body)).toMatchObject({ anchorTaskId: c.id, placement: 'after', responsibleMembershipId: second.id });
    // In flat Assignee view, a child can move beside another parent's child without reparenting.
    await move(page, child.id, otherChild.id, 'after');
    await expect.poll(async () => titles((await allTasks(f)).filter(row => row.responsibleMembershipId === second.id))).toEqual(['C', 'A', 'D', otherChild.title, child.title]);
    const movedChild = requireValue((await allTasks(f)).find(row => row.id === child.id));
    expect(unchangedData(movedChild, true)).toEqual(unchangedData(child, true));
    expect(movedChild.parentTaskId).toBe(parent.id); expect(movedChild.workPackageId).toBe(parent.workPackageId); expect(movedChild.estimateMinutes).toBe(180);
    expect(JSON.parse(requireValue(writes.commands.at(-1)).body)).toMatchObject({ anchorTaskId: otherChild.id, placement: 'after', responsibleMembershipId: second.id });
    const empty = page.locator('[data-task-group-drop=""]'); const destination = await center(empty); await beginDrag(page, a.id);
    try {
      await page.mouse.move(destination.x, destination.y, { steps: 12 });
      await expect(empty).toHaveAttribute('data-task-drop', 'after');
      expect(await empty.evaluate(row => getComputedStyle(row).boxShadow)).not.toBe('none');
      const emptyLine = await empty.locator(':scope > td').evaluate(cell => getComputedStyle(cell).boxShadow);
      expect(emptyLine).toContain('inset'); expect(emptyLine).toMatch(/(?:^|\s)-?2px(?:\s|$)/);
      expect(writes.commands).toHaveLength(4);
      expect((await allTasks(f)).find(row => row.id === a.id)?.responsibleMembershipId).toBe(second.id);
      await picture(page, info, 'assignee-empty-group-drop');
    } finally { await page.mouse.up(); }
    await expect.poll(async () => (await allTasks(f)).find(row => row.id === a.id)?.responsibleMembershipId).toBeNull();
    const moved = requireValue((await allTasks(f)).find(row => row.id === a.id)); expect(unchangedData(moved, true)).toEqual(unchangedData(a, true));
    expect(JSON.parse(requireValue(writes.commands.at(-1)).body)).toMatchObject({ anchorTaskId: null, placement: 'after', responsibleMembershipId: null });
    expect(writes.commands).toHaveLength(5); await page.reload();
    await choose(page, page.getByRole('main'), 'Group by', 'Assignee');
    await expect(group(page, null).locator(`tr[data-task-row="${a.id}"]`)).toBeVisible();
    expect(titles((await allTasks(f)).filter(row => row.responsibleMembershipId === second.id))).toEqual([c.title, d.title, otherChild.title, child.title]); writes.close();
  });

  test('drawer child preview and Escape preserve the authoritative sibling list without a move command', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Drawer drag cancel'); const parent = await createFixtureTask(f, 'Parent', { estimateMinutes: 180 });
    const a = await createFixtureTask(f, 'a', { parentTaskId: parent.id }), b = await createFixtureTask(f, 'b', { parentTaskId: parent.id });
    await openTable(f); await savedRow(page, parent.id).locator(`[data-task-open-area="${parent.id}"]`).click();
    const drawer = page.getByRole('dialog', { name: parent.title, exact: true }); const rows = drawer.getByRole('region', { name: 'Subtasks', exact: true });
    await expect(rows.getByRole('table', { name: 'Subtasks', exact: true })).toBeVisible(); const before = manualOrder(await allTasks(f)); const writes = observeCommands(page, f.prefix);
    const destination = await dropPoint(rows, a.id, 'before'); await beginDrag(page, b.id, rows);
    try {
      await page.mouse.move(destination.x, destination.y, { steps: 12 }); await expect(preview(page)).toContainText(b.title);
      await expect(rows.locator(`tr[data-task-row="${a.id}"]`)).toHaveAttribute('data-task-drop', 'before');
      await picture(page, info, 'drawer-drag-active'); await page.keyboard.press('Escape');
    } finally { await page.mouse.up(); }
    await expect(preview(page)).toHaveCount(0); expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before);
    await expect(drawer).toBeVisible(); expect(before.filter(row => row.parentTaskId === parent.id).every(row => row.workPackageId === parent.workPackageId && row.estimateMinutes === 180)).toBe(true); writes.close();
  });

  test('desktop completion does not move the page, table or next row while its real ACK is held', async ({ page }, info) => { await completionNoJump(page, info, 1440); });
  test('mobile completion does not move the page, table or next row while its real ACK is held', async ({ page }, info) => { await completionNoJump(page, info, 390); });

  test('blank gutter Shift range excludes collapsed children and Ctrl/Meta toggles without editing or writing', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Gutter selection'); const a = await createFixtureTask(f, 'A'), parent = await createFixtureTask(f, 'Parent');
    const hidden1 = await createFixtureTask(f, 'Hidden child1', { parentTaskId: parent.id }), hidden2 = await createFixtureTask(f, 'Hidden child2', { parentTaskId: parent.id });
    const c = await createFixtureTask(f, 'C'), d = await createFixtureTask(f, 'D'); await openTable(f);
    await savedRow(page, parent.id).getByRole('button', { name: 'Collapse subtasks of “Parent”', exact: true }).click();
    await expect(savedRow(page, hidden1.id)).toHaveCount(0); await expect(savedRow(page, hidden2.id)).toHaveCount(0);
    const writes = observeCommands(page, f.prefix); await selectRange(page, a.title, c.title);
    expect(await selected(page)).toEqual([a.id, parent.id, c.id]); await expect(bulkRegion(page)).toContainText('3 tasks selected');
    await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
    await picture(page, info, 'gutter-shift-selection');
    await gutter(page, parent.title).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] }); expect(await selected(page)).toEqual([a.id, c.id]);
    await gutter(page, d.title).click(); expect(await selected(page)).toEqual([d.id]);
    await bulkRegion(page).getByRole('button', { name: 'Clear selection', exact: true }).click(); expect(await selected(page)).toEqual([]);
    expect(writes.commands).toEqual([]); expect(ids(await allTasks(f))).toEqual([a.id, parent.id, hidden1.id, hidden2.id, c.id, d.id]); writes.close();
  });

  test('bulk assignee applies exactly the selected current revisions and leaves every other task unchanged', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Bulk assignee', true), first = requireValue(f.teammates[0]), second = requireValue(f.teammates[1]);
    const a = await createFixtureTask(f, 'A', { responsibleMembershipId: first.id, estimateMinutes: 60, startDate: '2035-01-01', dueDate: '2035-01-03' });
    const b = await createFixtureTask(f, 'B', { responsibleMembershipId: first.id }), c = await createFixtureTask(f, 'C', { responsibleMembershipId: first.id });
    await openTable(f); const before = await allTasks(f), writes = observeCommands(page, f.prefix); await selectRange(page, a.title, b.title);
    await choose(page, bulkRegion(page), 'Assignee', second.displayName); expect(writes.commands).toEqual([]);
    await picture(page, info, 'bulk-assignee-before-apply'); await bulkRegion(page).getByRole('button', { name: 'Apply to selected tasks', exact: true }).click();
    await expect.poll(async () => (await allTasks(f)).filter(row => [a.id, b.id].includes(row.id)).map(row => row.responsibleMembershipId)).toEqual([second.id, second.id]);
    expect(writes.commands).toHaveLength(1); const sent = requireValue(writes.commands[0]); expect(sent.path).toBe(`${f.prefix}/tasks/bulk-update`); expect(sent.key?.length).toBeGreaterThan(0);
    expect(JSON.parse(sent.body)).toEqual({ projectId: f.projectId, tasks: [{ taskId: a.id, expectedRevision: a.revision }, { taskId: b.id, expectedRevision: b.revision }], changes: { responsibleMembershipId: second.id } });
    const after = await allTasks(f); expect(after.find(row => row.id === c.id)).toEqual(c);
    for (const id of [a.id, b.id]) expect(unchangedData(requireValue(after.find(row => row.id === id)), true)).toEqual(unchangedData(requireValue(before.find(row => row.id === id)), true));
    await page.reload(); expect((await allTasks(f)).filter(row => [a.id, b.id].includes(row.id)).every(row => row.responsibleMembershipId === second.id)).toBe(true); writes.close();
  });

  test('bulk dates reject an invalid final range and recover a committed lost ACK with the exact original selection', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Bulk dates');
    const a = await createFixtureTask(f, 'A', { startDate: '2035-03-10', dueDate: '2035-03-11', estimateMinutes: 90 });
    const b = await createFixtureTask(f, 'B', { startDate: '2035-03-10', dueDate: '2035-03-11' }), c = await createFixtureTask(f, 'C', { dueDate: '2035-04-01' });
    await openTable(f); const writes = observeCommands(page, f.prefix); const before = manualOrder(await allTasks(f)); await selectRange(page, a.title, b.title);
    await bulkRegion(page).getByRole('button', { name: 'Dates', exact: true }).click();
    const popup = page.getByRole('dialog', { name: 'Edit selected task dates', exact: true });
    await popup.getByRole('button', { name: '+ Start date', exact: true }).click();
    await popup.getByLabel('Start date', { exact: true }).fill('2035-03-14'); await popup.getByLabel('Due date', { exact: true }).fill('2035-03-12');
    await popup.getByRole('button', { name: 'Done', exact: true }).click(); await bulkRegion(page).getByRole('button', { name: 'Apply to selected tasks', exact: true }).click();
    await expect(bulkRegion(page).getByRole('alert')).toHaveText('Check the selected changes and dates.');
    expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before);
    await bulkRegion(page).getByRole('button', { name: 'Dates', exact: true }).click();
    await popup.getByLabel('Start date', { exact: true }).fill('2035-03-15'); await popup.getByLabel('Due date', { exact: true }).fill('2035-03-20');
    await picture(page, info, 'bulk-date-popup'); await popup.getByRole('button', { name: 'Done', exact: true }).click();
    expect(writes.commands).toEqual([]);
    let lost = false;
    await page.route(`**${f.prefix}/tasks/bulk-update`, async route => {
      if (route.request().method() !== 'POST' || lost) return route.continue();
      lost = true; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed');
    });
    await bulkRegion(page).getByRole('button', { name: 'Apply to selected tasks', exact: true }).click();
    await expect(bulkRegion(page).getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    await expect(bulkRegion(page).getByText('2 tasks updated.', { exact: true })).toHaveCount(0);
    await expect(bulkRegion(page).getByRole('button', { name: 'Clear selection', exact: true })).toBeDisabled();
    expect(writes.commands).toHaveLength(1); const original = requireValue(writes.commands[0]);
    expect(JSON.parse(original.body)).toEqual({ projectId: f.projectId, tasks: [{ taskId: a.id, expectedRevision: a.revision }, { taskId: b.id, expectedRevision: b.revision }], changes: { startDate: '2035-03-15', dueDate: '2035-03-20' } });
    const committed = manualOrder(await allTasks(f)); expect(committed.filter(row => [a.id, b.id].includes(row.id)).every(row => row.startDate === '2035-03-15' && row.dueDate === '2035-03-20')).toBe(true);
    for (const handle of await page.locator('[data-task-move-handle]').all()) await expect(handle).toBeDisabled();
    await (await titleCell(page, c.id)).hover(); const from = await center(page.locator(`[data-task-move-handle="${c.id}"]`)), to = await dropPoint(page, a.id, 'before');
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    try { await page.mouse.move(from.x + 9, from.y, { steps: 3 }); await page.mouse.move(to.x, to.y, { steps: 12 }); } finally { await page.mouse.up(); }
    expect(manualOrder(await allTasks(f))).toEqual(committed); expect(writes.commands).toEqual([original]);
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    const selectedDate = page.getByRole('checkbox', { name: `Select dates: ${a.title}`, exact: true });
    const unselectedDate = page.getByRole('checkbox', { name: `Select dates: ${c.title}`, exact: true });
    await expect(selectedDate).toBeChecked(); await expect(unselectedDate).not.toBeChecked();
    for (const choice of [selectedDate, unselectedDate]) {
      await expect(choice).toBeDisabled();
      const point = await center(choice); await page.mouse.click(point.x, point.y);
    }
    await expect(selectedDate).toBeChecked(); await expect(unselectedDate).not.toBeChecked();
    await expect(bulkRegion(page)).toContainText('2 tasks selected');
    await expect(bulkRegion(page).getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    expect(writes.commands).toEqual([original]); expect(manualOrder(await allTasks(f))).toEqual(committed);
    await picture(page, info, 'bulk-unknown-timeline-selection-guard');
    await bulkRegion(page).getByRole('button', { name: 'Retry original', exact: true }).click();
    await expect(bulkRegion(page).getByRole('button', { name: 'Retry original', exact: true })).toHaveCount(0);
    expect(writes.commands).toHaveLength(2); expect(writes.commands[1]).toEqual(original);
    expect(manualOrder(await allTasks(f))).toEqual(committed); expect(committed.find(row => row.id === c.id)).toEqual(c);
    await page.reload(); expect(manualOrder(await allTasks(f))).toEqual(committed); writes.close();
  });

  test('one due/start calendar edit persists the exact saved range into Timeline and through reload', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Calendar range'); const task = await createFixtureTask(f, 'Calendar task', { estimateMinutes: 120 });
    await openTable(f); const writes = observeCommands(page, f.prefix);
    const popup = await datePopup(page, savedRow(page, task.id), '2035-05-20', '2035-05-10');
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(popup.getByText('Due date must be on or after the start date.', { exact: true })).toBeVisible();
    expect(writes.commands).toEqual([]); expect((await allTasks(f))[0]).toEqual(task);
    await popup.getByLabel('Due date', { exact: true }).fill('2035-05-');
    await popup.getByLabel('Due date', { exact: true }).press('Tab');
    await expect(popup).toBeVisible(); await expect(popup.getByLabel('Due date', { exact: true })).toHaveValue('2035-05-');
    expect(writes.commands).toEqual([]); expect((await allTasks(f))[0]).toEqual(task);
    await popup.getByLabel('Start date', { exact: true }).fill('2035-05-10'); await popup.getByLabel('Due date', { exact: true }).fill('2035-05-12');
    const calendarHeading = popup.getByText('May 2035', { exact: true });
    const headingPoint = await center(calendarHeading); await page.mouse.move(headingPoint.x, headingPoint.y); await page.mouse.down();
    try {
      // Let real browser blur/timers and an authoritative read complete while the
      // pointer stays down on non-focusable calendar content, before its click.
      const heldTask = (await allTasks(f))[0];
      expect(heldTask).toEqual(task); await expect(popup).toBeVisible();
      await expect(popup.getByLabel('Due date', { exact: true })).toHaveValue('2035-05-12');
      expect(writes.commands).toEqual([]); await picture(page, info, 'calendar-held-heading');
    } finally { await page.mouse.up(); }
    await expect(popup).toBeVisible(); expect(writes.commands).toEqual([]);
    const day = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date('2035-05-13T00:00:00Z'));
    await popup.getByRole('region', { name: 'Choose a date', exact: true }).getByRole('button', { name: day, exact: true }).click();
    await expect(popup.getByLabel('Due date', { exact: true })).toHaveValue('2035-05-13'); await picture(page, info, 'single-date-popup');
    await popup.getByRole('button', { name: 'Save', exact: true }).click(); await expect(popup).toHaveCount(0);
    await expect.poll(async () => (await allTasks(f))[0]?.dueDate).toBe('2035-05-13'); expect(writes.commands).toHaveLength(1);
    expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: task.revision, startDate: '2035-05-10', dueDate: '2035-05-13' });
    const saved = requireValue((await allTasks(f))[0]); expect(saved.workPackageId).toBe(task.workPackageId); expect(saved.estimateMinutes).toBe(120);
    await page.getByRole('button', { name: 'Timeline', exact: true }).click();
    const current = page.getByRole('img', { name: 'Current: start 2035-05-10, due 2035-05-13', exact: true }); await expect(current).toBeVisible();
    await picture(page, info, 'timeline-saved-range'); await page.reload(); await expect(current).toBeVisible();
    expect((await allTasks(f))[0]).toEqual(saved); expect(writes.commands).toHaveLength(1); writes.close();
  });

  test('saved tag cell searches and attaches an existing tag with one revision-guarded save', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Saved tags'); const tag = (await apiWrite(page, `${f.prefix}/tags`, { name: 'Native daily tag', color: '#2563eb' }, tagResponseSchema)).data;
    const task = await createFixtureTask(f, 'Tagged task', { estimateMinutes: 75, dueDate: '2035-06-02' }); await openTable(f); const writes = observeCommands(page, f.prefix);
    await savedRow(page, task.id).locator(`button[data-task-cell="${task.id}:tagIds"]`).click();
    const popup = page.getByRole('dialog', { name: 'Edit tags', exact: true }); await popup.getByRole('searchbox', { name: 'Search tags', exact: true }).fill('Native daily');
    await popup.getByText(tag.name, { exact: true }).click(); await expect(popup.getByRole('checkbox', { name: tag.name, exact: true })).toBeChecked(); expect(writes.commands).toEqual([]); await picture(page, info, 'saved-tags-popup');
    await popup.getByRole('button', { name: 'Save', exact: true }).click(); await expect(popup).toHaveCount(0);
    await expect.poll(async () => (await allTasks(f))[0]?.tags.map(value => value.id)).toEqual([tag.id]);
    expect(writes.commands).toHaveLength(1); expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: task.revision, tagIds: [tag.id] });
    const saved = requireValue((await allTasks(f))[0]); expect(saved.estimateMinutes).toBe(75); expect(saved.dueDate).toBe(task.dueDate); expect(saved.workPackageId).toBe(task.workPackageId);
    await page.reload(); await expect(savedRow(page, task.id)).toContainText(tag.name); expect((await allTasks(f))[0]).toEqual(saved); writes.close();
  });

  test('actual-hours cell discovers an explicit week and records75minutes and zero without changing plan or estimate', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Actual hours', true); const teammate = requireValue(f.teammates[0]);
    const a = await createFixtureTask(f, 'Worked task', { estimateMinutes: 180 }), b = await createFixtureTask(f, 'Zero task'); const period = await futurePeriod(f);
    const plan = (await apiWrite(page, `${f.prefix}/periods/${period.id}/commitments`, { expectedAbsent: true, membershipId: f.owner.id, workPackageId: a.workPackageId, plannedMinutes: 120, allocations: [] }, periodCommitmentResponseSchema)).data;
    await openTable(f); await showColumns(page, ['Personal weekly plan', 'Personal actual hours']); const writes = observeCommands(page, f.prefix);
    const header = page.locator('[data-task-table-scroll] table').getByRole('columnheader', { name: `Weekly actual hours · ${f.owner.displayName}`, exact: true });
    const index = await header.evaluate((node: HTMLTableCellElement) => node.cellIndex);
    await savedRow(page, a.id).locator(':scope > td').nth(index).getByRole('button', { name: 'Choose week', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('option', { name: `${period.name} · ${period.localStart}`, exact: true }).click();
    await choose(page, page.getByRole('region', { name: 'Weekly hours in table', exact: true }), 'Whose hours to show', teammate.displayName);
    expect(new URL(page.url()).searchParams.get('worker')).toBe(teammate.id); expect(writes.commands).toEqual([]);
    await choose(page, page.getByRole('region', { name: 'Weekly hours in table', exact: true }), 'Whose hours to show', `${f.owner.displayName} · me`);
    expect(writes.commands).toEqual([]); expect(new URL(page.url()).searchParams.get('week')).toBe(period.id); expect(new URL(page.url()).searchParams.get('worker')).toBe(f.owner.id);
    for (const [task, hours] of [[a, '1:15'], [b, '0']] as const) {
      await savedRow(page, task.id).getByRole('button', { name: `Weekly actual hours: ${task.title}`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Record weekly actual hours', exact: true }); await expect(dialog).toContainText(period.name); await expect(dialog).toContainText(f.owner.displayName); await expect(dialog).toContainText(task.title);
      await dialog.getByRole('textbox', { name: 'Actual hours this week', exact: true }).fill(hours);
      await dialog.getByRole('textbox', { name: 'Comment (optional)', exact: true }).fill('Native explicit week entry');
      await picture(page, info, task.id === a.id ? 'actual-hours-75' : 'actual-hours-zero');
      await dialog.getByRole('button', { name: 'Save actual hours', exact: true }).click(); await expect(dialog).toHaveCount(0);
    }
    const logs = (await apiRead(page, `${f.prefix}/worklogs?periodId=${period.id}&membershipId=${f.owner.id}`, manualPeriodWorkLogListResponseSchema)).data;
    expect(logs).toHaveLength(2); expect(logs.find(log => log.taskId === a.id)?.minutes).toBe(75); expect(logs.find(log => log.taskId === b.id)?.minutes).toBe(0);
    expect(writes.commands).toHaveLength(2); expect(writes.commands.every(command => command.method === 'PUT' && command.path.includes('/manual-period-work/'))).toBe(true);
    expect((await apiRead(page, `${f.prefix}/periods/${period.id}/commitments`, periodCommitmentListResponseSchema)).data).toEqual([plan]);
    expect((await allTasks(f)).find(row => row.id === a.id)).toEqual(a); expect((await allTasks(f)).find(row => row.id === b.id)).toEqual(b);
    await page.reload(); expect((await apiRead(page, `${f.prefix}/worklogs?periodId=${period.id}&membershipId=${f.owner.id}`, manualPeriodWorkLogListResponseSchema)).data).toHaveLength(2); writes.close();
  });

  test('mobile date popup, existing tags and explicit actual entry stay reachable inside390pixels', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 }); const f = await freshProject(page, provider, 'Mobile daily');
    const task = await createFixtureTask(f, 'Mobile task', { estimateMinutes: 60 }), period = await futurePeriod(f);
    const tag = (await apiWrite(page, `${f.prefix}/tags`, { name: 'Mobile existing tag' }, tagResponseSchema)).data;
    await openTable(f); const writes = observeCommands(page, f.prefix);
    const popup = await datePopup(page, savedRow(page, task.id), '2035-07-01', '2035-07-03');
    const box = requireValue(await popup.boundingBox() ?? undefined); expect(box.x).toBeGreaterThanOrEqual(4); expect(box.y).toBeGreaterThanOrEqual(4); expect(box.x + box.width).toBeLessThanOrEqual(386); expect(box.y + box.height).toBeLessThanOrEqual(840);
    await picture(page, info, 'mobile-date-popup'); await popup.getByRole('button', { name: 'Save', exact: true }).click(); await expect(popup).toHaveCount(0);
    await expect.poll(async () => (await allTasks(f))[0]?.dueDate).toBe('2035-07-03');
    const reopened = await datePopup(page, savedRow(page, task.id), '2035-07-01', '2035-07-03');
    await reopened.getByLabel('Start date', { exact: true }).click(); await reopened.getByRole('button', { name: 'Clear start date', exact: true }).click();
    await expect(reopened.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await reopened.getByRole('button', { name: 'Save', exact: true }).click(); await expect(reopened).toHaveCount(0);
    await expect.poll(async () => (await allTasks(f))[0]?.startDate).toBeNull(); expect((await allTasks(f))[0]?.dueDate).toBe('2035-07-03');
    await savedRow(page, task.id).locator(`button[data-task-cell="${task.id}:tagIds"]`).click();
    const tags = page.getByRole('dialog', { name: 'Edit tags', exact: true }); await tags.getByText(tag.name, { exact: true }).click(); await expect(tags.getByRole('checkbox', { name: tag.name, exact: true })).toBeChecked(); await tags.getByRole('button', { name: 'Save', exact: true }).click(); await expect(tags).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Week for hours', exact: true }).click(); await page.getByRole('option', { name: `${period.name} · ${period.localStart}`, exact: true }).click();
    await choose(page, page.getByRole('region', { name: 'Weekly hours in table', exact: true }), 'Whose hours to show', `${f.owner.displayName} · me`);
    await savedRow(page, task.id).getByRole('button', { name: `Weekly actual hours: ${task.title}`, exact: true }).click();
    const actual = page.getByRole('dialog', { name: 'Record weekly actual hours', exact: true }); await actual.getByRole('textbox', { name: 'Actual hours this week', exact: true }).fill('0:45');
    await picture(page, info, 'mobile-actual-hours'); await actual.getByRole('button', { name: 'Save actual hours', exact: true }).click(); await expect(actual).toHaveCount(0);
    const saved = requireValue((await allTasks(f))[0]); expect(saved.tags.map(value => value.id)).toEqual([tag.id]); expect(saved.startDate).toBeNull(); expect(saved.dueDate).toBe('2035-07-03'); expect(saved.workPackageId).toBe(task.workPackageId); expect(saved.estimateMinutes).toBe(60);
    const logs = (await apiRead(page, `${f.prefix}/worklogs?periodId=${period.id}&taskId=${task.id}&membershipId=${f.owner.id}`, manualPeriodWorkLogListResponseSchema)).data; expect(logs).toHaveLength(1); expect(logs[0]?.minutes).toBe(45);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1); expect(Math.abs(await savedRow(page, task.id).evaluate(row => row.getBoundingClientRect().height) - 41)).toBeLessThanOrEqual(1);
    expect(writes.commands).toHaveLength(4); await page.reload(); expect((await allTasks(f))[0]).toEqual(saved); writes.close();
  });
});
