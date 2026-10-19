// Root-executed compiled QA only: private49318 shared BFF + fake provider49319; never main runtime.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { graphLayoutResponseSchema, sectionResponseSchema, tagResponseSchema, taskResponseSchema, type TaskDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, allTasks, apiRead, apiWrite, center, createFixtureTask, freshProject, manualOrder, observeCommands, requireValue, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const card = (page: Page, task: TaskDto) => page.locator(`[data-board-card="${task.id}"]`);
const lane = (page: Page, statusId: string) => page.locator(`[data-board-status="${statusId}"]`);
const url = (f: DailyProject, query: string) => `${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?${query}`;
const semantic = (task: TaskDto) => ({ ...task, statusId: '', position: 0, revision: 0, updatedAt: '' });
const readTask = async (f: DailyProject, id: string) => (await apiRead(f.page, `${f.prefix}/tasks/${id}`, taskResponseSchema)).data;
const responseAt = (method: string, path: string) => (response: { url(): string; request(): { method(): string } }) => response.request().method() === method && new URL(response.url()).pathname === path;
async function laneOrder(page: Page, statusId: string, ids: string[]) {
  await expect(lane(page, statusId).locator('[data-board-card]')).toHaveCount(ids.length);
  await expect.poll(() => lane(page, statusId).locator('[data-board-card]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-board-card')))).toEqual(ids);
}
async function beginBefore(page: Page, source: TaskDto, target: TaskDto, ownerName: string, tagId: string) {
  const from = await center(card(page, source).getByRole('button', { name: `Drag task: ${source.title}`, exact: true }));
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 9, from.y + 1);
  const ghost = page.getByTestId('board-drag-preview'); await expect(ghost).toBeVisible();
  await expect(ghost).toHaveAttribute('aria-hidden', 'true'); await expect(ghost).toHaveAttribute('inert', '');
  await expect(ghost).toContainText(source.title); await expect(ghost).toContainText(ownerName);
  await expect(ghost).toContainText('Parent task'); await expect(ghost).toContainText('Due');
  await expect(ghost.locator(`[data-tag-badge="${tagId}"]`)).toBeVisible();
  const ghostBox = await ghost.boundingBox(); if (!ghostBox) throw new Error('Full-card ghost has no box.');
  expect(ghostBox.width).toBeGreaterThan(150); expect(ghostBox.height).toBeGreaterThan(100);
  await card(page, target).scrollIntoViewIfNeeded(); const box = await card(page, target).boundingBox();
  if (!box) throw new Error('Actual Board anchor is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(18, box.height / 4), { steps: 8 });
  await expect(lane(page, target.statusId)).toHaveAttribute('data-board-drop', 'active');
  await expect(card(page, target).locator('[data-board-drop-placeholder]')).toBeVisible();
  await expect(page.locator('[data-board-drop-placeholder]')).toHaveCount(1);
}
async function graphPoint(node: Locator) {
  return node.evaluate(element => { const matrix = new DOMMatrixReadOnly((element as HTMLElement).style.transform); return { x: matrix.e, y: matrix.f }; });
}

