// Actual UI/API/PostgreSQL P4a: keyboard forms, hidden/cross-project blockers and own-layout retry.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { dependencyGraphResponseSchema, graphLayoutResponseSchema, projectResponseSchema, taskDependencyResponseSchema, taskResponseSchema, taskStatusListResponseSchema } from '@workloom/contracts';

import { loadLiveData } from './support/live-api.js';

async function setup(request: APIRequestContext, baseURL: string | undefined, label: string) {
  if (!baseURL) throw new Error('Browser baseURL required.');
  const live = await loadLiveData(request), prefix = `/api/v1/workspaces/${live.firstWorkspace.id}`, origin = new URL(baseURL).origin;
  async function send(method: 'POST' | 'PUT', path: string, data: unknown) {
    const response = await request.fetch(prefix + path, { method, headers: { origin, 'idempotency-key': randomUUID() }, data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  }
  const project = projectResponseSchema.parse(await send('POST', '/projects', { name: `${label} ${randomUUID().slice(0, 6)}` })).data;
  const other = projectResponseSchema.parse(await send('POST', '/projects', { name: `Смежная команда ${randomUUID().slice(0, 6)}` })).data;
  async function task(projectId: string, title: string) {
    const response = await request.get(`${prefix}/projects/${projectId}/statuses`); expect(response.status()).toBe(200);
    const statuses = taskStatusListResponseSchema.parse(await response.json()).data, todo = statuses.find(s => s.group === 'todo'); if (!todo) throw new Error('Todo status required.');
    return taskResponseSchema.parse(await send('POST', '/tasks', { projectId, title, statusId: todo.id, estimateMinutes: 120 })).data;
  }
  const a = await task(project.id, 'Подготовить исходные данные'), b = await task(project.id, 'Опубликовать результат команды'), c = await task(other.id, 'Согласовать внешний источник');
  const seeded = graphLayoutResponseSchema.parse(await send('PUT', `/projects/${project.id}/graph-layout`, { expectedRevision: 0, positions: [{ taskId: c.id, x: 700, y: 300 }, { taskId: b.id, x: 300, y: 0 }] })).data;
  const path = `/w/${live.firstWorkspace.id}/projects/${project.id}`;
  return { request, live, prefix, project, other, a, b, c, path, seeded };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function pathOf(url: string) { return new URL(url).pathname; }
async function noPageOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }
async function layout(f: Fixture) {
  const r = await f.request.get(`${f.prefix}/projects/${f.project.id}/graph-layout`); expect(r.status()).toBe(200); return graphLayoutResponseSchema.parse(await r.json()).data;
}
async function closeTop(page: Page, dialog: Locator) {
  await dialog.locator('button[aria-label="Закрыть"]').click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-state="closed"][role="dialog"]')).toHaveCount(0);
}
async function openTask(page: Page, f: Fixture) {
  await page.getByRole('button', { name: f.b.title, exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: f.b.title, exact: true }); await expect(dialog).toBeVisible(); return dialog;
}
async function addIncoming(page: Page, f: Fixture, task: Fixture['a'], projectId: string, capturePath?: string) {
  const card = page.getByRole('dialog', { name: f.b.title, exact: true });
  const action = card.getByRole('region', { name: 'Связи задачи', exact: true }).getByRole('button', { name: 'Добавить связь', exact: true });
  await action.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Добавить связь задач', exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Направление связи', exact: true }).selectOption('incoming');
  await dialog.getByRole('combobox', { name: 'Проект связанной задачи', exact: true }).selectOption(projectId);
  await dialog.getByLabel('Поиск связанной задачи', { exact: true }).fill(task.title);
  await expect(dialog.getByRole('combobox', { name: 'Связанная задача', exact: true }).getByRole('option', { name: task.title, exact: true })).toHaveCount(1);
  await dialog.getByRole('combobox', { name: 'Связанная задача', exact: true }).selectOption(task.id);
  if (capturePath) { await noPageOverflow(page); await page.screenshot({ path: capturePath }); }
  const response = page.waitForResponse(r => r.request().method() === 'POST' && pathOf(r.url()) === `${f.prefix}/dependencies`);
  await dialog.getByRole('button', { name: 'Добавить связь', exact: true }).focus(); await page.keyboard.press('Enter');
  const r = await response; expect(r.status(), await r.text()).toBe(201); const edge = taskDependencyResponseSchema.parse(await r.json()).data;
  await expect(dialog).toHaveCount(0); return edge;
}
async function graphMode(page: Page, f: Fixture) {
  await page.getByRole('checkbox', { name: `Выбрать для графа: ${f.b.title}`, exact: true }).check();
  await page.getByRole('button', { name: 'Граф выбранных (1)', exact: true }).click();
  const region = page.getByRole('region', { name: 'Зависимости проекта', exact: true }); await expect(region).toBeVisible();
  await expect(region.getByRole('list', { name: 'Задачи и связи графа', exact: true })).toBeVisible(); return region;
}
async function moveNode(region: Locator, f: Fixture) {
  const row = region.getByRole('list', { name: 'Задачи и связи графа', exact: true }).getByRole('listitem').filter({ has: region.page().getByRole('button', { name: f.b.title, exact: true }) });
  await row.locator('summary').click(); await row.getByRole('button', { name: `Вправо: ${f.b.title}`, exact: true }).click();
}

