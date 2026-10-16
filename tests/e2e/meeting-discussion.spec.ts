// Real meeting composition of the shared comment command; no attendance command is submitted.
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { meResponseSchema, meetingAttendanceListResponseSchema, meetingCreationResponseSchema, meetingResponseSchema, planningPeriodResponseSchema, taskCommentsResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate } from './support/daily-fixture.js';

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Meeting discussion ${name}`, () => {
    test.use({ viewport });
    test('meeting attendance draft survives Discussion and held comment close/reopen; real literal comment persists and viewer has no composer', async ({ page, browser, request, baseURL }, info) => {
      test.setTimeout(60_000);
      const f = await dailyFixture(request, baseURL, 'Meeting discussion');
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'Meeting discussion QA', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      const meeting = (await f.post(`/projects/${f.project.id}/meetings`, { title: `${f.token} discussion meeting`, statusId: f.todo.id, sectionId: f.section.id, plannedPeriodId: period.id, plannedStartAt: '2027-05-04T10:00:00.000Z', timezone: 'Asia/Nicosia', plannedDurationMinutes: 30, organizerMembershipId: f.own.id, attendeeMembershipIds: [f.own.id, f.other.id] }, meetingCreationResponseSchema)).data;
      const r = await request.patch(`${f.prefix}/tasks/${meeting.task.id}/meeting`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedMeetingRevision: meeting.meeting.revision, actualStartAt: '2027-05-04T10:00:00.000Z', actualDurationMinutes: 25 } }); expect(r.status(), await r.text()).toBe(200); const savedMeeting = meetingResponseSchema.parse(await r.json()).data;
      const initialAttendance = meetingAttendanceListResponseSchema.parse(await (await request.get(`${f.prefix}/tasks/${meeting.task.id}/attendance`)).json()).data; const ownAttendance = initialAttendance.find(row => row.membershipId === f.own.id); if (!ownAttendance) throw new Error('Own meeting attendance row required.');
      const held = gate(), committed = gate(); let commentsPosted = 0; const nonCommentWrites: string[] = [];
      const routePath = `**${f.prefix}/tasks/${meeting.task.id}/comments`;
      page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method()) && !new URL(q.url()).pathname.endsWith('/comments')) nonCommentWrites.push(`${q.method()} ${new URL(q.url()).pathname}`); });
      await page.route(routePath, async route => { if (route.request().method() !== 'POST') return route.continue(); commentsPosted++; const response = await route.fetch(); expect(response.status()).toBe(201); committed.release(); await held.wait; await route.fulfill({ response }); });
      try {
        await page.goto(`${f.path}?task=${meeting.task.id}&meetingTab=attendance&week=${period.id}&worker=${f.own.id}`);
        const drawer = page.getByRole('dialog', { name: meeting.task.title, exact: true });
        await drawer.getByRole('button', { name: 'Edit actual details', exact: true }).click(); await drawer.getByLabel('Actual duration, minutes', { exact: true }).fill('22');
        await drawer.getByRole('combobox', { name: 'Whose attendance', exact: true }).selectOption(ownAttendance.id);
        await drawer.getByLabel('Attendance outcome', { exact: true }).selectOption('partial');
        await drawer.getByLabel('Time attended, hours', { exact: true }).fill('0.25');
        const attendanceComment = drawer.getByLabel('Attendance comment (optional)', { exact: true }); await attendanceComment.fill('Retained attendance draft');
        await drawer.getByRole('tab', { name: /^Discussion/ }).click();
        const body = `  ${f.token} <b>literal meeting</b>\n**separate discussion**  `;
        await drawer.getByLabel('Comment', { exact: true }).fill(body);
        const posted = page.waitForResponse(response => apiCall(response, 'POST', `${f.prefix}/tasks/${meeting.task.id}/comments`));
        await drawer.getByRole('button', { name: 'Add comment', exact: true }).click(); await committed.wait;
        await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
        await page.getByRole('button', { name: meeting.task.title, exact: true }).click();
        await expect(drawer.getByLabel('Comment', { exact: true })).toHaveValue(body); await expect(drawer.getByLabel('Comment', { exact: true })).toBeDisabled();
        await drawer.getByRole('tab', { name: 'Attendance', exact: true }).click();
        await expect(drawer.getByLabel('Actual duration, minutes', { exact: true })).toHaveValue('22'); await expect(drawer.getByRole('combobox', { name: 'Whose attendance', exact: true })).toHaveValue(ownAttendance.id);
        await expect(drawer.getByLabel('Attendance outcome', { exact: true })).toHaveValue('partial'); await expect(drawer.getByLabel('Time attended, hours', { exact: true })).toHaveValue('0.25'); await expect(attendanceComment).toHaveValue('Retained attendance draft');
        await attendanceComment.focus(); held.release(); expect((await posted).status()).toBe(201);
        await expect(attendanceComment).toBeFocused(); await expect(drawer.getByRole('tab', { name: 'Attendance', exact: true })).toHaveAttribute('aria-selected', 'true'); expect(commentsPosted).toBe(1);
        await drawer.getByRole('tab', { name: /^Discussion/ }).click(); const literal = drawer.getByRole('region', { name: 'Discussion', exact: true }).getByText(body, { exact: true }); await expect(literal).toBeVisible(); expect(await literal.textContent()).toBe(body); await expect(literal.locator('b,a')).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`meeting-discussion-${name}.png`) });
        page.once('dialog', dialog => dialog.accept()); await page.reload(); await drawer.getByRole('tab', { name: /^Discussion/ }).click(); await expect(drawer.getByText(body, { exact: true })).toBeVisible();
        const rows = taskCommentsResponseSchema.parse(await (await request.get(`${f.prefix}/tasks/${meeting.task.id}/comments?limit=50`)).json()).data; expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ body, authorMembershipId: f.own.id });
        expect(meetingResponseSchema.parse(await (await request.get(`${f.prefix}/tasks/${meeting.task.id}/meeting`)).json()).data).toEqual(savedMeeting);
        const attendance = meetingAttendanceListResponseSchema.parse(await (await request.get(`${f.prefix}/tasks/${meeting.task.id}/attendance`)).json()).data; expect(attendance.every(row => row.status === 'unknown' && row.workLog === null)).toBe(true); expect(nonCommentWrites).toEqual([]);
        const viewer = f.members.find(member => member.role === 'viewer'); if (!viewer) throw new Error('Existing allowlisted synthetic viewer required.');
        const context = await browser.newContext({ baseURL, viewport });
        try { const session = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: viewer.userId } }); expect(session.status()).toBe(200); expect(meResponseSchema.parse(await session.json()).data.actor.id).toBe(viewer.userId); const view = await context.newPage(); await view.goto(`${f.path}?task=${meeting.task.id}`); const readOnly = view.getByRole('dialog', { name: meeting.task.title, exact: true }); await readOnly.getByRole('tab', { name: /^Discussion/ }).click(); await expect(readOnly.getByText(body, { exact: true })).toBeVisible(); await expect(readOnly.getByLabel('Comment', { exact: true })).toHaveCount(0); } finally { await context.close(); }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      } finally { held.release(); }
    });
  });
}
