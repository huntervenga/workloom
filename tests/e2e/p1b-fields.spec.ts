// Real local UI -> HTTP -> PostgreSQL acceptance. Project/task setup is explicitly by API;
// desktop field definitions and values, mobile value editing and the lock transition use UI.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import {
  projectResponseSchema, taskResponseSchema, taskStatusListResponseSchema,
  taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, taskFieldValueListResponseSchema,
  type TaskFieldDefinitionDto, type TaskFieldType,
} from '@workloom/contracts';

import { openProjectActions, showAllColumns } from './support/disclosures.js';
import { loadLiveData } from './support/live-api.js';

function isCall(response: Response, method: string, path: string) {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}

async function parsed<T>(response: Response, status: number, schema: { parse(value: unknown): T }): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return schema.parse(await response.json());
}

async function closeDialog(dialog: Locator) {
  await dialog.getByRole('button', { name: "Close", exact: true }).first().click();
  await expect(dialog).toHaveCount(0);
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}

async function setup(request: APIRequestContext, baseURL: string | undefined, label: string) {
  if (!baseURL) throw new Error('Playwright baseURL is required.');
  const live = await loadLiveData(request);
  expect(['owner', 'admin']).toContain(live.firstWorkspace.role);
  const prefix = `/api/v1/workspaces/${live.firstWorkspace.id}`;
  const headers = { origin: new URL(baseURL).origin, 'idempotency-key': randomUUID() };
  const created = await request.post(`${prefix}/projects`, { headers, data: { name: `${label} ${randomUUID().slice(0, 8)}` } });
  expect(created.status(), await created.text()).toBe(201);
  const project = projectResponseSchema.parse(await created.json()).data;
  const statusesResponse = await request.get(`${prefix}/projects/${project.id}/statuses`);
  expect(statusesResponse.status()).toBe(200);
  const status = taskStatusListResponseSchema.parse(await statusesResponse.json()).data.find((item) => item.group === 'todo');
  if (!status) throw new Error('Project has no todo status.');
  const taskResponse = await request.post(`${prefix}/tasks`, {
    headers: { ...headers, 'idempotency-key': randomUUID() },
    data: { projectId: project.id, statusId: status.id, title: 'Подготовить командный пилот', estimateMinutes: 120 },
  });
  expect(taskResponse.status(), await taskResponse.text()).toBe(201);
  const task = taskResponseSchema.parse(await taskResponse.json()).data;
  return { prefix, headers, project, task, path: `/w/${live.firstWorkspace.id}/projects/${project.id}` };
}

async function openManager(page: Page) {
  await openProjectActions(page);
  await page.getByRole('main').getByRole('button', { name: "Columns", exact: true }).click();
  const manager = page.getByRole('dialog', { name: "Project columns", exact: true });
  await expect(manager).toBeVisible();
  return manager;
}

async function createFieldUI(page: Page, manager: Locator, prefix: string, name: string, type: TaskFieldType) {
  await manager.getByRole('button', { name: "Add column", exact: true }).click();
  const form = manager.getByRole('region', { name: "New column", exact: true });
  await form.getByLabel("Column name", { exact: true }).fill(name);
  await form.getByLabel("Field type", { exact: true }).selectOption(type);
  await expect(form.getByRole('checkbox', { name: "Record history", exact: true })).toBeChecked();
  const response = page.waitForResponse((item) => isCall(item, 'POST', `${prefix}/fields`));
  await form.getByRole('button', { name: "Add column", exact: true }).click();
  const field = (await parsed(await response, 201, taskFieldDefinitionResponseSchema)).data;
  expect(field).toMatchObject({ name, type, historyEnabled: true, locked: false });
  await expect(form).toHaveCount(0);
  await expect(manager.getByRole('checkbox', { name, exact: true })).toBeChecked();
  return field;
}