test.describe('P4a desktop1440', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test('creates and restores cross-project dependencies through forms and saves own layout without losing hidden positions', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000); const f = await setup(request, baseURL, 'Граф запуска команды'); await page.goto(f.path);
    await page.getByLabel('Поиск задач', { exact: true }).fill(f.b.title);
    await expect(page.getByRole('button', { name: f.a.title, exact: true })).toHaveCount(0);
    const card = await openTask(page, f), edge = await addIncoming(page, f, f.a, f.project.id);
    await addIncoming(page, f, f.c, f.other.id);
    const panel = card.getByRole('region', { name: 'Связи задачи', exact: true });
    await expect(panel.getByText('Незавершённых предшественников: 2', { exact: true })).toBeVisible();
    await expect(panel.getByRole('link', { name: f.c.title, exact: true })).toHaveAttribute('href', new RegExp(f.other.id));
    await panel.locator('summary').click();
    const edgeRow = panel.locator('details').getByRole('listitem').filter({ has: page.getByRole('button', { name: f.a.title, exact: true }) });
    const remove = page.waitForResponse(r => r.request().method() === 'PATCH' && pathOf(r.url()) === `${f.prefix}/dependencies/${edge.id}`);
    await edgeRow.getByRole('button', { name: 'Снять связь', exact: true }).click(); expect((await remove).status()).toBe(200);
    const restore = page.waitForResponse(r => r.request().method() === 'PATCH' && pathOf(r.url()) === `${f.prefix}/dependencies/${edge.id}`);
    await edgeRow.getByRole('button', { name: 'Восстановить связь', exact: true }).click(); const restored = await restore;
    expect(taskDependencyResponseSchema.parse(await restored.json()).data).toMatchObject({ id: edge.id, revision: 3, state: 'active' });
    await panel.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('p4a-desktop-blockers.png') }); await closeTop(page, card);
    const region = await graphMode(page, f);
    await region.getByLabel('Уровней соседей', { exact: true }).selectOption('0');
    await expect(region.getByRole('list', { name: 'Задачи и связи графа', exact: true }).getByRole('listitem')).toHaveCount(1);
    await expect(region.getByText(/за пределами выбранного графа: 2/)).toBeVisible();
    await moveNode(region, f);
    const save = page.waitForResponse(r => r.request().method() === 'PUT' && pathOf(r.url()) === `${f.prefix}/projects/${f.project.id}/graph-layout`);
    await region.getByRole('button', { name: 'Сохранить мою раскладку', exact: true }).click(); expect((await save).status()).toBe(200);
    let saved = await layout(f); expect(saved.revision).toBe(2); expect(saved.positions).toEqual(expect.arrayContaining([{ taskId: f.c.id, x: 700, y: 300 }, { taskId: f.b.id, x: 320, y: 0 }]));
    await region.getByLabel('Уровней соседей', { exact: true }).selectOption('1');
    await expect(region.getByRole('list', { name: 'Задачи и связи графа', exact: true }).getByRole('listitem')).toHaveCount(3);
    // Actual reset→arrange→nonempty save must clear the reset intent, never offer a destructive second save.
    const refreshGraph = region.getByRole('button', { name: 'Обновить граф', exact: true });
    await expect(refreshGraph).toBeEnabled();
    const refreshedGraph = page.waitForResponse(r => r.request().method() === 'GET' && pathOf(r.url()) === `${f.prefix}/projects/${f.project.id}/graph` && new URL(r.url()).searchParams.get('neighborDepth') === '1');
    await refreshGraph.click(); expect((await refreshedGraph).status()).toBe(200); await expect(refreshGraph).toBeEnabled();
    await region.getByRole('button', { name: 'Сбросить все мои позиции', exact: true }).click();
    const arrange = region.getByRole('button', { name: 'Применить автоматическую раскладку', exact: true });
    await arrange.click(); await expect(arrange).toBeEnabled();
    const saveAgain = region.getByRole('button', { name: 'Сохранить мою раскладку', exact: true }); await expect(saveAgain).toBeEnabled();
    const arrangedResponse = page.waitForResponse(r => r.request().method() === 'PUT' && pathOf(r.url()) === `${f.prefix}/projects/${f.project.id}/graph-layout`);
    await saveAgain.click(); expect((await arrangedResponse).status()).toBe(200);
    saved = await layout(f); expect(saved.revision).toBe(3); expect(saved.positions).toHaveLength(3); await expect(saveAgain).toBeDisabled();
    const policy = region.getByRole('region', { name: 'Правило блокировок проекта', exact: true });
    await policy.getByRole('combobox', { name: 'Режим зависимостей', exact: true }).selectOption('enforce');
    const policyResponse = page.waitForResponse(r => r.request().method() === 'PATCH' && pathOf(r.url()) === `${f.prefix}/projects/${f.project.id}/dependency-policy`);
    await policy.getByRole('button', { name: 'Сохранить правило блокировок', exact: true }).click(); expect((await policyResponse).status()).toBe(200);
    await region.getByRole('button', { name: 'Диаграмма', exact: true }).click();
    const canvas = region.getByRole('region', { name: 'Граф зависимостей', exact: true }); await expect(canvas).toBeVisible(); await canvas.scrollIntoViewIfNeeded();
    await expect(canvas.getByRole('button', { name: 'Показать весь выбранный граф', exact: true })).toBeVisible();
    await noPageOverflow(page); await page.screenshot({ path: info.outputPath('p4a-desktop-graph.png') });
    await page.reload(); await expect(page.getByRole('region', { name: 'Зависимости проекта', exact: true })).toBeVisible(); expect(await layout(f)).toEqual(saved);
    const response = await request.get(`${f.prefix}/projects/${f.project.id}/graph?rootTaskIds=${f.b.id}&neighborDepth=1`); const g = dependencyGraphResponseSchema.parse(await response.json()).data;
    expect(g.nodes.find(n => n.task.id === f.c.id)?.context.project.id).toBe(f.other.id);
    await writeFile(info.outputPath('p4a-desktop-demo.json'), JSON.stringify({ url: new URL(f.path + '?view=graph', baseURL).href, projectId: f.project.id, taskId: f.b.id }, null, 2));
  });
});

