// Two real browser cases for carried time-entry identity, independent report cohort and meeting drafts.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  freezePreviewResponseSchema, meetingAttendanceListResponseSchema, meetingCreationResponseSchema,
  meetingResponseSchema, periodCommitmentResponseSchema, planBaselineResponseSchema,
  planningPeriodResponseSchema, weeklyPlanFactReportRunResponseSchema,
} from '@workloom/contracts';
import { dailyFixture } from './support/daily-fixture.js';

/** Choose a visible custom-picker label without relying on a native select's DOM value. */
async function choose(page: Page, label: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  const list = page.getByRole('listbox', { name: label, exact: true });
  await expect(list).toBeVisible();
  const chosen = typeof option === 'string'
    ? list.getByRole('option').filter({ has: page.getByText(option, { exact: true }) })
    : list.getByRole('option', { name: option });
  await expect(chosen).toHaveCount(1); await chosen.click(); await expect(list).toHaveCount(0);
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Time context ${name}`, () => {
    test.use({ viewport });
    test('week/person round-trip, separate report cohort/current task link and nonarbitrary meeting attendance preserve drafts without writes', async ({ page, request, baseURL }, info) => {
      test.setTimeout(75_000);
      const f = await dailyFixture(request, baseURL, 'Time context');
      const work = await f.createTask(`${f.token} planned work`, { estimateMinutes: 180 });
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'QA week', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      await f.post(`/periods/${period.id}/commitments`, { workPackageId: work.workPackageId, membershipId: f.own.id, expectedAbsent: true, plannedMinutes: 90, allocations: [{ taskId: work.id, minutes: 90 }] }, periodCommitmentResponseSchema);
      await f.post(`/periods/${period.id}/commitments`, { workPackageId: work.workPackageId, membershipId: f.other.id, expectedAbsent: true, plannedMinutes: 90, allocations: [{ taskId: work.id, minutes: 90 }] }, periodCommitmentResponseSchema);
      const meeting = (await f.post(`/projects/${f.project.id}/meetings`, { title: `${f.token} colleague meeting`, statusId: f.todo.id, sectionId: f.section.id, plannedPeriodId: period.id,
        plannedStartAt: '2027-05-04T10:00:00.000Z', timezone: 'Asia/Nicosia', plannedDurationMinutes: 30,
        organizerMembershipId: f.other.id, attendeeMembershipIds: [f.other.id] }, meetingCreationResponseSchema)).data;
      // Existing actual details are setup only; opening/editing the browser below must record nothing.
      const patched = await request.patch(`${f.prefix}/tasks/${meeting.task.id}/meeting`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: {
        expectedMeetingRevision: meeting.meeting.revision, actualStartAt: '2027-05-04T10:00:00.000Z', actualDurationMinutes: 25,
      } });
      expect(patched.status(), await patched.text()).toBe(200);
      const actual = meetingResponseSchema.parse(await patched.json()).data;
      const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
      const baseline = (await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200)).data;
      const report = (await f.post('/report-runs', { baselineId: baseline.id, membershipIds: [], knownEstimatesOnly: false }, weeklyPlanFactReportRunResponseSchema)).data;
      const writes: string[] = [];
      page.context().on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
      await page.goto(f.path);
      await page.getByRole('link', { name: 'Week', exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get('period')).toBe('');
      await expect(page.getByLabel('Period', { exact: true })).toContainText('Choose a week');
      await page.getByRole('link', { name: 'Back to task table', exact: true }).click();
      await choose(page, 'Week for hours', `${period.name} · ${period.localStart}`);
      await expect.poll(() => new URL(page.url()).searchParams.get('week')).toBe(period.id);
      await choose(page, 'Whose hours to show', f.other.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
      await page.getByRole('link', { name: 'Week', exact: true }).click();
      await expect(page.getByLabel('Period', { exact: true })).toContainText(`${period.name} · ${period.localStart}`);
      await expect.poll(() => new URL(page.url()).searchParams.get('period')).toBe(period.id);
      await expect(page.getByLabel('Time entry for', { exact: true })).toContainText(f.other.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
      await page.getByRole('button', { name: 'Add to plan', exact: true }).click();
      const plan = page.getByRole('dialog', { name: 'Add to weekly plan', exact: true });
      await expect(plan.getByRole('region', { name: 'Time entry context', exact: true })).toContainText(f.other.displayName);
      await expect(plan.getByLabel('Whose plan', { exact: true })).toHaveCount(0);
      await plan.getByLabel('Planned hours', { exact: true }).fill('4.5');
      await plan.getByRole('button', { name: 'Close', exact: true }).last().click();
      await choose(page, 'Time entry for', f.own.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.own.id);
      await page.getByRole('button', { name: 'Add to plan', exact: true }).click();
      await plan.getByLabel('Planned hours', { exact: true }).fill('2.25');
      await plan.getByRole('button', { name: 'Close', exact: true }).last().click();
      await choose(page, 'Time entry for', f.other.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
      await page.getByRole('button', { name: 'Add to plan', exact: true }).click();
      await expect(plan.getByLabel('Planned hours', { exact: true })).toHaveValue('4.5');
      await plan.getByRole('button', { name: 'Close', exact: true }).last().click();
      await page.getByRole('button', { name: 'Report', exact: true }).click();
      const showSetup = page.getByRole('button', { name: 'Set up new report', exact: true });
      await expect(showSetup).toBeVisible(); await showSetup.click();
      await expect(page.getByRole('region', { name: 'New report settings', exact: true })).toBeVisible();
      const people = page.getByRole('group', { name: 'People in report · leave empty to include everyone available', exact: true });
      await expect(people.getByRole('checkbox', { name: f.other.displayName, exact: true })).not.toBeChecked();
      await people.getByRole('checkbox', { name: f.own.displayName, exact: true }).check();
      await expect(page.getByLabel('Time entry for', { exact: true })).toContainText(f.other.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
      await expect(people.getByRole('checkbox', { name: f.other.displayName, exact: true })).not.toBeChecked();
      await choose(page, 'Saved report', / · Project plan · all selected people$/);
      await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBe(report.id);
      const reportRow = page.getByRole('table', { name: 'Saved planned and actual hours', exact: true }).getByRole('row').filter({ hasText: work.title }).filter({ hasText: f.own.displayName });
      await reportRow.getByRole('button', { name: 'View linked task (1)', exact: true }).click();
      const link = reportRow.getByRole('link').filter({ hasText: work.title });
      await expect(link).toHaveAttribute('target', '_blank');
      const reportUrl = page.url(); const popupPromise = page.waitForEvent('popup'); await link.click(); const popup = await popupPromise;
      await expect(popup.getByRole('dialog', { name: work.title, exact: true })).toBeVisible();
      expect(new URL(popup.url()).searchParams.get('week')).toBe(period.id);
      expect(new URL(popup.url()).searchParams.get('worker')).toBe(f.own.id);
      await expect(page.getByLabel('Time entry for', { exact: true })).toContainText(f.other.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
      expect(page.url()).toBe(reportUrl); await popup.close();
      const unchanged = await request.get(`${f.prefix}/report-runs/${report.id}`);
      expect(weeklyPlanFactReportRunResponseSchema.parse(await unchanged.json()).data).toEqual(report);
      await page.getByRole('button', { name: 'Plan and hours', exact: true }).click();
      const meetings = page.getByRole('region', { name: 'Meetings this week', exact: true });
      await meetings.getByRole('button', { name: 'Attendance', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: meeting.task.title, exact: true });
      await expect(drawer.getByRole('combobox', { name: 'Whose attendance', exact: true })).toContainText('Choose a person');
      await expect(drawer.getByLabel('Actual duration, minutes', { exact: true })).toBeHidden();
      await drawer.getByRole('button', { name: 'Edit actual details', exact: true }).click();
      await drawer.getByLabel('Actual duration, minutes', { exact: true }).fill('22');
      await drawer.getByRole('button', { name: 'Close', exact: true }).last().click();
      await meetings.getByRole('button', { name: 'Attendance', exact: true }).click();
      await expect(drawer.getByLabel('Actual duration, minutes', { exact: true })).toHaveValue('22');
      await expect(drawer.getByRole('combobox', { name: 'Whose attendance', exact: true })).toContainText('Choose a person');
      await page.screenshot({ path: info.outputPath(`meeting-context-${name}.png`) });
      await drawer.getByRole('button', { name: 'Close', exact: true }).last().click();
      await page.getByRole('link', { name: 'Back to task table', exact: true }).click();
      const leave = page.getByRole('dialog', { name: 'Leave this page?', exact: true });
      await expect(leave).toContainText('You have an unsaved draft on this page.');
      await leave.getByRole('button', { name: 'Leave without saving', exact: true }).click();
      await expect(page.getByLabel('Week for hours', { exact: true })).toContainText(`${period.name} · ${period.localStart}`);
      await expect.poll(() => new URL(page.url()).searchParams.get('week')).toBe(period.id);
      await expect(page.getByLabel('Whose hours to show', { exact: true })).toContainText(f.other.displayName);
      await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
      const storedActual = meetingResponseSchema.parse(await (await request.get(`${f.prefix}/tasks/${meeting.task.id}/meeting`)).json()).data;
      expect(storedActual).toEqual(actual);
      const attendance = meetingAttendanceListResponseSchema.parse(await (await request.get(`${f.prefix}/tasks/${meeting.task.id}/attendance`)).json()).data;
      expect(attendance.every(row => row.status === 'unknown' && row.workLog === null)).toBe(true);
      expect(writes).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}
