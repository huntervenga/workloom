// Real recurrence UI over the running Fastify/PostgreSQL candidate. Setup creates only synthetic projects/periods.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import {
  meetingAttendanceListResponseSchema, meetingResponseSchema, planningPeriodResponseSchema, projectResponseSchema,
  recordedWorkListResponseSchema, recurrenceCreatePreviewResponseSchema, recurrenceEditPreviewResponseSchema,
  recurrenceExceptionPreviewResponseSchema, recurrenceInstanceListResponseSchema, recurrenceInstanceResponseSchema,
  recurrenceMaterializationResultResponseSchema, recurrenceSeriesResponseSchema,
  type RecurrenceInstanceDto,
} from '@workloom/contracts';

import { loadLiveData } from './support/live-api.js';

function call(r: Response, method: string, path: string) {
  return r.request().method() === method && new URL(r.url()).pathname === path;
}
async function parsed<T>(r: Response, status: number, schema: { parse(value: unknown): T }) {
  expect(r.status(), await r.text()).toBe(status);
  return schema.parse(await r.json());
}
async function setup(request: APIRequestContext, baseURL: string | undefined, label: string, localStart: string, timezone: string) {
  if (!baseURL) throw new Error('Playwright baseURL required.');
  const live = await loadLiveData(request);
  const own = live.members.find(m => m.userId === live.me.actor.id);
  if (!own) throw new Error('Actor membership required.');
  const members = [own, ...live.members.filter(m => m.id !== own.id && m.role !== 'viewer').slice(0, 2)];
  const prefix = `/api/v1/workspaces/${live.firstWorkspace.id}`;
  const origin = new URL(baseURL).origin;
  async function post<T>(path: string, data: unknown, schema: { parse(value: unknown): T }) {
    const r = await request.post(prefix + path, { headers: { origin, 'idempotency-key': randomUUID() }, data });
    expect(r.status(), await r.text()).toBe(201); return schema.parse(await r.json());
  }
  const project = (await post('/projects', { name: `${label} ${randomUUID().slice(0, 6)}` }, projectResponseSchema)).data;
  const period = (await post('/periods', { projectId: project.id, name: label, localStart, timezone, cutoffAt: '2027-02-01T00:00:00.000Z' }, planningPeriodResponseSchema)).data;
  const path = `/w/${live.firstWorkspace.id}/projects/${project.id}/week?period=${period.id}`;
  return { request, live, own, members, prefix, project, period, path };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function instances(f: Fixture, seriesId: string): Promise<RecurrenceInstanceDto[]> {
  const r = await f.request.get(`${f.prefix}/recurrence-series/${seriesId}/instances?periodId=${f.period.id}&includeCancelled=true&limit=100`);
  expect(r.status()).toBe(200);
  return recurrenceInstanceListResponseSchema.parse(await r.json()).data.sort((a, b) => a.occurrenceKey.localeCompare(b.occurrenceKey));
}
async function noAutomaticWork(f: Fixture) {
  const r = await f.request.get(`${f.prefix}/recorded-work?periodId=${f.period.id}&limit=100`);
  expect(r.status()).toBe(200); expect(recordedWorkListResponseSchema.parse(await r.json()).data).toEqual([]);
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
}
async function createForm(page: Page, f: Fixture, title: string, start: string, time: string, zone: string, count: number, weekdays = false) {
  await page.getByRole('button', { name: "New meeting series", exact: true }).click();
  const dialog = page.getByRole('dialog', { name: "New meeting series", exact: true });
  await dialog.getByLabel("Meeting title", { exact: true }).fill(title);
  await dialog.getByRole('radio', { name: weekdays ? "On weekdays" : "Every day", exact: true }).check();
  if (weekdays) for (const name of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await dialog.getByLabel("Series start date", { exact: true }).fill(start);
  await dialog.getByLabel("Series time", { exact: true }).fill(time);
  await dialog.getByLabel("Series time zone", { exact: true }).fill(zone);
  await dialog.getByLabel("Duration, minutes", { exact: true }).fill('45');
  await dialog.getByRole('radio', { name: "After a number of meetings", exact: true }).check();
  await dialog.getByLabel("Number of meetings in series", { exact: true }).fill(String(count));
  await dialog.getByRole('combobox', { name: "Organizer", exact: true }).selectOption(f.own.id);
  for (const m of f.members) await dialog.getByRole('checkbox', { name: m.displayName, exact: true }).check();
  await dialog.getByRole('checkbox', { name: new RegExp(`^${f.period.name}`) }).check();
  return dialog;
}
async function preview(page: Page, f: Fixture, dialog: Locator) {
  const response = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/projects/${f.project.id}/recurrence-preview`));
  await dialog.getByRole('button', { name: "Preview schedule", exact: true }).click();
  return (await parsed(await response, 200, recurrenceCreatePreviewResponseSchema)).data;
}
async function submit(page: Page, f: Fixture, dialog: Locator) {
  const response = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/projects/${f.project.id}/recurrence-series`));
  await dialog.getByRole('button', { name: "Create series", exact: true }).click();
  return (await parsed(await response, 201, recurrenceSeriesResponseSchema)).data;
}
async function prepare(page: Page, f: Fixture) {
  const response = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/periods/${f.period.id}/materialize-meetings`));
  await page.getByRole('button', { name: "Prepare period meetings", exact: true }).click();
  return (await parsed(await response, 200, recurrenceMaterializationResultResponseSchema)).data;
}
async function exception(page: Page, f: Fixture, seriesId: string, key: string, kind: 'skip' | 'restore' | 'move' | 'reset', capturePath?: string) {
  await page.getByRole('button', { name: `Change meeting ${key}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: "Change one meeting", exact: true });
  await dialog.getByRole('combobox', { name: "Meeting action", exact: true }).selectOption(kind);
  if (kind === 'move') {
    await dialog.getByLabel("New meeting date", { exact: true }).fill(key);
    await dialog.getByLabel("New meeting time", { exact: true }).fill('12:00');
  }
  await dialog.getByLabel("Reason for change", { exact: true }).fill(kind === 'skip' ? 'Разовый выходной команды' : 'Команда подтвердила изменение встречи');
  const prefix = `${f.prefix}/recurrence-series/${seriesId}/instances/${key}`;
  const response = page.waitForResponse(r => call(r, 'POST', `${prefix}/exception-preview`));
  await dialog.getByRole('button', { name: "Preview change", exact: true }).click();
  const checked = (await parsed(await response, 200, recurrenceExceptionPreviewResponseSchema)).data;
  if (kind === 'reset') {
    expect(checked.beforePlannedCalendar.plannedDurationMinutes).toBe(45);
    expect(checked.afterPlannedCalendar.plannedDurationMinutes).toBe(60);
    expect(checked.beforePlannedCalendar.attendeeMembershipIds).toHaveLength(3);
    expect(checked.afterPlannedCalendar.attendeeMembershipIds).toHaveLength(2);
  }
  if (capturePath) {
    await dialog.getByRole('region', { name: "Planned schedule and people", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: capturePath });
  }
  const applied = page.waitForResponse(r => call(r, 'POST', `${prefix}/exception`));
  await dialog.getByRole('button', { name: "Apply change", exact: true }).click();
  const result = (await parsed(await applied, 200, recurrenceInstanceResponseSchema)).data;
  await expect(dialog).toHaveCount(0);
  return result;
}