test.describe('P4a mobile390', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('uses cross-project keyboard forms and retries the original committed full layout exactly', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000); const f = await setup(request, baseURL, 'Личная мобильная раскладка'); await page.goto(f.path);
    const card = await openTask(page, f); await addIncoming(page, f, f.c, f.other.id, info.outputPath('p4a-mobile-edge-form.png'));
    const panel = card.getByRole('region', { name: 'Связи задачи', exact: true }); await expect(panel.getByText('Незавершённых предшественников: 1', { exact: true })).toBeVisible();
    await panel.scrollIntoViewIfNeeded(); await noPageOverflow(page); await page.screenshot({ path: info.outputPath('p4a-mobile-blockers.png') }); await closeTop(page, card);
    const region = await graphMode(page, f); await region.getByLabel('Уровней соседей', { exact: true }).selectOption('0');
    await expect(region.getByRole('list', { name: 'Задачи и связи графа', exact: true }).getByRole('listitem')).toHaveCount(1); await moveNode(region, f);
    const target = `${f.prefix}/projects/${f.project.id}/graph-layout`, sent: { key: string | undefined; body: string | null }[] = []; let lost = false;
    await page.route(`**${target}`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      sent.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      const response = await route.fetch(); expect(response.status()).toBe(200);
      if (!lost) { lost = true; await route.abort('failed'); } else await route.fulfill({ response });
    });
    await region.getByRole('button', { name: 'Сохранить мою раскладку', exact: true }).click();
    const retry = page.getByRole('button', { name: 'Повторить исходную отправку', exact: true }); await expect(retry).toBeVisible();
    expect((await layout(f)).revision).toBe(2);
    await region.getByLabel('Уровней соседей', { exact: true }).selectOption('1');
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && pathOf(r.url()) === target);
    await retry.click(); expect((await response).status()).toBe(200); await expect(retry).toHaveCount(0); expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]);
    const saved = await layout(f); expect(saved.revision).toBe(2); expect(saved.positions).toEqual(expect.arrayContaining([{ taskId: f.c.id, x: 700, y: 300 }, { taskId: f.b.id, x: 320, y: 0 }]));
    await page.reload(); const current = page.getByRole('region', { name: 'Зависимости проекта', exact: true }); await expect(current).toBeVisible(); expect(await layout(f)).toEqual(saved);
    await current.getByRole('button', { name: 'Диаграмма', exact: true }).click(); const canvas = current.getByRole('region', { name: 'Граф зависимостей', exact: true }); await expect(canvas).toBeVisible(); await canvas.scrollIntoViewIfNeeded();
    await noPageOverflow(page); await page.screenshot({ path: info.outputPath('p4a-mobile-graph.png') });
    await current.getByRole('region', { name: 'Моя раскладка графа', exact: true }).scrollIntoViewIfNeeded(); await noPageOverflow(page); await page.screenshot({ path: info.outputPath('p4a-mobile-layout.png') });
    await writeFile(info.outputPath('p4a-mobile-demo.json'), JSON.stringify({ url: new URL(f.path + '?view=graph', baseURL).href, projectId: f.project.id, taskId: f.b.id }, null, 2));
  });
});
