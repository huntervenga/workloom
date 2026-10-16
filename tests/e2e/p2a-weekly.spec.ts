// Actual UI weekly cycle against Fastify/PostgreSQL. API-created tasks are labelled setup;
// period/plan/freeze/facts/reports on desktop and fact/report on mobile are real UI commands.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page, type Request, type Response } from '@playwright/test';
import {
  freezePreviewResponseSchema, manualPeriodWorkLogResponseSchema, periodCommitmentResponseSchema,
  planBaselineResponseSchema, planningPeriodResponseSchema, projectResponseSchema,
  taskResponseSchema, taskStatusListResponseSchema, weeklyPlanFactReportRunResponseSchema,
  type PlanningPeriodDto, type PlanBaselineDto,
} from '@workloom/contracts';

import { loadLiveData } from './support/live-api.js';

function call(response: Response, method: string, path: string) {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}
async function parsed<T>(response: Response, status: number, schema: { parse(value: unknown): T }): Promise<T> {
  expect(response.status(), await response.text()).toBe(status);
  return schema.parse(await response.json());
}
async function setup(request: APIRequestContext, baseURL: string | undefined, estimate: number, label: string) {
  if (!baseURL) throw new Error('Playwright baseURL is required.');
  const live = await loadLiveData(request);
  const own = live.members.find((item) => item.userId === live.me.actor.id);
  if (!own) throw new Error('Current actor has no live membership.');
  expect(['owner', 'admin']).toContain(own.role);
  const prefix = `/api/v1/workspaces/${live.firstWorkspace.id}`;
  const origin = new URL(baseURL).origin;
  const post = async <T>(path: string, data: unknown, status: number, schema: { parse(value: unknown): T }) => {
    const response = await request.post(prefix + path, { headers: { origin, 'idempotency-key': randomUUID() }, data });
    expect(response.status(), await response.text()).toBe(status);
    return schema.parse(await response.json());
  };
  const project = (await post('/projects', { name: `${label} ${randomUUID().slice(0, 8)}` }, 201, projectResponseSchema)).data;
  const statusResponse = await request.get(`${prefix}/projects/${project.id}/statuses`);
  expect(statusResponse.status()).toBe(200);
  const status = taskStatusListResponseSchema.parse(await statusResponse.json()).data.find((item) => item.group === 'todo');
  if (!status) throw new Error('Project has no todo status.');
  const root = (await post('/tasks', { projectId: project.id, statusId: status.id, title: 'Подготовить командный пилот', estimateMinutes: estimate, participantMembershipIds: [own.id] }, 201, taskResponseSchema)).data;
  const path = `/w/${live.firstWorkspace.id}/projects/${project.id}/week`;
  return { live, own, prefix, origin, post, project, root, path, status };
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}
async function reportScreenshot(page: Page, path: string, region: 'summary' | 'chart' = 'summary') {
  const target = region === 'summary'
    ? page.getByRole('region', { name: "Saved report", exact: true })
    : page.getByRole('figure', { name: "Baseline vs actual by person", exact: true });
  // Capture an actual viewport, placing content below the application's fixed header.
  await target.evaluate((element) => window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - 96, behavior: 'instant' }));
  await page.screenshot({ path });
}
async function factUI(page: Page, prefix: string, period: PlanningPeriodDto, membershipId: string, taskId: string, hours: string, screenshot?: string) {
  await page.getByLabel("Time entry for", { exact: true }).selectOption(membershipId);
  await expect(page.getByLabel("Time entry for", { exact: true })).toHaveValue(membershipId);
  await page.getByRole('button', { name: "Record actual hours", exact: true }).click();
  const dialog = page.getByRole('dialog', { name: "Record weekly actual hours", exact: true });
  await dialog.getByLabel("Task", { exact: true }).selectOption(taskId);
  await expect(dialog.getByLabel("Whose hours", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: "Time entry context", exact: true })).toContainText(period.name);
  await dialog.getByLabel("Actual hours this week", { exact: true }).fill(hours);
  if (screenshot) await page.screenshot({ path: screenshot });
  const result = page.waitForResponse((item) => call(item, 'PUT', `${prefix}/tasks/${taskId}/manual-period-work/${period.id}/${membershipId}`));
  await dialog.getByRole('button', { name: "Save actual hours", exact: true }).click();
  const fact = (await parsed(await result, 200, manualPeriodWorkLogResponseSchema)).data;
  await expect(dialog).toHaveCount(0);
  expect(fact.precision).toBe('period');
  return fact;
}
async function reportUI(page: Page, prefix: string, baseline: PlanBaselineDto) {
  await page.getByRole('button', { name: "Report", exact: true }).click();
  await page.getByLabel("Saved baseline", { exact: true }).selectOption(baseline.id);
  const result = page.waitForResponse((item) => call(item, 'POST', `${prefix}/report-runs`));
  await page.getByRole('button', { name: "Calculate new report", exact: true }).click();
  const run = (await parsed(await result, 201, weeklyPlanFactReportRunResponseSchema)).data;
  await expect(page.getByRole('combobox', { name: "Saved report", exact: true })).toHaveValue(run.id);
  await expect(page.getByRole('region', { name: "Saved report", exact: true })).toBeVisible();
  return run;
}

