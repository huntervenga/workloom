// Root-owned compiled QA only. Fixtures use actual shared-BFF/API and private PostgreSQL.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type Route } from '@playwright/test';
import { sectionListResponseSchema, tagListResponseSchema, tagResponseSchema, taskResponseSchema, type TaskDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, center, createFixtureTask, freshProject, observeCommands, requireValue, type DailyProject } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const card = (page: Page, id: string) => page.locator(`[data-board-card="${id}"]`);
const lane = (page: Page, id: string) => page.locator(`[data-board-status="${id}"]`);
const readTask = (f: DailyProject, id: string) => apiRead(f.page, `${f.prefix}/tasks/${id}`, taskResponseSchema).then(value => value.data);
const projectUrl = (f: DailyProject, view: string) => `${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=${view}`;
const stableTask = (task: TaskDto) => { const { statusId: _status, revision: _revision, updatedAt: _updated, ...rest } = task; return rest; };
async function dragTo(page: Page, task: TaskDto, statusId: string) {
  const from = await center(card(page, task.id).getByRole('button', { name: `Drag task: ${task.title}`, exact: true }));
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + 8, from.y + 1);
  await expect(page.getByTestId('board-drag-preview')).toBeVisible();
  // On narrow screens scroll the real lane viewport while retaining this same pointer interaction.
  const destination = lane(page, statusId); await destination.locator('h3').scrollIntoViewIfNeeded();
  const to = await center(destination.locator('h3')); await page.mouse.move(to.x, to.y, { steps: 8 });
  await expect(destination).toHaveAttribute('data-board-drop', 'active');
  await expect(destination.locator('[data-board-drop-placeholder]')).toBeVisible();
}
async function tagManager(page: Page) {
  await page.locator('summary[aria-label="Project actions"]').click();
  await page.getByRole('button', { name: 'Tags', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Workspace tags', exact: true }); await expect(dialog).toBeVisible(); return dialog;
}

test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth gate requires trace/video off.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

for (const width of [1440, 390]) test.describe(`Board pointer and tag colors ${width}`, () => {
  test.use({ viewport: { width, height: 1000 } });


  test('real ghost and lane feedback cancel cleanly, then one held status command confirms without optimistic movement', async ({ page }) => {
    const f = await freshProject(page, provider, 'Board pointer');
    const source = await createFixtureTask(f, 'Board pointer source', { dueDate: '2035-04-06', estimateMinutes: 75 });
    const target = requireValue(f.statuses.find(status => status.group === 'in_progress'));
    await page.goto(projectUrl(f, 'board')); await expect(card(page, source.id)).toBeVisible();
    const writes = observeCommands(page, f.prefix);
    await dragTo(page, source, target.id); await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.getByTestId('board-drag-preview')).toHaveCount(0); expect(writes.commands).toEqual([]); expect(await readTask(f, source.id)).toEqual(source);

    let release!: () => void, delivered!: () => void, committed!: (task: TaskDto) => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const answered = new Promise<void>(resolve => { delivered = resolve; });
    const stored = new Promise<TaskDto>(resolve => { committed = resolve; });
    const path = `${f.prefix}/tasks/${source.id}`;
    const handler = async (route: Route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(200);
      committed(taskResponseSchema.parse(await response.json()).data); await hold; await route.fulfill({ response }); delivered();
    };
    const matches = (url: URL) => url.pathname === path;
    await page.route(matches, handler);
    try {
      await dragTo(page, source, target.id); await page.mouse.up(); const confirmed = await stored;
      expect(confirmed.statusId).toBe(target.id); expect(stableTask(confirmed)).toEqual(stableTask(source));
      expect(writes.commands).toHaveLength(1); expect(JSON.parse(requireValue(writes.commands[0]).body)).toEqual({ expectedRevision: source.revision, statusId: target.id });
      expect(requireValue(writes.commands[0]).key).toMatch(/^[0-9a-f-]{36}$/i);
      await expect(lane(page, f.todoId).locator(`[data-board-card="${source.id}"]`)).toBeVisible();
      release(); await answered; await expect(lane(page, target.id).locator(`[data-board-card="${source.id}"]`)).toBeVisible();
      expect(await readTask(f, source.id)).toEqual(confirmed); expect(writes.commands).toHaveLength(1);
    } finally { release(); await page.unroute(matches, handler); }
    // Clicking the card's padding opens its saved task; it is not another drag/status write.
    await card(page, source.id).click({ position: { x: 5, y: 5 } });
    await expect(page).toHaveURL(url => url.searchParams.get('task') === source.id); expect(writes.commands).toHaveLength(1);
    writes.close();
  });

  test('tag palette saves only color with exact unknown retry; section creation is discoverable under Assignee', async ({ page }) => {
    const f = await freshProject(page, provider, 'Tag palette');
    const created = (await apiWrite(page, `${f.prefix}/tags`, { name: `Palette ${randomUUID().slice(0, 8)}`, color: null }, tagResponseSchema)).data;
    const task = await createFixtureTask(f, 'Colored task', { tagIds: [created.id] });
    await page.goto(projectUrl(f, 'board')); await expect(card(page, task.id).locator(`[data-tag-badge="${created.id}"]`)).toBeVisible();
    const before = await readTask(f, task.id), writes = observeCommands(page, f.prefix);
    let first = true;
    const path = `${f.prefix}/tags/${created.id}`;
    const handler = async (route: Route) => {
      if (route.request().method() !== 'PATCH' || !first) return route.continue();
      first = false; const response = await route.fetch(); expect(response.status()).toBe(200);
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Color ACK unavailable.' }, meta: { requestId: 'color-ack' } }) });
    };
    const matches = (url: URL) => url.pathname === path;
    await page.route(matches, handler);
    try {
      let dialog = await tagManager(page);
      await dialog.getByRole('button', { name: `Color for ${created.name}`, exact: true }).click();
      const red = dialog.getByRole('radio', { name: 'Red', exact: true }); await red.focus(); await page.keyboard.press('Space');
      await expect(dialog.getByRole('button', { name: 'Retry original color change', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: `Color for ${created.name}`, exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click(); dialog = await tagManager(page);
      await dialog.getByRole('button', { name: 'Retry original color change', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Retry original color change', exact: true })).toHaveCount(0);
      expect(writes.commands).toHaveLength(2);
      expect(writes.commands.map(command => ({ method: command.method, path: command.path, body: JSON.parse(command.body) }))).toEqual([
        { method: 'PATCH', path, body: { expectedRevision: created.revision, color: '#ef4444' } },
        { method: 'PATCH', path, body: { expectedRevision: created.revision, color: '#ef4444' } },
      ]);
      expect(requireValue(writes.commands[0]).key).toMatch(/^[0-9a-f-]{36}$/i);
      expect(requireValue(writes.commands[1]).key).toBe(requireValue(writes.commands[0]).key);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      const saved = requireValue((await apiRead(page, `${f.prefix}/tags`, tagListResponseSchema)).data.find(tag => tag.id === created.id));
      expect(saved.color).toBe('#ef4444'); expect(saved.revision).toBe(created.revision + 1);
      const after = await readTask(f, task.id); expect({ ...after, tags: before.tags }).toEqual(before); expect(after.tags.map(tag => tag.id)).toEqual([created.id]);
      await page.reload(); const chip = card(page, task.id).locator(`[data-tag-badge="${created.id}"]`);
      for (const dark of [false, true]) {
        const theme = page.getByRole('button', { name: 'Dark theme', exact: true });
        if ((await theme.getAttribute('aria-pressed')) !== String(dark)) await theme.click();
        await expect(chip).toHaveAttribute('data-tag-color', '#ef4444');
        const paint = await chip.evaluate(node => { const style = getComputedStyle(node); return { text: style.color, fill: style.backgroundColor, border: style.borderColor, textContent: node.textContent }; });
        expect(paint.textContent).toContain(created.name); expect(paint.text).not.toBe(paint.fill); expect(paint.border).not.toBe('rgba(0, 0, 0, 0)');
      }
    } finally { await page.unroute(matches, handler); writes.close(); }

    await page.goto(projectUrl(f, 'table'));
    await page.getByRole('combobox', { name: 'Group by', exact: true }).click();
    await page.getByRole('option', { name: 'Assignee', exact: true }).click();
    const sectionName = `Visible section ${randomUUID().slice(0, 8)}`;
    const beforeSection = await readTask(f, task.id), sectionWrites = observeCommands(page, f.prefix);
    await page.getByRole('button', { name: 'New section', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'New section', exact: true });
    await create.getByRole('textbox', { name: 'Section name', exact: true }).fill(sectionName);
    await create.getByRole('button', { name: 'Create section', exact: true }).click(); await expect(create).toHaveCount(0);
    const sections = (await apiRead(page, `${f.prefix}/projects/${f.projectId}/sections`, sectionListResponseSchema)).data;
    expect(sections.filter(section => section.name === sectionName)).toHaveLength(1);
    expect(sectionWrites.commands.filter(command => command.method === 'POST' && command.path === `${f.prefix}/projects/${f.projectId}/sections`)).toHaveLength(1);
    expect(await readTask(f, task.id)).toEqual(beforeSection); sectionWrites.close();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  });
});
