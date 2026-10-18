// Private compiled Chrome gate: inline tag creation from the Tags editor on saved rows and the blank draft row.
// Actual shared-Auth cookie/API/JWKS and root-owned throwaway PG; no app server/DB lifecycle here.
// Only this spec's own POST .../tags is routed: route.fetch commits for real, then the actual ACK is held or lost.
// Auth tokens are never captured; traces/video must remain off. Proof is through the real API, not direct DB reads.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { tagListResponseSchema, tagResponseSchema, taskResponseSchema, type TaskDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import {
  PRIVATE_APP as APP, allTasks, apiRead, center, createFixtureTask, freshProject, observeCommands, openTable,
  requireValue, savedRow, showColumns, type DailyProject, type ObservedCommand,
} from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
type TagDto = ReturnType<typeof tagResponseSchema.parse>['data'];
type Rgba = [number, number, number, number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uniqueTag = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
const editTags = (page: Page, task: TaskDto) => savedRow(page, task.id).getByRole('button', { name: `Edit tags for ${task.title}`, exact: true });
const tagDialog = (page: Page) => page.getByRole('dialog', { name: 'Edit tags', exact: true });
const searchBox = (dialog: Locator) => dialog.getByRole('searchbox', { name: 'Search tags', exact: true });
const createButton = (dialog: Locator, name: string) => dialog.getByRole('button', { name: `Create tag “${name}”`, exact: true });
const tagBox = (dialog: Locator, name: string) => dialog.getByRole('checkbox', { name, exact: true });
const saveButton = (dialog: Locator) => dialog.getByRole('button', { name: 'Save', exact: true });
const recovery = (page: Page) => page.getByRole('status', { name: 'Inline tag creation', exact: true });
const retryButton = (page: Page) => recovery(page).getByRole('button', { name: 'Retry creating tag', exact: true });
const themeButton = (page: Page) => page.getByRole('button', { name: 'Dark theme', exact: true });
const draftRow = (page: Page) => page.locator('tr[data-task-draft-row][data-task-draft-state="draft"]');
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const readTask = (f: DailyProject, id: string) => apiRead(f.page, `${f.prefix}/tasks/${id}`, taskResponseSchema).then(response => response.data);
const readTags = (f: DailyProject) => apiRead(f.page, `${f.prefix}/tags`, tagListResponseSchema).then(response => response.data);
const sent = (commands: readonly ObservedCommand[]) => commands.map(({ method, path }) => ({ method, path }));
function metadata(task: TaskDto) {
  const { tags: _tags, revision: _revision, updatedAt: _updatedAt, ...rest } = task; return rest;
}
function responseTo(page: Page, method: 'POST' | 'PATCH', path: string) {
  return page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path);
}
async function rawClick(page: Page, target: Locator) {
  const point = await center(target); await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.up();
}
async function openTagEditor(page: Page, task: TaskDto) {
  const trigger = editTags(page, task); await trigger.scrollIntoViewIfNeeded(); await trigger.click();
  const dialog = tagDialog(page); await expect(dialog).toBeVisible(); return dialog;
}
async function typeSearch(page: Page, dialog: Locator, name: string) {
  const search = searchBox(dialog); await search.click(); await expect(search).toBeFocused();
  await page.keyboard.type(name); await expect(search).toHaveValue(name);
  await expect(createButton(dialog, name)).toBeVisible(); return search;
}
function expectTagPost(command: ObservedCommand | undefined, f: DailyProject, name: string) {
  const post = requireValue(command);
  expect(post.method).toBe('POST'); expect(post.path).toBe(`${f.prefix}/tags`);
  expect(JSON.parse(post.body)).toEqual({ name, color: null }); expect(post.key).toMatch(UUID); return post;
}
function expectTaskPatch(command: ObservedCommand | undefined, f: DailyProject, task: TaskDto, tagId: string) {
  const patch = requireValue(command);
  expect(patch.method).toBe('PATCH'); expect(patch.path).toBe(`${f.prefix}/tasks/${task.id}`);
  expect(JSON.parse(patch.body)).toEqual({ expectedRevision: task.revision, tagIds: [tagId] }); expect(patch.key).toMatch(UUID); return patch;
}

