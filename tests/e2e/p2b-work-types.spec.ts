// Real API/PG setup; binding, table entry, recovery and category report use the actual UI.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import {
  categorizedWorkLogResponseSchema, manualPeriodWorkLogResponseSchema, periodCommitmentResponseSchema,
  planningPeriodResponseSchema, projectResponseSchema, projectWorkCategoryBindingResponseSchema,
  taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, taskResponseSchema,
  taskStatusListResponseSchema, workTypeReportRunResponseSchema,
  type TaskDto, type WorkTypeReportRunDto,
} from '@workloom/contracts';

import { loadLiveData } from './support/live-api.js';

function match(response: Response, method: string, path: string) {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}
async function parse<T>(response: Response, status: number, schema: { parse(value: unknown): T }): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return schema.parse(await response.json());
}
async function setup(request: APIRequestContext, baseURL: string | undefined, name: string) {
  if (!baseURL) throw new Error('Playwright baseURL required.');
  const live = await loadLiveData(request);
  const own = live.members.find(m => m.userId === live.me.actor.id);
  if (!own) throw new Error('Current actor membership required.');
  const prefix = `/api/v1/workspaces/${live.firstWorkspace.id}`;
  const origin = new URL(baseURL).origin;
  async function post<T>(path: string, data: unknown, schema: { parse(value: unknown): T }) {
    const response = await request.post(prefix + path, { headers: { origin, 'idempotency-key': randomUUID() }, data });
    expect(response.status(), await response.text()).toBe(201);
    return schema.parse(await response.json());
  }
  const project = (await post('/projects', { name: `${name} ${randomUUID().slice(0, 8)}` }, projectResponseSchema)).data;
  const statuses = await request.get(`${prefix}/projects/${project.id}/statuses`);
  const status = taskStatusListResponseSchema.parse(await statuses.json()).data.find(x => x.group === 'todo');
  if (!status) throw new Error('Todo status required.');
  const tasks: TaskDto[] = [];
  for (const title of ['Подготовить основной выпуск', 'Ответить на запрос команды', 'Обсудить следующий шаг']) {
    tasks.push((await post('/tasks', { projectId: project.id, statusId: status.id, title, estimateMinutes: 120, participantMembershipIds: [own.id] }, taskResponseSchema)).data);
  }
  const field = (await post('/fields', { projectId: project.id, name: 'Направление работы', type: 'single_select', options: [{ name: 'Развитие', color: '#6366f1' }, { name: 'Поддержка', color: '#0d9488' }] }, taskFieldDefinitionResponseSchema)).data;
  const [a, b] = field.options; const [first, second, third] = tasks;
  if (!a || !b || !first || !second || !third) throw new Error('Complete browser category fixture required.');
  for (const [task, option] of [[first, a], [second, b]] as const) {
    const response = await request.put(`${prefix}/tasks/${task.id}/field-values/${field.id}`, { headers: { origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: option.id } } });
    expect(response.status(), await response.text()).toBe(200); taskFieldValueResponseSchema.parse(await response.json());
  }
  const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const period = (await post('/periods', { projectId: project.id, name: 'Явно выбранная неделя', localStart: monday.toISOString().slice(0, 10), timezone: 'Asia/Nicosia', cutoffAt: new Date(Date.now() + 3_600_000).toISOString() }, planningPeriodResponseSchema)).data;
  const path = `/w/${live.firstWorkspace.id}/projects/${project.id}`;
  return { live, own, prefix, origin, project, tasks: [first, second, third] as const, field, a, b, period, path };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}