test.describe('P2a desktop1440', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Berlin' });
  test('API task setup; real UI period/plan/freeze, detail facts and pinned report, with browser-local DST validation', async ({ page, request, baseURL }, info) => {
    const f = await setup(request, baseURL, 480, 'Неделя командного пилота');
    const child = (await f.post('/tasks', { projectId: f.project.id, parentTaskId: f.root.id, workScope: 'detail', title: 'Проверить детали пилота', statusId: f.status.id }, 201, taskResponseSchema)).data;
    expect(child.workPackageId).toBe(f.root.workPackageId);
    await page.goto(f.path);
    await expect(page.getByRole('heading', { level: 1, name: "Weekly plan", exact: true })).toBeVisible();
    await page.getByRole('button', { name: "New period", exact: true }).click();
    const create = page.getByRole('dialog', { name: "New weekly period", exact: true });
    await create.getByLabel("Period name", { exact: true }).fill('Первая проверочная неделя');
    const inputs = await page.evaluate(() => {
      const start = new Date(); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      const two = (n: number) => String(n).padStart(2, '0');
      const date = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
      const cutoff = new Date(Date.now() + 3_600_000);
      return { start: date(start), cutoff: `${date(cutoff)}T${two(cutoff.getHours())}:${two(cutoff.getMinutes())}` };
    });
    await create.getByLabel("First day of the week", { exact: true }).fill(inputs.start);
    await create.getByLabel("Period time zone", { exact: true }).fill('Asia/Nicosia');
    const cutoffInput = create.getByLabel('Baseline deadline (Europe/Berlin)', { exact: true });
    await cutoffInput.fill('2027-03-28T02:30');
    let attempts = 0;
    const observe = (request: Request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === `${f.prefix}/periods`) attempts++; };
    page.on('request', observe);
    await create.getByRole('button', { name: "Create period", exact: true }).click();
    await expect(create.getByRole('alert')).toContainText('Enter a valid date and time');
    expect(attempts, 'DST-gap input never reaches the server').toBe(0);
    page.off('request', observe);
    await cutoffInput.fill(inputs.cutoff);
    const createdResponse = page.waitForResponse((item) => call(item, 'POST', `${f.prefix}/periods`));
    await create.getByRole('button', { name: "Create period", exact: true }).click();
    const period = (await parsed(await createdResponse, 201, planningPeriodResponseSchema)).data;
    expect(period.timezone).toBe('Asia/Nicosia');
    await expect(create).toHaveCount(0);
    await expect(page.getByLabel("Period", { exact: true })).toHaveValue(period.id);
    await expect(page.getByText('Baseline deadline:', { exact: false })).toBeVisible();

    await page.getByRole('button', { name: "Add to plan", exact: true }).click();
    const plan = page.getByRole('dialog', { name: "Add to weekly plan", exact: true });
    await plan.getByLabel("Whole task", { exact: true }).selectOption(f.root.workPackageId);
    await expect(plan.getByLabel("Whose plan", { exact: true })).toHaveCount(0);
    await expect(plan.getByRole('region', { name: "Time entry context", exact: true })).toContainText(f.own.displayName);
    await plan.getByLabel("Planned hours", { exact: true }).fill('8');
    await plan.getByLabel(`Allocation: ${f.root.title}`, { exact: true }).fill('8');
    const plannedResponse = page.waitForResponse((item) => call(item, 'POST', `${f.prefix}/periods/${period.id}/commitments`));
    await plan.getByRole('button', { name: "Save personal plan", exact: true }).click();
    const commitment = (await parsed(await plannedResponse, 201, periodCommitmentResponseSchema)).data;
    expect(commitment).toMatchObject({ plannedMinutes: 480, unallocatedMinutes: 0 });
    await expect(plan).toHaveCount(0);
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('p2a-desktop-week-plan.png') });

    const previewResponse = page.waitForResponse((item) => call(item, 'POST', `${f.prefix}/periods/${period.id}/freeze-preview`));
    await page.locator('summary').filter({ hasText: 'Baseline options and help' }).click();
    await page.getByRole('button', { name: "Save project baseline", exact: true }).click();
    const preview = (await parsed(await previewResponse, 200, freezePreviewResponseSchema)).data;
    expect(preview.snapshot.commitments.find((item) => item.id === commitment.id)?.plannedMinutes).toBe(480);
    const freeze = page.getByRole('dialog', { name: "Save project baseline", exact: true });
    await expect(freeze.getByRole('region', { name: "Baseline preview", exact: true })).toContainText("8h");
    await page.screenshot({ path: info.outputPath('p2a-desktop-freeze-preview.png') });
    const frozenResponse = page.waitForResponse((item) => call(item, 'POST', `${f.prefix}/periods/${period.id}/freeze`));
    await freeze.getByRole('button', { name: "Confirm baseline", exact: true }).click();
    const baseline = (await parsed(await frozenResponse, 200, planBaselineResponseSchema)).data;
    await expect(freeze).toHaveCount(0);
    const rootFact = await factUI(page, f.prefix, period, f.own.id, f.root.id, '3', info.outputPath('p2a-desktop-fact-dialog.png'));
    const childFact = await factUI(page, f.prefix, period, f.own.id, child.id, '7');
    expect([rootFact.minutes, childFact.minutes]).toEqual([180, 420]);
    const run = await reportUI(page, f.prefix, baseline);
    expect(run.summary).toMatchObject({ knownPlannedMinutes: 480, actualMinutes: 600, totalVarianceMinutes: 120, totalVariancePercent: 25 });
    const summary = page.getByRole('region', { name: "Saved report", exact: true });
    await expect(summary).toContainText('25%');
    await expect(page.getByRole('figure', { name: "Baseline vs actual by person", exact: true }).getByRole('img', { name: `${f.own.displayName}, actual: 10h`, exact: true })).toBeVisible();
    const details = page.getByRole('table', { name: "Saved planned and actual hours", exact: true });
    await details.getByRole('button', { name: "View calculation", exact: true }).first().click();
    await expect(details).toContainText("3h");
    await expect(details).toContainText("7h");
    await noOverflow(page);
    await reportScreenshot(page, info.outputPath('p2a-desktop-week-report.png'));
    // Explicit API correction verifies the UI's stored run survives a hard reload and fresh GET.
    const correctedResponse = await request.put(`${f.prefix}/tasks/${f.root.id}/manual-period-work/${period.id}/${f.own.id}`, {
      headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: rootFact.revision, minutes: 240, reason: 'Уточнение после сохранённого расчёта' },
    });
    expect(correctedResponse.status(), await correctedResponse.text()).toBe(200);
    await page.reload();
    await expect(page.getByRole('combobox', { name: "Saved report", exact: true })).toHaveValue(run.id);
    await expect(summary).toContainText('25%');
    const storedResponse = await request.get(`${f.prefix}/report-runs/${run.id}`);
    expect(storedResponse.status()).toBe(200);
    expect(weeklyPlanFactReportRunResponseSchema.parse(await storedResponse.json()).data).toEqual(run);
    const next = await reportUI(page, f.prefix, baseline);
    expect(next.summary.actualMinutes).toBe(660);
    await page.getByRole('combobox', { name: "Saved report", exact: true }).selectOption(run.id);
    await expect(summary).toContainText('25%');
    await writeFile(info.outputPath('p2a-preview.json'), JSON.stringify({ path: `${f.path}?period=${period.id}&view=report&run=${run.id}`, periodId: period.id, baselineId: baseline.id, runId: run.id }, null, 2));
  });
});