/**
 * Routes only the first POST of this workspace's tag collection: route.fetch performs the actual commit, then the
 * actual response is either held until release() or replaced by a safe 503 (a lost ACK). Later POSTs pass through.
 */
async function interceptFirstTagPost(page: Page, f: DailyProject, ack: 'held' | 'lost') {
  const path = `${f.prefix}/tags`, matches = (url: URL) => url.pathname === path;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let commit!: (tag: TagDto) => void, fail!: (error: unknown) => void;
  const committed = new Promise<TagDto>((resolve, reject) => { commit = resolve; fail = reject; });
  let deliver!: () => void; const answered = new Promise<void>(resolve => { deliver = resolve; });
  let intercepts = 0, status = 0;
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST' || intercepts++ > 0) return route.continue();
    try {
      const response = await route.fetch(); status = response.status();
      commit(tagResponseSchema.parse(await response.json()).data);
      if (ack === 'lost') {
        await route.fulfill({ status: 503, contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Service temporarily unavailable.' }, meta: { requestId: 'inline-tag-lost-ack' } }) });
      } else { await gate; await route.fulfill({ response }); }
      deliver();
    } catch (error) { fail(error); }
  };
  await page.route(matches, handler);
  return { committed, answered, release, status: () => status, intercepts: () => intercepts,
    stop: async () => { release(); await page.unroute(matches, handler); } };
}

async function textVisibility(text: Locator) {
  return text.evaluateAll(nodes => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas color resolution is unavailable.');
    const rgba = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1); context.fillStyle = 'rgba(0, 0, 0, 0)'; context.fillStyle = value; context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data; return [r, g, b, a];
    };
    return nodes.map(node => {
      let opacity = 1, background: [number, number, number, number] = [0, 0, 0, 0];
      for (let at: Element | null = node; at; at = at.parentElement) {
        const style = getComputedStyle(at); opacity *= Number(style.opacity);
        if (background[3] !== 255) { const color = rgba(style.backgroundColor); if (color[3] === 255) background = color; }
      }
      const style = getComputedStyle(node);
      return { text: node.textContent?.trim() ?? '', color: rgba(style.color), visibility: style.visibility, opacity, background };
    });
  });
}
function expectVisibleText(found: { text: string; color: Rgba; visibility: string; opacity: number; background: Rgba }[], name: string) {
  expect(found.length).toBeGreaterThan(0);
  for (const item of found) {
    expect(item.text).toBe(name); expect(item.visibility).toBe('visible'); expect(item.opacity).toBeGreaterThan(0);
    expect(item.color[3], 'text color alpha').toBeGreaterThan(0); expect(item.background[3], 'opaque backdrop').toBe(255);
    expect(item.color.slice(0, 3), 'text differs from its backdrop').not.toEqual(item.background.slice(0, 3));
  }
}