test.describe('P3b desktop1440', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Europe/Berlin' });
  test('creates a weekday series, prepares explicitly, preserves identities through exceptions and edits future schedule', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await setup(request, baseURL, 'Регулярные встречи запуска', '2026-11-02', 'Europe/Berlin');
    await page.goto(f.path);
    const title = 'Будничная синхронизация команды';
    const dialog = await createForm(page, f, title, f.period.localStart, '10:00', 'Europe/Berlin', 5, true);
    const checked = await preview(page, f, dialog);
    expect(checked.candidates).toHaveLength(5);
    expect(checked.candidates.every(c => c.periodId === f.period.id && c.resolution.warning === null)).toBe(true);
    await dialog.getByRole('table').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('p3b-desktop-series-preview.png') });
    const series = await submit(page, f, dialog);
    await writeFile(info.outputPath('p3b-desktop-demo.json'), JSON.stringify({ url: `${new URL(f.path, baseURL).href}&series=${series.id}`, projectId: f.project.id, periodId: f.period.id, seriesId: series.id }, null, 2));
    await expect(dialog).toHaveCount(0);
    await page.getByRole('combobox', { name: "Meeting series", exact: true }).selectOption(series.id);
    const reserved = await instances(f, series.id);
    expect(reserved).toHaveLength(5); expect(reserved.every(i => i.meetingId === null && i.taskId === null)).toBe(true);
    await noAutomaticWork(f);
    expect(await prepare(page, f)).toMatchObject({ status: 'complete', createdCount: 5, remainingCount: 0, truncated: false });
    const original = await instances(f, series.id);
    const first = original[0]; if (!first?.taskId) throw new Error('Prepared occurrence required.');
    const ids = (rows: RecurrenceInstanceDto[]) => rows.map(i => [i.id, i.meetingId, i.taskId, i.workPackageId]);
    const skipped = await exception(page, f, series.id, first.occurrenceKey, 'skip');
    expect(skipped.calendarState).toBe('cancelled');
    const restored = await exception(page, f, series.id, first.occurrenceKey, 'restore');
    expect(restored.calendarState).toBe('scheduled');
    expect(ids(await instances(f, series.id))).toEqual(ids(original));
    const moved = original[1]; if (!moved?.taskId) throw new Error('Second prepared occurrence required.');
    await exception(page, f, series.id, moved.occurrenceKey, 'move');

    await page.getByRole('button', { name: "Change series from a date", exact: true }).click();
    const edit = page.getByRole('dialog', { name: "Change series from a date", exact: true });
    await edit.getByLabel("Change series from a date", { exact: true }).fill('2026-11-03');
    await edit.getByLabel("Series time", { exact: true }).fill('11:00');
    await edit.getByLabel("Duration, minutes", { exact: true }).fill('60');
    const organizer = f.members[1], removed = f.members[2];
    if (!organizer || !removed) throw new Error('Three participants required.');
    await edit.getByRole('combobox', { name: "Organizer", exact: true }).selectOption(organizer.id);
    await edit.getByRole('checkbox', { name: removed.displayName, exact: true }).uncheck();
    const editResponse = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/recurrence-series/${series.id}/edit-preview`));
    await edit.getByRole('button', { name: "Preview change", exact: true }).click();
    const impact = (await parsed(await editResponse, 200, recurrenceEditPreviewResponseSchema)).data;
    expect(impact.protectedTargets).toEqual([]);
    await edit.getByRole('heading', { name: "Review series change", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('p3b-desktop-series-change-preview.png') });
    const editApplied = page.waitForResponse(r => call(r, 'POST', `${f.prefix}/recurrence-series/${series.id}/edit`));
    await edit.getByRole('button', { name: "Apply change", exact: true }).click();
    await parsed(await editApplied, 200, recurrenceSeriesResponseSchema);
    await expect(edit).toHaveCount(0);
    const updated = await instances(f, series.id);
    expect(ids(updated)).toEqual(ids(original));
    expect(updated[0]?.resolution.resolvedLocalTime).toBe('10:00');
    expect(updated[1]?.resolution.resolvedLocalTime).toBe('12:00');
    expect(updated.slice(2).every(i => i.resolution.resolvedLocalTime === '11:00')).toBe(true);
    await expect(page.getByRole('table', { name: "Series meetings in period", exact: true }).getByRole('row').filter({ hasText: '2026-11-04' })).toContainText('11:00');
    const reset = await exception(page, f, series.id, moved.occurrenceKey, 'reset', info.outputPath('p3b-desktop-reset-planned-calendar.png'));
    expect(reset.resolution).toMatchObject({ plannedDurationMinutes: 60, resolvedLocalTime: '11:00' });
    const meetingResponse = await request.get(`${f.prefix}/tasks/${moved.taskId}/meeting`);
    expect(meetingResponse.status()).toBe(200);
    expect(meetingResponseSchema.parse(await meetingResponse.json()).data).toMatchObject({ plannedDurationMinutes: 60, organizerMembershipId: organizer.id });
    const resetRoster = await request.get(`${f.prefix}/tasks/${moved.taskId}/attendance`);
    expect(meetingAttendanceListResponseSchema.parse(await resetRoster.json()).data.filter(a => a.rosterActive).map(a => a.membershipId).sort()).toEqual([f.own.id, organizer.id].sort());
    expect(ids(await instances(f, series.id))).toEqual(ids(original));
    await page.getByRole('table', { name: "Series meetings in period", exact: true }).scrollIntoViewIfNeeded();
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p3b-desktop-series-instances.png') });
    await page.getByRole('button', { name: `Open meeting ${first.occurrenceKey}`, exact: true }).click();
    const meeting = page.getByRole('dialog', { name: title, exact: true });
    await meeting.getByRole('tab', { name: "Attendance", exact: true }).click();
    const attendance = await request.get(`${f.prefix}/tasks/${first.taskId}/attendance`);
    expect(meetingAttendanceListResponseSchema.parse(await attendance.json()).data.every(a => a.status === 'unknown' && a.workLog === null)).toBe(true);
    await page.screenshot({ path: info.outputPath('p3b-desktop-occurrence-drawer.png') });
    await noAutomaticWork(f);
  });
});

test.describe('P3b mobile390', () => {
  test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/Berlin' });
  test('shows server DST resolution and retries a genuinely committed series creation without duplicate headers', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await setup(request, baseURL, 'Встреча при переводе часов', '2026-03-23', 'Asia/Nicosia');
    await page.goto(f.path);
    const dialog = await createForm(page, f, 'Смена времени команды', '2026-03-29', '03:30', 'Asia/Nicosia', 1);
    const checked = await preview(page, f, dialog);
    expect(checked.candidates).toHaveLength(1);
    expect(checked.candidates[0]?.resolution).toMatchObject({ intendedLocalTime: '03:30', resolvedLocalTime: '04:00', warning: 'gap_first_valid', resolvedOffset: '+03:00' });
    await dialog.getByText("Daylight-saving gap", { exact: true }).scrollIntoViewIfNeeded();
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p3b-mobile-dst-preview.png') });
    const attempts: { key: string | undefined; body: string | null }[] = [];
    let committed: unknown;
    const url = `**${f.prefix}/projects/${f.project.id}/recurrence-series`;
    await page.route(url, async route => {
      const sent = route.request();
      if (sent.method() !== 'POST') return route.continue();
      attempts.push({ key: sent.headers()['idempotency-key'], body: sent.postData() });
      const actual = await route.fetch();
      if (attempts.length === 1) { committed = recurrenceSeriesResponseSchema.parse(await actual.json()).data; await route.abort('failed'); }
      else await route.fulfill({ response: actual });
    });
    await dialog.getByRole('button', { name: "Create series", exact: true }).click();
    await expect(dialog.getByRole('button', { name: "Retry original series creation", exact: true })).toBeVisible();
    expect(committed).toBeDefined();
    await dialog.getByRole('button', { name: "Retry original series creation", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.unroute(url);
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy();
    const series = recurrenceSeriesResponseSchema.shape.data.parse(committed);
    await page.getByRole('combobox', { name: "Meeting series", exact: true }).selectOption(series.id);
    expect(await instances(f, series.id)).toHaveLength(1);
    expect(await prepare(page, f)).toMatchObject({ status: 'complete', createdCount: 1, remainingCount: 0 });
    const [header] = await instances(f, series.id); if (!header?.taskId) throw new Error('Prepared DST occurrence required.');
    expect(header.resolution.warning).toBe('gap_first_valid');
    await page.getByRole('table', { name: "Series meetings in period", exact: true }).scrollIntoViewIfNeeded();
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p3b-mobile-series-instance.png') });
    await page.getByRole('button', { name: `Open meeting ${header.occurrenceKey}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Смена времени команды', exact: true })).toBeVisible();
    await noPageOverflow(page);
    await page.screenshot({ path: info.outputPath('p3b-mobile-occurrence-drawer.png') });
    await noAutomaticWork(f);
  });
});