async function editValue(page: Page, drawer: Locator, prefix: string, taskId: string, field: TaskFieldDefinitionDto, value: string) {
  await drawer.getByRole('button', { name: `Edit “${field.name}”`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: `Value of “${field.name}”`, exact: true });
  const control = editor.getByLabel(field.name, { exact: true });
  if (field.type === 'boolean') await control.selectOption(value);
  else await control.fill(value);
  const response = page.waitForResponse((item) => isCall(item, 'PUT', `${prefix}/tasks/${taskId}/field-values/${field.id}`));
  await editor.getByRole('button', { name: "Save value", exact: true }).click();
  const result = (await parsed(await response, 200, taskFieldValueResponseSchema)).data;
  await expect(editor).toHaveCount(0);
  return result;
}

async function expectInsideTableViewport(locator: Locator) {
  const rect = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const clip = element.closest('table')?.parentElement?.getBoundingClientRect();
    if (!clip) throw new Error('Missing table viewport.');
    return { left: box.left, right: box.right, clipLeft: clip.left, clipRight: clip.right, viewport: innerWidth };
  });
  expect(rect.left).toBeGreaterThanOrEqual(rect.clipLeft - 1);
  expect(rect.right).toBeLessThanOrEqual(Math.min(rect.clipRight, rect.viewport) + 1);
}

/** A point over the underlying drawer, outside the nested dialog, must hit its backdrop. */
async function expectNestedOverlay(page: Page, topDialog: Locator) {
  const top = await topDialog.boundingBox();
  if (!top) throw new Error('Top dialog has no box.');
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Missing viewport.');
  const point = { x: viewport.width - 12, y: 12 };
  expect(point.x > top.x + top.width || point.y < top.y).toBe(true);
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      insideDialog: element.closest('[role="dialog"]') !== null,
      position: style.position, pointerEvents: style.pointerEvents, background: style.backgroundColor,
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
    };
  }, point);
  expect(hit).not.toBeNull();
  expect(hit?.insideDialog, 'underlying drawer controls must not receive pointer hits').toBe(false);
  expect(hit?.position).toBe('fixed');
  expect(hit?.pointerEvents).not.toBe('none');
  expect(hit?.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(hit?.left).toBeLessThanOrEqual(0);
  expect(hit?.top).toBeLessThanOrEqual(0);
  expect(hit?.right).toBeGreaterThanOrEqual(viewport.width);
  expect(hit?.bottom).toBeGreaterThanOrEqual(viewport.height);
}

async function expectHistoryCloseSeparated(editor: Locator, field: TaskFieldDefinitionDto) {
  const history = await editor.getByRole('button', { name: `“${field.name}” history`, exact: true }).boundingBox();
  const close = await editor.getByRole('button', { name: "Close", exact: true }).last().boundingBox();
  if (!history || !close) throw new Error('History and Close actions must have visible boxes.');
  expect(
    history.x + history.width <= close.x || close.x + close.width <= history.x ||
      history.y + history.height <= close.y || close.y + close.height <= history.y,
    'History and Close action bounds do not overlap after wrapping',
  ).toBe(true);
}