test.describe('inline tag creation from the Tags editor', () => {
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth native gate requires traces and video off.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });

  for (const mode of ['Enter', 'button'] as const) {
    test(`saved row ${mode} creates one held real tag, checks it locally with search focused, and patches only on Save`, async ({ page }) => {
      const f = await freshProject(page, provider, `Inline tag ${mode}`, false);
      const task = await createFixtureTask(f, `Inline tag target ${mode}`, { dueDate: '2026-11-20', estimateMinutes: 45 });
      await openTable(f); await showColumns(page, ['Tags']);
      const name = uniqueTag(`Saved ${mode}`), held = await interceptFirstTagPost(page, f, 'held'), writes = observeCommands(page, f.prefix);
      try {
        const dialog = await openTagEditor(page, task), search = await typeSearch(page, dialog, name);
        if (mode === 'Enter') await page.keyboard.press('Enter'); else await createButton(dialog, name).click();
        const tag = await held.committed; expect([200, 201]).toContain(held.status());
        expect(tag.id).toMatch(UUID); expect(tag.name).toBe(name); expect(tag.color).toBeNull();
        expect(sent(writes.commands)).toEqual([{ method: 'POST', path: `${f.prefix}/tags` }]);
        const post = expectTagPost(writes.commands[0], f, name);
        expect(await readTags(f)).toEqual([tag]);

        // Save while the actual ACK is held must not write the task.
        await rawClick(page, saveButton(dialog)); await frames(page);
        await expect(dialog).toBeVisible(); expect(sent(writes.commands)).toEqual([{ method: 'POST', path: `${f.prefix}/tags` }]);
        // Clicking Save deliberately moved focus; return it to search so the ACK can't be blamed for stealing it.
        await search.click(); await expect(search).toBeFocused();

        held.release(); await held.answered;
        await expect(tagBox(dialog, name)).toBeVisible(); await expect(tagBox(dialog, name)).toBeChecked(); await expect(search).toBeFocused();
        await frames(page); expect(writes.commands).toHaveLength(1);
        expect(await readTask(f, task.id)).toEqual(task);

        const patched = responseTo(page, 'PATCH', `${f.prefix}/tasks/${task.id}`);
        await saveButton(dialog).click(); expect((await patched).status()).toBe(200);
        await expect(savedRow(page, task.id)).toContainText(name);
        expect(sent(writes.commands)).toEqual([{ method: 'POST', path: `${f.prefix}/tags` }, { method: 'PATCH', path: `${f.prefix}/tasks/${task.id}` }]);
        const patch = expectTaskPatch(writes.commands[1], f, task, tag.id); expect(patch.key).not.toBe(post.key);
        expect(held.intercepts()).toBe(1);

        const saved = await readTask(f, task.id);
        expect(saved.revision).toBe(task.revision + 1); expect(saved.tags.map(value => value.id)).toEqual([tag.id]);
        expect(metadata(saved)).toEqual(metadata(task));
        expect(await readTags(f)).toEqual([tag]); expect(await allTasks(f)).toHaveLength(1);
      } finally { await held.stop(); writes.close(); }
    });
  }

  test('blank draft row creates a held real tag from search Enter without submitting, then Title Enter creates one tagged task', async ({ page }) => {
    const f = await freshProject(page, provider, 'Inline tag draft', false);
    const existing = await createFixtureTask(f, 'Existing inline tag row', { estimateMinutes: 30 });
    await openTable(f); await showColumns(page, ['Tags']);
    const name = uniqueTag('Draft'), title = `Drafted with tag ${randomUUID().slice(0, 8)}`;
    const held = await interceptFirstTagPost(page, f, 'held'), writes = observeCommands(page, f.prefix);
    try {
      await page.getByRole('button', { name: 'Add task without a section', exact: true }).click();
      const draft = draftRow(page); await expect(draft).toHaveCount(1);
      const titleBox = draft.getByRole('textbox', { name: 'Task name', exact: true }); await expect(titleBox).toHaveValue('');
      const tags = draft.getByRole('button', { name: 'Tags', exact: true }); await tags.scrollIntoViewIfNeeded(); await tags.click();
      const dialog = page.locator('[data-task-draft-popup]').filter({ has: page.getByRole('searchbox', { name: 'Search tags', exact: true }) });
      await expect(dialog).toBeVisible();
      const search = await typeSearch(page, dialog, name); await page.keyboard.press('Enter');

      const tag = await held.committed; expect([200, 201]).toContain(held.status()); expect(tag.name).toBe(name); expect(tag.color).toBeNull();
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: `${f.prefix}/tags` }]); expectTagPost(writes.commands[0], f, name);
      expect(await readTags(f)).toEqual([tag]);

      held.release(); await held.answered;
      await expect(tagBox(dialog, name)).toBeChecked(); await expect(search).toBeFocused();
      await frames(page); expect(writes.commands).toHaveLength(1);

      // The first Escape closes only the tags child; the draft and its empty title survive and nothing submits.
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
      await expect(draft).toHaveCount(1); await expect(titleBox).toHaveValue('');
      await frames(page); expect(writes.commands).toHaveLength(1); expect(await allTasks(f)).toEqual([existing]);

      await titleBox.click(); await expect(titleBox).toBeFocused(); await page.keyboard.type(title); await expect(titleBox).toHaveValue(title);
      const created = responseTo(page, 'POST', `${f.prefix}/tasks`); await page.keyboard.press('Enter');
      const createdResponse = await created; expect([200, 201]).toContain(createdResponse.status());
      const createdTask = taskResponseSchema.parse(await createdResponse.json()).data;
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: `${f.prefix}/tags` }, { method: 'POST', path: `${f.prefix}/tasks` }]);
      const createBody = requireValue(writes.commands[1]);
      expect(JSON.parse(createBody.body)).toMatchObject({ projectId: f.projectId, title, tagIds: [tag.id] }); expect(createBody.key).toMatch(UUID);
      expect(held.intercepts()).toBe(1);

      const saved = await readTask(f, createdTask.id);
      expect(saved.title).toBe(title); expect(saved.projectId).toBe(f.projectId); expect(saved.statusId).toBe(f.todoId);
      expect(saved.tags.map(value => value.id)).toEqual([tag.id]);
      const rows = await allTasks(f); expect(rows).toHaveLength(2);
      expect(rows.find(row => row.id === existing.id)).toEqual(existing); expect(await readTags(f)).toEqual([tag]);
    } finally { await held.stop(); writes.close(); }
  });

  test('lost tag ACK survives collapse, is never retargeted to another task, and Retry replays the same key to one tag', async ({ page }) => {
    const f = await freshProject(page, provider, 'Inline tag lost ACK', false);
    const a = await createFixtureTask(f, 'Original tag origin A', { estimateMinutes: 15 });
    const b = await createFixtureTask(f, 'Foreign tag row B', { estimateMinutes: 60 });
    await openTable(f); await showColumns(page, ['Tags']);
    const name = uniqueTag('Lost'), lost = await interceptFirstTagPost(page, f, 'lost'), writes = observeCommands(page, f.prefix);
    const tagsPath = `${f.prefix}/tags`;
    try {
      const dialogA = await openTagEditor(page, a); await typeSearch(page, dialogA, name); await page.keyboard.press('Enter');
      const original = await lost.committed; await lost.answered; expect([200, 201]).toContain(lost.status());
      expect(original.name).toBe(name); expect(original.color).toBeNull();
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: tagsPath }]);
      const first = expectTagPost(writes.commands[0], f, name);
      await expect(retryButton(page)).toBeVisible();
      await expect(dialogA.getByRole('checkbox', { name, exact: true, checked: true })).toHaveCount(0);
      expect(await readTags(f)).toEqual([original]);

      await dialogA.getByRole('button', { name: 'Collapse editor', exact: true }).click();
      await expect(tagDialog(page)).toHaveCount(0); await expect(retryButton(page)).toBeVisible();

      // B must never receive the unknown original: no checked tag, no Save, no PATCH.
      const dialogB = await openTagEditor(page, b);
      await expect(dialogB.getByRole('checkbox', { name, exact: true, checked: true })).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(tagDialog(page)).toHaveCount(0);
      await frames(page); expect(writes.commands).toHaveLength(1);

      const replayed = responseTo(page, 'POST', tagsPath); await rawClick(page, retryButton(page));
      const replay = await replayed; expect([200, 201]).toContain(replay.status());
      expect(tagResponseSchema.parse(await replay.json()).data).toEqual(original);
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: tagsPath }, { method: 'POST', path: tagsPath }]);
      const second = requireValue(writes.commands[1]); expect(second.body).toBe(first.body); expect(second.key).toBe(first.key);
      expect(lost.intercepts()).toBe(2);
      await expect(retryButton(page)).toHaveCount(0); await expect(recovery(page)).toContainText(a.title);

      const catalog = await readTags(f); expect(catalog).toHaveLength(1); expect(requireValue(catalog[0]).id).toBe(original.id);
      expect(await readTask(f, a.id)).toEqual(a); expect(await readTask(f, b.id)).toEqual(b);

      const reopened = await openTagEditor(page, a), choice = tagBox(reopened, name);
      await expect(choice).toBeVisible(); await expect(choice).not.toBeChecked();
      await rawClick(page, choice.locator('..')); await expect(choice).toBeChecked();
      await frames(page); expect(writes.commands).toHaveLength(2);
      const patched = responseTo(page, 'PATCH', `${f.prefix}/tasks/${a.id}`);
      await saveButton(reopened).click(); expect((await patched).status()).toBe(200);
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: tagsPath }, { method: 'POST', path: tagsPath }, { method: 'PATCH', path: `${f.prefix}/tasks/${a.id}` }]);
      const patch = expectTaskPatch(writes.commands[2], f, a, original.id); expect(patch.key).not.toBe(first.key);

      const savedA = await readTask(f, a.id);
      expect(savedA.revision).toBe(a.revision + 1); expect(savedA.tags.map(value => value.id)).toEqual([original.id]);
      expect(metadata(savedA)).toEqual(metadata(a));
      expect(await readTask(f, b.id)).toEqual(b); expect(await readTags(f)).toEqual(catalog); expect(await allTasks(f)).toHaveLength(2);
    } finally { await lost.stop(); writes.close(); }
  });

  test('dark mobile 390 creates a real tag with visible checked text inside the viewport and patches only on Save', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const f = await freshProject(page, provider, 'Inline tag dark390', false);
    const task = await createFixtureTask(f, 'Dark mobile tag row', { estimateMinutes: 20 });
    await openTable(f); await showColumns(page, ['Tags']);
    const html = page.locator('html'), theme = themeButton(page); await expect(theme).toBeVisible();
    if (await theme.getAttribute('aria-pressed') === 'true') { await theme.click(); await expect(html).not.toHaveAttribute('data-theme', 'dark'); }
    await theme.click(); await expect(html).toHaveAttribute('data-theme', 'dark'); await expect(theme).toHaveAttribute('aria-pressed', 'true');

    const name = uniqueTag('Dark'), writes = observeCommands(page, f.prefix), tagsPath = `${f.prefix}/tags`;
    try {
      const dialog = await openTagEditor(page, task), search = await typeSearch(page, dialog, name);
      const created = responseTo(page, 'POST', tagsPath); await page.keyboard.press('Enter');
      const createdResponse = await created; expect([200, 201]).toContain(createdResponse.status());
      const tag = tagResponseSchema.parse(await createdResponse.json()).data; expect(tag.name).toBe(name);
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: tagsPath }]); const post = expectTagPost(writes.commands[0], f, name);

      const choice = tagBox(dialog, name), text = dialog.getByText(name, { exact: true });
      await expect(choice).toBeVisible(); await expect(choice).toBeChecked(); await expect(text.first()).toBeVisible();
      await expect(search).toBeFocused(); await frames(page); expect(writes.commands).toHaveLength(1);
      await expect(html).toHaveAttribute('data-theme', 'dark');
      await page.screenshot({ path: info.outputPath('dark390-tags.png') });

      // Sub-pixel layout tolerance only; the table may overflow horizontally, the popup may not leave the viewport.
      const box = requireValue((await dialog.boundingBox()) ?? undefined);
      expect(box.x).toBeGreaterThanOrEqual(-0.5); expect(box.y).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(390.5); expect(box.y + box.height).toBeLessThanOrEqual(844.5);
      expectVisibleText(await textVisibility(text), name);

      const patched = responseTo(page, 'PATCH', `${f.prefix}/tasks/${task.id}`);
      await saveButton(dialog).click(); expect((await patched).status()).toBe(200);
      expect(sent(writes.commands)).toEqual([{ method: 'POST', path: tagsPath }, { method: 'PATCH', path: `${f.prefix}/tasks/${task.id}` }]);
      const patch = expectTaskPatch(writes.commands[1], f, task, tag.id); expect(patch.key).not.toBe(post.key);
      const saved = await readTask(f, task.id);
      expect(saved.revision).toBe(task.revision + 1); expect(saved.tags.map(value => value.id)).toEqual([tag.id]);
      expect(metadata(saved)).toEqual(metadata(task)); expect(await readTags(f)).toEqual([tag]);
    } finally { writes.close(); }
  });
});