test.describe('compiled Board order and section diagram', () => {
  test.describe.configure({ mode: 'serial' }); test.use({ viewport: { width: 1440, height: 1000 } });
  test.beforeAll(async ({ baseURL }, info) => {
    if (process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private Board QA49318 required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('No Auth traces or video.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  test('real pointer inserts between cards in either lane, persists after reload, and requires Manual ordering', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Atomic Board order'), progress = requireValue(f.statuses.find(status => status.group === 'in_progress'));
    const firstSection = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Original section' }, sectionResponseSchema)).data;
    const secondSection = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Other section' }, sectionResponseSchema)).data;
    const tag = (await apiWrite(page, `${f.prefix}/tags`, { name: 'Preview details', color: '#ef4444' }, tagResponseSchema)).data;
    const a = await createFixtureTask(f, 'Board parent A', { sectionId: firstSection.id });
    const b = await createFixtureTask(f, 'Board card B', { sectionId: firstSection.id });
    const source = await createFixtureTask(f, 'Board detailed child C', { parentTaskId: a.id, sectionId: firstSection.id, responsibleMembershipId: f.owner.id, dueDate: '2035-04-06', tagIds: [tag.id] });
    const d = await createFixtureTask(f, 'Board parent D', { statusId: progress.id, sectionId: secondSection.id });
    const e = await createFixtureTask(f, 'Board target child E', { parentTaskId: d.id, sectionId: secondSection.id, statusId: progress.id });
    await page.goto(url(f, 'view=board')); await laneOrder(page, f.todoId, [a.id, b.id, source.id]); await laneOrder(page, progress.id, [d.id, e.id]);
    const writes = observeCommands(page, f.prefix), path = `${f.prefix}/tasks/${source.id}/move`;
    try {
      await beginBefore(page, source, b, f.owner.displayName, tag.id);
      await page.screenshot({ path: info.outputPath('board-same-lane-preview.png') });
      const savedSame = page.waitForResponse(responseAt('POST', path)); await page.mouse.up();
      const sameResponse = await savedSame; expect(sameResponse.status()).toBe(200);
      const same = taskResponseSchema.parse(await sameResponse.json()).data;
      expect(semantic(same)).toEqual(semantic(source)); expect(same.statusId).toBe(f.todoId);
      expect(writes.commands.map(command => ({ method: command.method, path: command.path, body: JSON.parse(command.body) }))).toEqual([
        { method: 'POST', path, body: { expectedRevision: source.revision, statusId: f.todoId, anchorTaskId: b.id, placement: 'before', captureUndo: true } },
      ]);
      await laneOrder(page, f.todoId, [a.id, source.id, b.id]); await expect(page.getByTestId('board-drag-preview')).toHaveCount(0);
      expect(manualOrder(await allTasks(f)).map(task => task.id)).toEqual([a.id, source.id, b.id, d.id, e.id]);
      await page.reload(); await laneOrder(page, f.todoId, [a.id, source.id, b.id]);
      await beginBefore(page, same, e, f.owner.displayName, tag.id);
      await page.screenshot({ path: info.outputPath('board-cross-lane-preview.png') });
      const savedCross = page.waitForResponse(responseAt('POST', path)); await page.mouse.up();
      const crossResponse = await savedCross; expect(crossResponse.status()).toBe(200);
      const cross = taskResponseSchema.parse(await crossResponse.json()).data;
      expect(semantic(cross)).toEqual(semantic(source)); expect(cross.statusId).toBe(progress.id);
      expect(writes.commands).toHaveLength(2);
      expect(JSON.parse(requireValue(writes.commands[1]).body)).toEqual({ expectedRevision: same.revision, statusId: progress.id, anchorTaskId: e.id, placement: 'before', captureUndo: true });
      expect(requireValue(writes.commands[0]).key).toMatch(/^[0-9a-f-]{36}$/i); expect(requireValue(writes.commands[1]).key).not.toBe(requireValue(writes.commands[0]).key);
      await laneOrder(page, f.todoId, [a.id, b.id]); await laneOrder(page, progress.id, [d.id, source.id, e.id]);
      expect(manualOrder(await allTasks(f)).map(task => task.id)).toEqual([a.id, b.id, d.id, source.id, e.id]); expect(await readTask(f, source.id)).toEqual(cross);
      await page.reload(); await laneOrder(page, progress.id, [d.id, source.id, e.id]);
      const beforeDue = await allTasks(f); await page.goto(url(f, 'view=board&sort=due_asc'));
      await expect(page.getByRole('button', { name: 'Manual', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Drag task:/ })).toHaveCount(0);
      await expect(card(page, source).getByRole('button', { name: 'Change status', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Manual', exact: true }).click();
      await expect(page).toHaveURL(value => value.searchParams.get('view') === 'board' && !value.searchParams.has('sort'));
      await expect(card(page, source).getByRole('button', { name: `Drag task: ${source.title}`, exact: true })).toBeVisible();
      await laneOrder(page, progress.id, [d.id, source.id, e.id]); expect(await allTasks(f)).toEqual(beforeDue); expect(writes.commands).toHaveLength(2);
      await page.screenshot({ path: info.outputPath('board-persisted-manual-order.png') });
    } finally { await page.mouse.up(); writes.close(); }
  });

  test('section diagram headers are not tasks and preview leaves saved personal positions and ordinary navigation intact', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Section diagram');
    const alpha = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Discovery', position: 0 }, sectionResponseSchema)).data;
    const beta = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Delivery', position: 1 }, sectionResponseSchema)).data;
    const a = await createFixtureTask(f, 'Discover task', { sectionId: alpha.id }), b = await createFixtureTask(f, 'Deliver task', { sectionId: beta.id }), c = await createFixtureTask(f, 'Unsectioned task');
    const layoutPath = `${f.prefix}/projects/${f.projectId}/graph-layout`, positions = [{ taskId: a.id, x: 117, y: 251 }, { taskId: b.id, x: 528, y: 88 }, { taskId: c.id, x: 940, y: 330 }];
    const savedResponse = await page.request.put(`${APP}${layoutPath}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data: { expectedRevision: 0, positions } });
    expect(savedResponse.status()).toBe(200); const saved = graphLayoutResponseSchema.parse(await savedResponse.json()).data;
    const before = await allTasks(f), writes = observeCommands(page, f.prefix);
    try {
      await page.goto(url(f, 'view=graph'));
      await expect(page.getByRole('button', { name: 'Legacy time columns', exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Legacy weekly planning', exact: true })).toHaveCount(0);
      const graph = page.getByRole('region', { name: 'Project dependencies', exact: true });
      await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
      const choice = graph.getByRole('group', { name: 'Diagram layout', exact: true });
      await expect(choice.getByRole('button', { name: 'My layout', exact: true })).toHaveAttribute('aria-pressed', 'true');
      for (const position of positions) {
        const node = graph.locator(`.react-flow__node[data-id="${position.taskId}"]`); await expect(node).toBeVisible();
        await expect.poll(() => graphPoint(node)).toEqual({ x: position.x, y: position.y });
      }
      await choice.getByRole('button', { name: 'Section columns', exact: true }).click();
      const headers = graph.locator('[data-graph-section-header]'); await expect(headers).toHaveCount(3);
      for (const title of ['Discovery', 'Delivery', 'Unsectioned']) await expect(headers.getByRole('heading', { name: title, exact: true })).toBeVisible();
      const headerNodes = graph.locator('.react-flow__node-sectionHeading'); await expect(headerNodes).toHaveCount(3);
      expect(await headerNodes.evaluateAll(nodes => nodes.every(node => !node.classList.contains('draggable') && !node.classList.contains('selectable') && !node.hasAttribute('tabindex')))).toBe(true);
      await expect(headers.locator('button,input,a,[role="button"],.react-flow__handle')).toHaveCount(0);
      expect(await headerNodes.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id')))).not.toContain(a.id);
      await expect(graph.getByRole('button', { name: 'Save my layout', exact: true })).toBeDisabled();
      expect((await apiRead(page, layoutPath, graphLayoutResponseSchema)).data).toEqual(saved); expect(await allTasks(f)).toEqual(before); expect(writes.commands).toHaveLength(0);
      const dark = page.getByRole('button', { name: 'Dark theme', exact: true }); if (await dark.getAttribute('aria-pressed') !== 'true') await dark.click();
      await page.screenshot({ path: info.outputPath('graph-section-columns-dark.png') });
      await choice.getByRole('button', { name: 'My layout', exact: true }).click(); await expect(headers).toHaveCount(0);
      for (const position of positions) await expect.poll(() => graphPoint(graph.locator(`.react-flow__node[data-id="${position.taskId}"]`))).toEqual({ x: position.x, y: position.y });
      await page.reload(); await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
      for (const position of positions) await expect.poll(() => graphPoint(graph.locator(`.react-flow__node[data-id="${position.taskId}"]`))).toEqual({ x: position.x, y: position.y });
      expect((await apiRead(page, layoutPath, graphLayoutResponseSchema)).data).toEqual(saved); expect(await allTasks(f)).toEqual(before); expect(writes.commands).toHaveLength(0);
    } finally { writes.close(); }
  });
});