test.describe('P1b desktop 1440', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('UI creates three columns, edits typed values, reloads history and receives a real lock refusal', async ({ page, request, baseURL }, info) => {
    const fixture = await setup(request, baseURL, 'Поля командного пилота');
    await page.goto(fixture.path);
    const manager = await openManager(page);
    const text = await createFieldUI(page, manager, fixture.prefix, 'Результат пилота', 'text');
    const number = await createFieldUI(page, manager, fixture.prefix, 'Число проверок', 'number');
    const boolean = await createFieldUI(page, manager, fixture.prefix, 'Готово к запуску', 'boolean');
    await writeFile(info.outputPath('p1b-preview.json'), JSON.stringify({ path: fixture.path, taskId: fixture.task.id, projectId: fixture.project.id, fields: [text, number, boolean].map((field) => ({ id: field.id, name: field.name })) }, null, 2));
    await manager.getByRole('button', { name: `Edit column “${text.name}”`, exact: true }).click();
    const settings = manager.getByRole('region', { name: `Column “${text.name}”`, exact: true });
    await expect(settings.getByRole('checkbox', { name: "Record history", exact: true })).toBeChecked();
    await expect(settings.getByRole('checkbox', { name: "Lock values", exact: true })).not.toBeChecked();
    await page.screenshot({ path: info.outputPath('p1b-desktop-column-manager.png') });
    await closeDialog(manager);
    await showAllColumns(page);

    await page.goto(`${fixture.path}?task=${fixture.task.id}`);
    const drawer = page.getByRole('dialog', { name: fixture.task.title, exact: true });
    const first = await editValue(page, drawer, fixture.prefix, fixture.task.id, text, 'Проверить совместную работу');
    expect(first.value).toEqual({ type: 'text', value: 'Проверить совместную работу' });
    const zero = await editValue(page, drawer, fixture.prefix, fixture.task.id, number, '0');
    expect(zero.value).toEqual({ type: 'number', value: 0 });
    const falseValue = await editValue(page, drawer, fixture.prefix, fixture.task.id, boolean, 'false');
    expect(falseValue.value).toEqual({ type: 'boolean', value: false });
    const second = await editValue(page, drawer, fixture.prefix, fixture.task.id, text, 'Команда проверила пилот');
    expect(second.revision).toBe(first.revision + 1);
    await page.reload();
    await expect(drawer.getByText('Команда проверила пилот', { exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: `“${text.name}” history`, exact: true }).click();
    const history = page.getByRole('dialog', { name: `History of “${text.name}”`, exact: true });
    await expect(history.getByRole('list', { name: `Changes to “${text.name}”`, exact: true }).getByRole('listitem')).toHaveCount(2);
    await expect(history).toContainText('Проверить совместную работу');
    await expect(history).toContainText('Команда проверила пилот');
    await expectNestedOverlay(page, history);
    await page.screenshot({ path: info.outputPath('p1b-desktop-value-history.png') });
    await closeDialog(history);
    await closeDialog(drawer);

    const table = page.getByRole('main').getByRole('table');
    const estimate = table.getByRole('columnheader', { name: "Team estimate", exact: true });
    await expectInsideTableViewport(estimate);
    await expectInsideTableViewport(table.locator('tfoot').getByRole('cell').last());
    await table.evaluate((element) => { if (element.parentElement) element.parentElement.scrollLeft = element.parentElement.scrollWidth; });
    for (const field of [text, number, boolean]) {
      const header = table.getByRole('columnheader', { name: field.name, exact: true });
      await expect(header).toBeVisible();
      await expectInsideTableViewport(header);
    }
    await expectInsideTableViewport(estimate);
    await expectInsideTableViewport(table.getByRole('button', { name: fixture.task.title, exact: true }));
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p1b-desktop-custom-table.png'), fullPage: true });

    // The editor has an old, still-unlocked definition. Another real UI page locks it while
    // this unsent draft stays open. A genuine PUT must be refused by current server policy.
    await page.goto(`${fixture.path}?task=${fixture.task.id}`);
    await drawer.getByRole('button', { name: `Edit “${text.name}”`, exact: true }).click();
    const editor = page.getByRole('dialog', { name: `Value of “${text.name}”`, exact: true });
    await editor.getByLabel(text.name, { exact: true }).fill('Эта правка заблокирована');
    await expectHistoryCloseSeparated(editor, text);
    await expectNestedOverlay(page, editor);
    await page.screenshot({ path: info.outputPath('p1b-desktop-value-editor.png') });
    const other = await page.context().newPage();
    await other.goto(fixture.path);
    const otherManager = await openManager(other);
    await otherManager.getByRole('button', { name: `Edit column “${text.name}”`, exact: true }).click();
    const otherSettings = otherManager.getByRole('region', { name: `Column “${text.name}”`, exact: true });
    await otherSettings.getByRole('checkbox', { name: "Lock values", exact: true }).check();
    const lockedResponse = other.waitForResponse((item) => isCall(item, 'PATCH', `${fixture.prefix}/fields/${text.id}`));
    await otherSettings.getByRole('button', { name: "Save", exact: true }).click();
    expect((await parsed(await lockedResponse, 200, taskFieldDefinitionResponseSchema)).data.locked).toBe(true);
    await other.close();
    const refused = page.waitForResponse((item) => isCall(item, 'PUT', `${fixture.prefix}/tasks/${fixture.task.id}/field-values/${text.id}`));
    await editor.getByRole('button', { name: "Save value", exact: true }).click();
    const refusal = await refused;
    expect(refusal.status(), await refusal.text()).toBe(409);
    expect((await refusal.json() as { error: { code: string } }).error.code).toBe('FIELD_LOCKED');
    await expect(editor).toContainText('locked');
    await page.screenshot({ path: info.outputPath('p1b-desktop-lock-refusal.png') });
    const persistedResponse = await request.get(`${fixture.prefix}/tasks/${fixture.task.id}/field-values`);
    expect(persistedResponse.status()).toBe(200);
    const persisted = taskFieldValueListResponseSchema.parse(await persistedResponse.json()).data.find((item) => item.fieldId === text.id);
    expect(persisted).toEqual(second);
  });
});