test.describe('P2a mobile390', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('API period/plan/freeze setup; UI weekly300fact against360plan, report graph and reload without page overflow', async ({ page, request, baseURL }, info) => {
    const f = await setup(request, baseURL, 1200, 'Мобильная неделя пилота');
    const monday = new Date(); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const period = (await f.post('/periods', { projectId: f.project.id, name: 'Неделя мобильной проверки', localStart: monday.toISOString().slice(0, 10), timezone: 'Asia/Nicosia', cutoffAt: new Date(Date.now() + 3_600_000).toISOString() }, 201, planningPeriodResponseSchema)).data;
    await f.post(`/periods/${period.id}/commitments`, { workPackageId: f.root.workPackageId, membershipId: f.own.id, expectedAbsent: true, plannedMinutes: 360 }, 201, periodCommitmentResponseSchema);
    const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, 200, freezePreviewResponseSchema)).data;
    const baseline = (await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, 200, planBaselineResponseSchema)).data;
    await page.goto(`${f.path}?period=${period.id}`);
    await expect(page.getByRole('heading', { name: "Weekly plan", level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: "Personal plans", exact: true })).toContainText("Personal plan: 6h");
    await noOverflow(page);
    await page.screenshot({ path: info.outputPath('p2a-mobile-week-plan.png'), fullPage: true });
    const fact = await factUI(page, f.prefix, period, f.own.id, f.root.id, '5');
    expect(fact.minutes).toBe(300);
    const run = await reportUI(page, f.prefix, baseline);
    expect(run.summary).toMatchObject({ knownPlannedMinutes: 360, actualMinutes: 300, totalVarianceMinutes: -60 });
    const figure = page.getByRole('figure', { name: "Baseline vs actual by person", exact: true });
    await expect(figure.getByRole('img', { name: `${f.own.displayName}, plan: 6h`, exact: true })).toBeVisible();
    await expect(figure.getByRole('img', { name: `${f.own.displayName}, actual: 5h`, exact: true })).toBeVisible();
    await noOverflow(page);
    await reportScreenshot(page, info.outputPath('p2a-mobile-week-report.png'));
    await reportScreenshot(page, info.outputPath('p2a-mobile-week-report-chart.png'), 'chart');
    await page.reload();
    await expect(page.getByRole('combobox', { name: "Saved report", exact: true })).toHaveValue(run.id);
    await expect(figure.getByRole('img', { name: `${f.own.displayName}, actual: 5h`, exact: true })).toBeVisible();
    await noOverflow(page);
  });
});
