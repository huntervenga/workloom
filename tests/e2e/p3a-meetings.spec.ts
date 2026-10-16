// Actual UI meeting commands against Fastify/PostgreSQL; API setup is explicit.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Page, type Request, type Response } from '@playwright/test';
import {
  attendancePostingResponseSchema, freezePreviewResponseSchema, meetingAttendanceListResponseSchema,
  meetingCreationResponseSchema, meetingPlanPreviewResponseSchema, meetingPlanResultResponseSchema,
  meetingResponseSchema, planBaselineResponseSchema, planningPeriodResponseSchema, projectResponseSchema,
  recordedWorkListResponseSchema, weeklyPlanFactReportRunResponseSchema,
  type AttendanceDto, type MeetingCreationDto,
} from '@workloom/contracts';

import { openProjectActions } from './support/disclosures.js';
import { loadLiveData } from './support/live-api.js';

function call(response: Response, method: string, path: string) {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}
async function parsed<T>(response: Response, status: number, schema: { parse(value: unknown): T }) {
  expect(response.status(), await response.text()).toBe(status);
  return schema.parse(await response.json());
}
async function setup(request: APIRequestContext, baseURL: string | undefined, name: string, start = '2026-10-19') {
  if (!baseURL) throw new Error('Playwright baseURL required.');
  const live = await loadLiveData(request);
  const own = live.members.find(m => m.userId === live.me.actor.id);
  if (!own) throw new Error('Actor membership required.');
  const colleagues = live.members.filter(m => m.id !== own.id && m.role !== 'viewer').slice(0, 4);
  if (colleagues.length !== 4) throw new Error('Five-person team fixture required.');
  const members = [own, ...colleagues];
  const prefix = `/api/v1/workspaces/${live.firstWorkspace.id}`;
  const origin = new URL(baseURL).origin;
  async function post<T>(path: string, data: unknown, status: number, schema: { parse(value: unknown): T }) {
    const r = await request.post(prefix + path, { headers: { origin, 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBe(status); return schema.parse(await r.json());
  }
  const project = (await post('/projects', { name: `${name} ${randomUUID().slice(0, 8)}` }, 201, projectResponseSchema)).data;
  const period = (await post('/periods', { projectId: project.id, name: 'Неделя совместной работы', localStart: start, timezone: 'Europe/Berlin', cutoffAt: new Date(Date.now() + 3_600_000).toISOString() }, 201, planningPeriodResponseSchema)).data;
  const path = `/w/${live.firstWorkspace.id}/projects/${project.id}`;
  return { request, live, own, members, prefix, origin, post, project, period, path };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function attendance(f: Fixture, taskId: string) {
  const r = await f.request.get(`${f.prefix}/tasks/${taskId}/attendance`);
  expect(r.status()).toBe(200); return meetingAttendanceListResponseSchema.parse(await r.json()).data;
}
async function recorded(f: Fixture, taskId: string) {
  const r = await f.request.get(`${f.prefix}/recorded-work?periodId=${f.period.id}&taskId=${taskId}`);
  expect(r.status()).toBe(200); return recordedWorkListResponseSchema.parse(await r.json()).data;
}
async function createUI(page: Page, f: Fixture, title: string, local: string, count: number, zone = 'Europe/Berlin') {
  await openProjectActions(page);
  await page.getByRole('button', { name: "New meeting", exact: true }).click();
  const dialog = page.getByRole('dialog', { name: "New meeting", exact: true });
  await dialog.getByLabel("Meeting title", { exact: true }).fill(title);
  await dialog.getByRole('combobox', { name: "Meeting period", exact: true }).selectOption(f.period.id);
  await dialog.getByLabel("Meeting time zone", { exact: true }).fill(zone);
  await dialog.getByLabel("Meeting start", { exact: true }).fill(local);
  for (const m of f.members.slice(0, count)) await dialog.getByRole('checkbox', { name: m.displayName, exact: true }).check();
  return dialog;
}
async function submitCreation(page: Page, f: Fixture) {
  const response = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/projects/${f.project.id}/meetings`));
  await page.getByRole('dialog', { name: "New meeting", exact: true }).getByRole('button', { name: "Create meeting", exact: true }).click();
  return (await parsed(await response, 201, meetingCreationResponseSchema)).data;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}
async function confirmUI(page: Page, f: Fixture, created: MeetingCreationDto, row: AttendanceDto, status: 'present' | 'partial' | 'absent', hours?: string, reason?: string) {
  const drawer = page.getByRole('dialog', { name: created.task.title, exact: true });
  await drawer.getByRole('combobox', { name: "Whose attendance", exact: true }).selectOption(row.id);
  await drawer.getByRole('combobox', { name: "Attendance outcome", exact: true }).selectOption(status);
  if (hours) await drawer.getByLabel("Time attended, hours", { exact: true }).fill(hours);
  if (reason) await drawer.getByLabel("Reason for attendance correction", { exact: true }).fill(reason);
  const response = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/tasks/${created.task.id}/attendance/confirm`));
  await drawer.getByRole('button', { name: "Confirm selected person's attendance", exact: true }).click();
  const sent = await response;
  expect((sent.request().postDataJSON() as { rows: { attendanceId: string }[] }).rows).toEqual([expect.objectContaining({ attendanceId: row.id })]);
  const posting = (await parsed(sent, 200, attendancePostingResponseSchema)).data;
  expect(posting.attendances.find(a => a.id === row.id)).toBeDefined();
  return posting;
}

test.describe('P3a desktop1440', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Berlin' });
  test('real shared meeting creation, explicit personal plans,210 minutes, pinned report and colleague-targeted correction', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await setup(request, baseURL, 'Совместные встречи команды');
    const otherPeriod = (await f.post('/periods', { projectId: f.project.id, name: 'Другая выбранная неделя', localStart: '2026-10-26', timezone: 'Europe/Berlin', cutoffAt: new Date(Date.now() + 3_600_000).toISOString() }, 201, planningPeriodResponseSchema)).data;
    await page.goto(f.path);
    await createUI(page, f, 'Общий разбор запуска', '2026-10-20T10:00', 5);
    const created = await submitCreation(page, f);
    expect(created.task.estimateMinutes).toBe(300); expect(created.planProposals).toHaveLength(5);
    expect(created.attendances.every(a => a.status === 'unknown' && a.workLog === null)).toBe(true);
    expect(await recorded(f, created.task.id)).toEqual([]);
    const drawer = page.getByRole('dialog', { name: created.task.title, exact: true });
    await drawer.getByRole('tab', { name: "Personal plan", exact: true }).click();
    await drawer.getByRole('checkbox', { name: f.own.displayName, exact: true }).check();
    await drawer.getByLabel("Meeting planned hours", { exact: true }).fill('2');
    await drawer.locator('button[aria-label="Close"]').click();
    await expect(drawer).toHaveCount(0);
    const planColleague = f.members[1]; if (!planColleague) throw new Error('Plan colleague required.');
    await page.getByLabel("Week for hours", { exact: true }).selectOption(f.period.id);
    await page.getByLabel("Whose hours to show", { exact: true }).selectOption(planColleague.id);
    await page.getByRole('button', { name: `Weekly plan: ${created.task.title}`, exact: true }).click();
    await expect(drawer.getByRole('checkbox', { name: planColleague.displayName, exact: true })).toBeChecked();
    const singlePreviewResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/tasks/${created.task.id}/meeting-plan-preview`));
    await drawer.getByRole('button', { name: "Preview personal plans", exact: true }).click();
    expect((await parsed(await singlePreviewResponse, 200, meetingPlanPreviewResponseSchema)).data.rows.map(r => r.membershipId)).toEqual([planColleague.id]);
    const singlePlanResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/tasks/${created.task.id}/meeting-plan`));
    await drawer.getByRole('button', { name: "Apply personal plans", exact: true }).click();
    const singleSent = await singlePlanResponse;
    expect((singleSent.request().postDataJSON() as { rows: { membershipId: string }[] }).rows).toEqual([expect.objectContaining({ membershipId: planColleague.id })]);
    await parsed(singleSent, 200, meetingPlanResultResponseSchema);
    await drawer.locator('button[aria-label="Close"]').click();
    await expect(drawer).toHaveCount(0);
    await page.getByRole('button', { name: created.task.title, exact: true }).click();
    await drawer.getByRole('tab', { name: "Personal plan", exact: true }).click();
    await expect(drawer.getByRole('checkbox', { name: f.own.displayName, exact: true })).toBeChecked();
    await expect(drawer.getByLabel("Meeting planned hours", { exact: true })).toHaveCount(1);
    await expect(drawer.getByLabel("Meeting planned hours", { exact: true })).toHaveValue('2');
    await drawer.getByLabel("Meeting planned hours", { exact: true }).fill('1');
    for (const m of f.members) await drawer.getByRole('checkbox', { name: m.displayName, exact: true }).check();
    const previewResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/tasks/${created.task.id}/meeting-plan-preview`));
    await drawer.getByRole('button', { name: "Preview personal plans", exact: true }).click();
    const preview = (await parsed(await previewResponse, 200, meetingPlanPreviewResponseSchema)).data;
    expect(preview.rows.map(r => r.plannedMinutes)).toEqual([60, 60, 60, 60, 60]);
    await page.screenshot({ path: info.outputPath('p3a-desktop-plan-preview.png') });
    const planResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/tasks/${created.task.id}/meeting-plan`));
    await drawer.getByRole('button', { name: "Apply personal plans", exact: true }).click();
    const plans = (await parsed(await planResponse, 200, meetingPlanResultResponseSchema)).data;
    expect(plans.commitments).toHaveLength(5);
    await drawer.locator('button[aria-label="Close"]').click();
    await expect(drawer).toHaveCount(0);
    const freezePreview = (await f.post(`/periods/${f.period.id}/freeze-preview`, { scope: 'project' }, 200, freezePreviewResponseSchema)).data;
    const baseline = (await f.post(`/periods/${f.period.id}/freeze`, { scope: 'project', previewHash: freezePreview.previewHash }, 200, planBaselineResponseSchema)).data;
    await page.getByLabel("Week for hours", { exact: true }).selectOption(otherPeriod.id);
    await page.getByRole('button', { name: `Weekly actual hours: ${created.task.title}`, exact: true }).click();
    await expect(drawer.getByRole('heading', { name: "This meeting belongs to another period", exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: "Confirm selected person's attendance", exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: "Apply personal plans", exact: true })).toHaveCount(0);
    expect(await recorded(f, created.task.id)).toEqual([]);
    await drawer.getByRole('button', { name: "Open meeting's original period", exact: true }).click();
    await expect(page.getByLabel("Week for hours", { exact: true })).toHaveValue(f.period.id);
    await expect(drawer.getByRole('tab', { name: "Attendance", exact: true })).toHaveAttribute('aria-selected', 'true');
    await drawer.getByRole('button', { name: "Meeting followed the plan · fill details", exact: true }).click();
    const actualResponse = page.waitForResponse(r => call(r, 'PATCH', `${f.prefix}/tasks/${created.task.id}/meeting`));
    await drawer.getByRole('button', { name: "Save actual details", exact: true }).click();
    expect((await parsed(await actualResponse, 200, meetingResponseSchema)).data.actualDurationMinutes).toBe(60);
    const fourthMember = f.members[3]; const fifthMember = f.members[4];
    const fourth = created.attendances.find(a => a.membershipId === fourthMember?.id);
    const fifth = created.attendances.find(a => a.membershipId === fifthMember?.id);
    if (!fourth || !fifth || !fourthMember || !fifthMember) throw new Error('Five attendance records required.');
    const batch = drawer.getByRole('region', { name: "Team attendance", exact: true });
    await batch.getByRole('button', { name: "Select team members", exact: true }).click();
    await batch.getByRole('button', { name: "Mark selected as attended", exact: true }).click();
    await batch.getByRole('combobox', { name: `Attendance outcome: ${fourthMember.displayName}`, exact: true }).selectOption('partial');
    await batch.getByLabel(`Time attended, hours: ${fourthMember.displayName}`, { exact: true }).fill('0.5');
    await batch.getByRole('combobox', { name: `Attendance outcome: ${fifthMember.displayName}`, exact: true }).selectOption('absent');
    const review = batch.getByRole('region', { name: "Review team attendance", exact: true });
    await expect(review).toContainText('Rows to save: 5');
    await expect(review).toContainText("3h 30");
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('p3a-desktop-batch-review.png') });
    let batchPosts = 0;
    const observeBatch = (r: Request) => { if (r.method() === 'POST' && new URL(r.url()).pathname === `${f.prefix}/tasks/${created.task.id}/attendance/confirm`) batchPosts++; };
    page.on('request', observeBatch);
    const batchResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/tasks/${created.task.id}/attendance/confirm`));
    await batch.getByRole('button', { name: "Confirm team attendance", exact: true }).click();
    const sentBatch = await batchResponse;
    const sentRows = (sentBatch.request().postDataJSON() as { rows: { attendanceId: string; minutes: number }[] }).rows;
    expect(sentRows).toHaveLength(5);
    expect(sentRows.map(r => r.minutes).sort((a, b) => a - b)).toEqual([0, 30, 60, 60, 60]);
    expect((await parsed(sentBatch, 200, attendancePostingResponseSchema)).data.attendances).toHaveLength(5);
    const original = await attendance(f, created.task.id);
    page.off('request', observeBatch); expect(batchPosts).toBe(1);
    expect(original.reduce((sum, a) => sum + (a.minutes ?? 0), 0)).toBe(210);
    await page.screenshot({ path: info.outputPath('p3a-desktop-attendance.png') });
    await drawer.locator('button[aria-label="Close"]').click();
    await expect(drawer).toHaveCount(0);
    await page.goto(`${f.path}/week?period=${f.period.id}`);
    await page.getByRole('button', { name: "Report", exact: true }).click();
    await page.getByLabel("Saved baseline", { exact: true }).selectOption(baseline.id);
    const reportResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/report-runs`));
    await page.getByRole('button', { name: "Calculate new report", exact: true }).click();
    const run = (await parsed(await reportResponse, 201, weeklyPlanFactReportRunResponseSchema)).data;
    expect(run.summary).toMatchObject({ knownPlannedMinutes: 300, actualMinutes: 210, totalVarianceMinutes: -90, totalVariancePercent: -30 });
    await page.getByRole('region', { name: "Saved report", exact: true }).evaluate(e => window.scrollTo({ top: scrollY + e.getBoundingClientRect().top - 96 }));
    await page.screenshot({ path: info.outputPath('p3a-desktop-week-report.png') });

    // A colleague lens must dispatch that person's attendance, rather than the actor's source.
    const colleague = f.members[3]; if (!colleague) throw new Error('Colleague required.');
    await page.goto(`${f.path}?week=${f.period.id}`);
    await page.getByLabel("Whose hours to show", { exact: true }).selectOption(colleague.id);
    await page.getByRole('button', { name: `Weekly actual hours: ${created.task.title}`, exact: true }).click();
    await expect(drawer.getByRole('combobox', { name: "Whose attendance", exact: true })).toHaveValue(fourth.id);
    const ownAttendance = original.find(a => a.membershipId === f.own.id);
    if (!ownAttendance) throw new Error('Owner attendance required.');
    await drawer.getByRole('combobox', { name: "Whose attendance", exact: true }).selectOption(ownAttendance.id);
    await drawer.getByRole('combobox', { name: "Attendance outcome", exact: true }).selectOption('partial');
    await drawer.getByLabel("Time attended, hours", { exact: true }).fill('0.75');
    await drawer.getByLabel("Reason for attendance correction", { exact: true }).fill('Неотправленный личный черновик');
    await confirmUI(page, f, created, original.find(a => a.id === fourth.id) ?? fourth, 'partial', '0.25', 'Уточнили время участия коллеги');
    const corrected = await attendance(f, created.task.id);
    expect(corrected.find(a => a.id === fourth.id)?.minutes).toBe(15);
    for (const row of original.filter(a => a.id !== fourth.id)) expect(corrected.find(a => a.id === row.id)).toEqual(row);
    await drawer.getByRole('combobox', { name: "Whose attendance", exact: true }).selectOption(ownAttendance.id);
    await expect(drawer.getByRole('combobox', { name: "Attendance outcome", exact: true })).toHaveValue('partial');
    await expect(drawer.getByLabel("Time attended, hours", { exact: true })).toHaveValue('0.75');
    await expect(drawer.getByLabel("Reason for attendance correction", { exact: true })).toHaveValue('Неотправленный личный черновик');
    // Deliberate reset, after proving the unrelated unsent draft survived the full response.
    await drawer.getByRole('tab', { name: "Meeting", exact: true }).click();
    await drawer.getByRole('button', { name: "Discard meeting draft", exact: true }).click();
    await drawer.getByRole('tab', { name: "Attendance", exact: true }).click();
    await drawer.getByRole('combobox', { name: "Whose attendance", exact: true }).selectOption(fourth.id);
    await drawer.getByRole('button', { name: "Attendance history", exact: true }).click();
    const history = page.getByRole('dialog', { name: "Attendance history", exact: true });
    await expect(history).toContainText('Уточнили время участия коллеги');
    await expect(history.getByRole('listitem').first()).toContainText(`Revision ${corrected.find(a => a.id === fourth.id)?.revision}`);
    await page.screenshot({ path: info.outputPath('p3a-desktop-attendance-history.png') });
    await page.reload();
    await expect(drawer.getByRole('combobox', { name: "Whose attendance", exact: true })).toHaveValue(fourth.id);
    await drawer.locator('button[aria-label="Close"]').click();
    await expect(drawer).toHaveCount(0);
    await page.getByRole('button', { name: /^Whole work package:/ }).click();
    const breakdown = page.getByRole('dialog', { name: "Time-entry sources", exact: true });
    const colleagueSource = breakdown.locator('div.rounded-lg').filter({ hasText: colleague.displayName });
    await colleagueSource.getByRole('button', { name: "Edit this time entry", exact: true }).click();
    await expect(drawer.getByRole('combobox', { name: "Whose attendance", exact: true })).toHaveValue(fourth.id);
    await expect(drawer.getByLabel("Time attended, hours", { exact: true })).toHaveValue('0:15');
    expect((await recorded(f, created.task.id)).reduce((n, r) => n + r.minutes, 0)).toBe(195);
    const oldRun = await request.get(`${f.prefix}/report-runs/${run.id}`);
    expect(weeklyPlanFactReportRunResponseSchema.parse(await oldRun.json()).data).toEqual(run);
    await noOverflow(page);
    await writeFile(info.outputPath('p3a-preview.json'), JSON.stringify({ path: `${f.path}?week=${f.period.id}`, weeklyPath: `${f.path}/week?period=${f.period.id}&view=report&run=${run.id}`, taskId: created.task.id }, null, 2));
  });
});