test.describe('P1b mobile 390', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('API setup: manager controls and drawer remain reachable; UI edits a number and reloads its history', async ({ page, request, baseURL }, info) => {
    const fixture = await setup(request, baseURL, 'Мобильные поля пилота');
    const definitions: TaskFieldDefinitionDto[] = [];
    for (const [name, type] of [['Результат пилота', 'text'], ['Число проверок', 'number'], ['Готово к запуску', 'boolean']] as const) {
      const response = await request.post(`${fixture.prefix}/fields`, {
        headers: { ...fixture.headers, 'idempotency-key': randomUUID() }, data: { projectId: fixture.project.id, name, type },
      });
      expect(response.status(), await response.text()).toBe(201);
      definitions.push(taskFieldDefinitionResponseSchema.parse(await response.json()).data);
    }
    const number = definitions.find((field) => field.type === 'number');
    if (!number) throw new Error('Number field missing.');
    await page.goto(fixture.path);
    const manager = await openManager(page);
    await manager.getByRole('button', { name: `Edit column “${number.name}”`, exact: true }).click();
    const settings = manager.getByRole('region', { name: `Column “${number.name}”`, exact: true });
    await settings.getByRole('checkbox', { name: "Lock values", exact: true }).scrollIntoViewIfNeeded();
    await expect(settings.getByRole('checkbox', { name: "Record history", exact: true })).toBeVisible();
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p1b-mobile-column-manager.png') });
    await closeDialog(manager);
    await showAllColumns(page);
    await page.goto(`${fixture.path}?task=${fixture.task.id}`);
    const drawer = page.getByRole('dialog', { name: fixture.task.title, exact: true });
    const fieldButton = drawer.getByRole('button', { name: `Edit “${number.name}”`, exact: true });
    await fieldButton.scrollIntoViewIfNeeded();
    const save = drawer.getByRole('button', { name: "Save", exact: true });
    const footer = save.locator('xpath=..');
    const geometry = await fieldButton.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { bottom: rect.bottom, uncovered: hit !== null && button.contains(hit) };
    });
    const panel = await footer.boundingBox();
    expect(panel).not.toBeNull();
    expect(geometry.bottom).toBeLessThanOrEqual((panel?.y ?? 0) + 1);
    expect(geometry.uncovered).toBe(true);
    await expect(save).toBeVisible();
    await page.screenshot({ path: info.outputPath('p1b-mobile-task-fields.png') });
    const value = await editValue(page, drawer, fixture.prefix, fixture.task.id, number, '7');
    expect(value.value).toEqual({ type: 'number', value: 7 });
    await page.reload();
    await drawer.getByRole('button', { name: `“${number.name}” history`, exact: true }).click();
    const history = page.getByRole('dialog', { name: `History of “${number.name}”`, exact: true });
    await expect(history.getByRole('list', { name: `Changes to “${number.name}”`, exact: true }).getByRole('listitem')).toHaveCount(1);
    await expect(history).toContainText('7');
    await expectNestedOverlay(page, history);
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p1b-mobile-value-history.png') });
  });
});