async function bindUI(page: Page, f: Awaited<ReturnType<typeof setup>>, screenshot?: string) {
  await page.getByRole('button', { name: 'Типы работы', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Тип работы проекта', exact: true });
  await dialog.getByLabel('Поле типа работы', { exact: true }).selectOption(f.field.id);
  if (screenshot) await page.screenshot({ path: screenshot });
  const result = page.waitForResponse(r => match(r, 'PATCH', `${f.prefix}/projects/${f.project.id}/work-category-binding`));
  await dialog.getByRole('button', { name: 'Сохранить поле типа работы', exact: true }).click();
  const binding = (await parse(await result, 200, projectWorkCategoryBindingResponseSchema)).data;
  expect(binding.fieldId).toBe(f.field.id); await expect(dialog).toHaveCount(0);
  return binding;
}
async function factUI(page: Page, f: Awaited<ReturnType<typeof setup>>, task: TaskDto, hours: string) {
  await page.getByRole('button', { name: `Факт недели: ${task.title}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Внести факт за неделю', exact: true });
  await expect(dialog.getByLabel('Задача для факта', { exact: true })).toHaveValue(task.id);
  await expect(dialog.getByLabel('Задача для факта', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Чьи часы', { exact: true })).toHaveValue(f.own.id);
  await expect(dialog.getByLabel('Чьи часы', { exact: true })).toBeDisabled();
  await dialog.getByLabel('Факт за неделю, часы', { exact: true }).fill(hours);
  const result = page.waitForResponse(r => match(r, 'PUT', `${f.prefix}/tasks/${task.id}/manual-period-work/${f.period.id}/${f.own.id}`));
  await dialog.getByLabel('Факт за неделю, часы', { exact: true }).press('Enter');
  const log = (await parse(await result, 200, manualPeriodWorkLogResponseSchema)).data;
  await expect(dialog).toHaveCount(0);
  return log;
}
async function reportUI(page: Page, f: Awaited<ReturnType<typeof setup>>) {
  await page.getByRole('navigation', { name: 'Представление недели', exact: true }).getByRole('button', { name: 'Типы работы', exact: true }).click();
  const result = page.waitForResponse(r => match(r, 'POST', `${f.prefix}/work-type-report-runs`));
  await page.getByRole('button', { name: 'Рассчитать распределение часов', exact: true }).click();
  const run = (await parse(await result, 201, workTypeReportRunResponseSchema)).data;
  await expect(page.getByLabel('Сохранённое распределение', { exact: true })).toHaveValue(run.id);
  return run;
}
async function viewportShot(page: Page, path: string, chart = false) {
  const region = chart ? page.getByRole('figure', { name: 'Доли среди внесённых часов', exact: true }) : page.getByRole('region', { name: 'Закреплённое распределение', exact: true });
  await region.evaluate(element => window.scrollTo({ top: scrollY + element.getBoundingClientRect().top - 96, behavior: 'instant' }));
  await page.screenshot({ path });
}

test.describe('P2b desktop1440', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test('real binding and quick table entry; lost real plan response cannot replace another row draft; pinned all-fact report and reasoned recategorization', async ({ page, request, baseURL, context }, info) => {
    const f = await setup(request, baseURL, 'Часы по направлениям'); const [a, b, u] = f.tasks;
    await page.goto(f.path);
    await expect(page.getByLabel('Неделя для часов', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('Чьи часы в таблице', { exact: true })).toHaveValue(f.own.id);
    await bindUI(page, f, info.outputPath('p2b-desktop-category-binding.png'));
    await page.getByLabel('Неделя для часов', { exact: true }).selectOption(f.period.id);

    // Draft B exists before the real A request; the backend commits A while its response is lost.
    await page.getByRole('button', { name: `План недели: ${b.title}`, exact: true }).click();
    let plan = page.getByRole('dialog', { name: 'Добавить в недельный план', exact: true });
    await plan.getByLabel('Личный план, часы', { exact: true }).fill('3');
    await plan.locator('button[aria-label="Закрыть"]').click();
    await page.getByRole('button', { name: `План недели: ${a.title}`, exact: true }).click();
    plan = page.getByRole('dialog', { name: 'Добавить в недельный план', exact: true });
    await plan.getByLabel('Личный план, часы', { exact: true }).fill('2');
    await plan.getByLabel(`Распределение: ${a.title}`, { exact: true }).fill('2');
    let submitted: { key: string; body: string } | undefined;
    await page.route(`**${f.prefix}/periods/${f.period.id}/commitments`, async route => {
      submitted = { key: route.request().headers()['idempotency-key'] ?? '', body: route.request().postData() ?? '' };
      const response = await route.fetch(); expect(response.status()).toBe(201);
      expect(periodCommitmentResponseSchema.parse(await response.json()).data.workPackageId).toBe(a.workPackageId);
      await route.abort('failed');
    }, { times: 1 });
    await plan.getByRole('button', { name: 'Сохранить личный план', exact: true }).click();
    await expect(plan.getByRole('button', { name: 'Повторить отправку', exact: true })).toBeVisible();
    await plan.locator('button[aria-label="Закрыть"]').click();
    await page.getByRole('button', { name: `План недели: ${b.title}`, exact: true }).click();
    plan = page.getByRole('dialog', { name: 'Добавить в недельный план', exact: true });
    await expect(plan.getByLabel('Задача целиком', { exact: true })).toHaveValue(b.workPackageId);
    await expect(plan.getByLabel('Личный план, часы', { exact: true })).toHaveValue('3');
    await expect(plan.getByRole('button', { name: 'Сохранить личный план', exact: true })).toBeDisabled();
    await plan.locator('button[aria-label="Закрыть"]').click();
    await page.getByRole('button', { name: 'Открыть исходную отправку часов', exact: true }).click();
    plan = page.getByRole('dialog', { name: 'Добавить в недельный план', exact: true });
    await expect(plan.getByLabel('Задача целиком', { exact: true })).toHaveValue(a.workPackageId);
    await expect(plan.getByLabel('Личный план, часы', { exact: true })).toHaveValue('2:00');
    const retried = page.waitForResponse(r => match(r, 'POST', `${f.prefix}/periods/${f.period.id}/commitments`));
    await plan.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
    const retryResponse = await retried;
    expect(retryResponse.request().headers()['idempotency-key']).toBe(submitted?.key);
    expect(retryResponse.request().postData()).toBe(submitted?.body);
    await parse(retryResponse, 201, periodCommitmentResponseSchema); await expect(plan).toHaveCount(0);
    await page.getByRole('button', { name: `План недели: ${b.title}`, exact: true }).click();
    plan = page.getByRole('dialog', { name: 'Добавить в недельный план', exact: true });
    await expect(plan.getByLabel('Личный план, часы', { exact: true })).toHaveValue('3');
    const bPlanResponse = page.waitForResponse(r => match(r, 'POST', `${f.prefix}/periods/${f.period.id}/commitments`));
    await plan.getByRole('button', { name: 'Сохранить личный план', exact: true }).click();
    expect((await parse(await bPlanResponse, 201, periodCommitmentResponseSchema)).data).toMatchObject({ workPackageId: b.workPackageId, plannedMinutes: 180 });
    await expect(plan).toHaveCount(0);
    const aLog = await factUI(page, f, a, '1'); await factUI(page, f, b, '0.5'); await factUI(page, f, u, '0.5');
    await noOverflow(page); await page.screenshot({ path: info.outputPath('p2b-desktop-quick-table.png') });
    const weeks = await request.get(`${f.prefix}/periods/${f.period.id}/baselines`);
    expect((await weeks.json()).data).toEqual([]);
    await page.goto(`${f.path}/week?period=${f.period.id}`);
    const run = await reportUI(page, f);
    expect(run).toMatchObject({ totalActualMinutes: 120, categorizedMinutes: 90, uncategorizedMinutes: 30, activeSourceCount: 3 });
    expect(run.byCategory.find(x => x.optionId === f.a.id)).toMatchObject({ minutes: 60, sharePercent: 50 });
    await viewportShot(page, info.outputPath('p2b-desktop-category-report.png'));
    const editor = await context.newPage(); await editor.goto(`${f.path}?week=${f.period.id}`);
    await editor.getByRole('button', { name: `Факт недели: ${a.title}`, exact: true }).click();
    const fact = editor.getByRole('dialog', { name: 'Изменить факт за неделю', exact: true });
    await fact.getByRole('button', { name: 'Изменить тип записанной работы', exact: true }).click();
    const recat = editor.getByRole('dialog', { name: 'Изменить тип записанной работы', exact: true });
    await recat.getByLabel('Новый тип работы', { exact: true }).selectOption(f.b.id);
    await recat.getByLabel('Причина изменения типа работы', { exact: true }).fill('Работа была поддержкой команды');
    await editor.screenshot({ path: info.outputPath('p2b-desktop-recategorization.png') });
    const changedResponse = editor.waitForResponse(r => match(r, 'POST', `${f.prefix}/worklogs/${aLog.id}/recategorize`));
    await recat.getByRole('button', { name: 'Сохранить новый тип работы', exact: true }).click();
    const changed = (await parse(await changedResponse, 200, categorizedWorkLogResponseSchema)).data;
    expect(changed).toMatchObject({ id: aLog.id, minutes: 60, category: { optionId: f.b.id } });
    await editor.close();
    await page.reload();
    await expect(page.getByLabel('Сохранённое распределение', { exact: true })).toHaveValue(run.id);
    const stored = await request.get(`${f.prefix}/work-type-report-runs/${run.id}`);
    expect(workTypeReportRunResponseSchema.parse(await stored.json()).data).toEqual(run);
    const next = await reportUI(page, f);
    expect(next.byCategory.find(x => x.optionId === f.b.id)).toMatchObject({ minutes: 90, sharePercent: 75 });
    await page.getByLabel('Сохранённое распределение', { exact: true }).selectOption(run.id);
    await expect(page.getByRole('figure', { name: 'Доли среди внесённых часов', exact: true }).getByRole('img', { name: 'Развитие: 1 ч, 50%', exact: true })).toBeVisible();
    await writeFile(info.outputPath('p2b-preview.json'), JSON.stringify({ path: `${f.path}/week?period=${f.period.id}&view=work-types&typeRun=${run.id}`, projectId: f.project.id, periodId: f.period.id, runId: run.id }, null, 2));
  });
});

test.describe('P2b mobile390', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('API category binding setup; explicit week and actual table zero entry, correction reason and pinned mobile report', async ({ page, request, baseURL }, info) => {
    const f = await setup(request, baseURL, 'Мобильные типы работы'); const task = f.tasks[0];
    const bind = await request.patch(`${f.prefix}/projects/${f.project.id}/work-category-binding`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: 1, fieldId: f.field.id } });
    expect(bind.status()).toBe(200);
    const nextStart = new Date(`${f.period.localStart}T00:00:00Z`); nextStart.setUTCDate(nextStart.getUTCDate() + 7);
    const nextResponse = await request.post(`${f.prefix}/periods`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { projectId: f.project.id, name: 'Другая неделя для проверки повтора', localStart: nextStart.toISOString().slice(0, 10), timezone: 'Asia/Nicosia', cutoffAt: new Date(Date.now() + 3_600_000).toISOString() } });
    expect(nextResponse.status()).toBe(201); const nextPeriod = planningPeriodResponseSchema.parse(await nextResponse.json()).data;
    await page.goto(f.path); await expect(page.getByLabel('Неделя для часов', { exact: true })).toHaveValue('');
    await page.getByLabel('Неделя для часов', { exact: true }).selectOption(f.period.id);
    await page.getByRole('button', { name: `Факт недели: ${task.title}`, exact: true }).click();
    const firstDialog = page.getByRole('dialog', { name: 'Внести факт за неделю', exact: true });
    await firstDialog.getByLabel('Факт за неделю, часы', { exact: true }).fill('');
    await firstDialog.getByLabel('Факт за неделю, часы', { exact: true }).press('Enter');
    await expect(firstDialog.getByRole('alert')).toContainText('Введите часы за неделю');
    await firstDialog.getByLabel('Факт за неделю, часы', { exact: true }).fill('0');
    const sourcePath = `${f.prefix}/tasks/${task.id}/manual-period-work/${f.period.id}/${f.own.id}`;
    let original: { key: string; body: string } | undefined;
    await page.route(`**${sourcePath}`, async route => {
      original = { key: route.request().headers()['idempotency-key'] ?? '', body: route.request().postData() ?? '' };
      const response = await route.fetch(); expect(response.status()).toBe(200);
      expect(manualPeriodWorkLogResponseSchema.parse(await response.json()).data.minutes).toBe(0);
      await route.abort('failed');
    }, { times: 1 });
    await firstDialog.getByLabel('Факт за неделю, часы', { exact: true }).press('Enter');
    await expect(firstDialog.getByRole('button', { name: 'Повторить отправку', exact: true })).toBeVisible();
    await firstDialog.locator('button[aria-label="Закрыть"]').click();
    await page.getByLabel('Неделя для часов', { exact: true }).selectOption(nextPeriod.id);
    await expect(page.getByLabel('Неделя для часов', { exact: true })).toHaveValue(nextPeriod.id);
    await page.getByRole('button', { name: 'Открыть исходную отправку часов', exact: true }).click();
    await expect(page.getByLabel('Неделя для часов', { exact: true })).toHaveValue(f.period.id);
    const recovery = page.getByRole('dialog', { name: 'Внести факт за неделю', exact: true });
    await expect(recovery.getByLabel('Факт за неделю, часы', { exact: true })).toHaveValue('0:00');
    const recovered = page.waitForResponse(r => match(r, 'PUT', sourcePath));
    await recovery.getByRole('button', { name: 'Повторить отправку', exact: true }).click();
    const recoveredResponse = await recovered;
    expect(recoveredResponse.request().headers()['idempotency-key']).toBe(original?.key);
    expect(recoveredResponse.request().postData()).toBe(original?.body);
    const zero = (await parse(recoveredResponse, 200, manualPeriodWorkLogResponseSchema)).data;
    expect(zero).toMatchObject({ periodId: f.period.id, minutes: 0, revision: 1 }); await expect(recovery).toHaveCount(0);
    const otherWeekLogs = await request.get(`${f.prefix}/worklogs?periodId=${nextPeriod.id}`); expect((await otherWeekLogs.json()).data).toEqual([]);
    await page.reload(); await expect(page.getByLabel('Неделя для часов', { exact: true })).toHaveValue(f.period.id);
    await page.getByRole('button', { name: `Факт недели: ${task.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Изменить факт за неделю', exact: true });
    await expect(dialog.getByLabel('Факт за неделю, часы', { exact: true })).toHaveValue('0:00');
    await dialog.getByLabel('Факт за неделю, часы', { exact: true }).fill('1.5');
    await dialog.getByRole('button', { name: 'Сохранить факт за неделю', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('укажите причину');
    await dialog.getByLabel('Причина исправления', { exact: true }).fill('Уточнение после нулевой записи');
    await page.screenshot({ path: info.outputPath('p2b-mobile-quick-fact.png') });
    const corrected = page.waitForResponse(r => match(r, 'PUT', `${f.prefix}/tasks/${task.id}/manual-period-work/${f.period.id}/${f.own.id}`));
    await dialog.getByRole('button', { name: 'Сохранить факт за неделю', exact: true }).click();
    expect((await parse(await corrected, 200, manualPeriodWorkLogResponseSchema)).data).toMatchObject({ id: zero.id, revision: 2, minutes: 90 });
    await expect(dialog).toHaveCount(0); await noOverflow(page);
    await page.goto(`${f.path}/week?period=${f.period.id}`);
    const run: WorkTypeReportRunDto = await reportUI(page, f);
    expect(run).toMatchObject({ totalActualMinutes: 90, activeSourceCount: 1, categorizedMinutes: 90 });
    await viewportShot(page, info.outputPath('p2b-mobile-category-report.png'));
    await viewportShot(page, info.outputPath('p2b-mobile-category-chart.png'), true);
    await noOverflow(page); await page.reload();
    await expect(page.getByLabel('Сохранённое распределение', { exact: true })).toHaveValue(run.id);
    await expect(page.getByRole('figure', { name: 'Доли среди внесённых часов', exact: true }).getByRole('img', { name: 'Развитие: 1 ч 30 мин, 100%', exact: true })).toBeVisible();
  });
});