test.describe('P3a mobile390', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Europe/Berlin' });
  test('explicit DST choice and planned absence zero with lost real response, exact retry and mobile history', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await setup(request, baseURL, 'Мобильная встреча', '2026-10-19');
    await page.goto(f.path);
    const create = await createUI(page, f, 'Воскресная встреча команды', '2026-10-25T02:30', 1);
    let attemptedCreates = 0;
    const observe = (r: Request) => { if (r.method() === 'POST' && new URL(r.url()).pathname === `${f.prefix}/projects/${f.project.id}/meetings`) attemptedCreates++; };
    page.on('request', observe);
    await create.getByLabel("Meeting start", { exact: true }).fill('2027-03-28T02:30');
    await create.getByRole('button', { name: "Create meeting", exact: true }).click();
    await expect(create.getByRole('alert').filter({ hasText: 'This local time does not exist' })).toBeVisible();
    expect(attemptedCreates).toBe(0);
    page.off('request', observe);
    await create.getByLabel("Meeting start", { exact: true }).fill('2026-10-25T02:30');
    const choice = create.getByLabel("This local time occurs twice. Choose an offset.", { exact: true });
    await expect(choice).toBeVisible(); await choice.selectOption('later');
    await page.screenshot({ path: info.outputPath('p3a-mobile-dst-choice.png') });
    const created = await submitCreation(page, f);
    expect(created.meeting.plannedStartAt).toBe('2026-10-25T01:30:00.000Z');
    const drawer = page.getByRole('dialog', { name: created.task.title, exact: true });
    await drawer.getByRole('tab', { name: "Attendance", exact: true }).click();
    const row = created.attendances[0]; if (!row) throw new Error('Attendance required.');
    await expect(drawer.getByLabel("Actual start", { exact: true })).toHaveValue('');
    await drawer.getByRole('combobox', { name: "Attendance outcome", exact: true }).selectOption('absent');
    await drawer.getByRole('combobox', { name: "Time basis for absence", exact: true }).selectOption('planned_absence');
    const path = `${f.prefix}/tasks/${created.task.id}/attendance/confirm`;
    let original: { key: string; body: string } | undefined;
    await page.route(`**${path}`, async route => {
      original = { key: route.request().headers()['idempotency-key'] ?? '', body: route.request().postData() ?? '' };
      const result = await route.fetch(); expect(result.status()).toBe(200);
      expect(attendancePostingResponseSchema.parse(await result.json()).data.attendances[0]?.minutes).toBe(0);
      await route.abort('failed');
    }, { times: 1 });
    await drawer.getByRole('button', { name: "Confirm selected person's attendance", exact: true }).click();
    await expect(drawer.getByRole('button', { name: "Retry original save", exact: true })).toBeVisible();
    const retryResponse = page.waitForResponse(r => call(r, 'POST', path));
    await drawer.getByRole('button', { name: "Retry original save", exact: true }).click();
    const retry = await retryResponse; expect(retry.request().headers()['idempotency-key']).toBe(original?.key); expect(retry.request().postData()).toBe(original?.body);
    const result = (await parsed(retry, 200, attendancePostingResponseSchema)).data;
    expect(result.attendances[0]).toMatchObject({ id: row.id, postingState: 'active', minutes: 0, workLog: { revision: 1, precision: 'occurrence', attribution: { basis: 'planned_absence', actualStartAt: null } } });
    const sources = await recorded(f, created.task.id); expect(sources).toHaveLength(1);
    await page.reload();
    await drawer.getByRole('tab', { name: "Attendance", exact: true }).click();
    await expect(drawer.getByLabel("Actual start", { exact: true })).toHaveValue('');
    await expect(drawer).toContainText('Отсутствие подтверждения не равно нулю');
    await drawer.getByRole('combobox', { name: "Attendance outcome", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('p3a-mobile-planned-absence.png') });
    await drawer.getByRole('button', { name: "Attendance history", exact: true }).click();
    const history = page.getByRole('dialog', { name: "Attendance history", exact: true });
    await expect(history).toContainText("planned absence");
    await expect(history.getByRole('listitem').first()).toContainText(`Revision ${result.attendances[0]?.revision}`); await page.screenshot({ path: info.outputPath('p3a-mobile-attendance-history.png') });
    await noOverflow(page);
  });
});
