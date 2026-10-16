// Results-first and late acknowledgement ownership on real saved reports, not mock totals.
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { freezePreviewResponseSchema, manualPeriodWorkLogResponseSchema, periodCommitmentResponseSchema, planBaselineResponseSchema, planningPeriodResponseSchema, weeklyPlanFactReportRunResponseSchema, workTypeReportRunResponseSchema } from '@workloom/contracts';
import { dailyFixture, gate } from './support/daily-fixture.js';

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Saved report setup ${name}`, () => {
    test.use({ viewport });
    test('selected results precede hidden setup; expand performs no POST; pending A then selected B keeps B after the original late acknowledgement', async ({ page, request, baseURL }, info) => {
      test.setTimeout(75_000);
      const f = await dailyFixture(request, baseURL, 'Report setup');
      const ownTask = await f.createTask(`${f.token} own work`, { estimateMinutes: 90 });
      const otherTask = await f.createTask(`${f.token} other work`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.other.id], estimateMinutes: 30 });
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'Report review week', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      for (const [task, member, minutes] of [[ownTask, f.own, 90], [otherTask, f.other, 30]] as const) await f.post(`/periods/${period.id}/commitments`, { workPackageId: task.workPackageId, membershipId: member.id, expectedAbsent: true, plannedMinutes: minutes, allocations: [{ taskId: task.id, minutes }] }, periodCommitmentResponseSchema);
      const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
      const baseline = (await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200)).data;
      for (const [task, member, minutes] of [[ownTask, f.own, 60], [otherTask, f.other, 30]] as const) {
        const r = await request.put(`${f.prefix}/tasks/${task.id}/manual-period-work/${period.id}/${member.id}`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: null, minutes, state: 'active' } });
        expect(r.status()).toBe(200); expect(manualPeriodWorkLogResponseSchema.parse(await r.json()).data.minutes).toBe(minutes);
      }
      const weeklyA = (await f.post('/report-runs', { baselineId: baseline.id, membershipIds: [], knownEstimatesOnly: false }, weeklyPlanFactReportRunResponseSchema)).data;
      const weeklyB = (await f.post('/report-runs', { baselineId: baseline.id, membershipIds: [f.own.id], knownEstimatesOnly: false }, weeklyPlanFactReportRunResponseSchema)).data;
      const typesA = (await f.post('/work-type-report-runs', { periodId: period.id, membershipIds: [] }, workTypeReportRunResponseSchema)).data;
      const typesB = (await f.post('/work-type-report-runs', { periodId: period.id, membershipIds: [f.own.id] }, workTypeReportRunResponseSchema)).data;
      expect(weeklyA.summary.knownPlannedMinutes).toBe(120); expect(weeklyB.summary.knownPlannedMinutes).toBe(90); expect(typesA.totalActualMinutes).toBe(90); expect(typesB.totalActualMinutes).toBe(60);
      const posts: string[] = [];
      page.on('request', r => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });
      for (const [kind, runA, runB, endpoint, selectorName, resultName, calculateName, queryKey] of [
        ['report', weeklyA.id, weeklyB.id, '/report-runs', 'Saved report', 'Saved report', 'Calculate new report', 'run'],
        ['work-types', typesA.id, typesB.id, '/work-type-report-runs', 'Saved breakdown', 'Saved breakdown', 'Calculate hours breakdown', 'typeRun'],
      ] as const) {
        await page.goto(`${f.path}/week?period=${period.id}&view=${kind}&${queryKey}=${runA}`);
        const selector = page.getByRole('combobox', { name: selectorName, exact: true });
        const setup = page.getByRole('region', { name: 'New report settings', exact: true });
        const result = page.getByRole('region', { name: resultName, exact: true });
        await expect(selector).toHaveValue(runA); await expect(setup).toBeHidden(); await expect(result).toBeVisible();
        const resultBox = await result.boundingBox(); expect(resultBox).not.toBeNull(); expect(resultBox?.y).toBeLessThan(viewport.height);
        const metricBox = await result.getByText(kind === 'report' ? 'Known planned hours' : 'Total recorded', { exact: true }).boundingBox();
        expect(metricBox).not.toBeNull(); expect((metricBox?.y ?? Infinity) + (metricBox?.height ?? 0)).toBeLessThanOrEqual(viewport.height);
        await page.screenshot({ path: info.outputPath(`report-initial-${kind}-${name}.png`) });
        const count = posts.length; await page.getByRole('button', { name: 'Set up new report', exact: true }).click();
        await expect(setup).toBeVisible(); expect(posts).toHaveLength(count);
        const held = gate(), committed = gate(); let committedRunId = '';
        const routePath = `**${f.prefix}${endpoint}`;
        await page.route(routePath, async route => {
          if (route.request().method() !== 'POST') return route.continue();
          const actual = await route.fetch(); expect(actual.status()).toBe(201);
          const body = await actual.json(); committedRunId = (kind === 'report' ? weeklyPlanFactReportRunResponseSchema : workTypeReportRunResponseSchema).parse(body).data.id;
          committed.release(); await held.wait; await route.fulfill({ response: actual });
        });
        try {
          await setup.getByRole('button', { name: calculateName, exact: true }).click(); await committed.wait;
          expect(committedRunId).toBeTruthy(); await selector.selectOption(runB); await expect(selector).toHaveValue(runB);
          await expect.poll(() => new URL(page.url()).searchParams.get(queryKey)).toBe(runB);
          held.release();
          await expect(setup).toBeHidden();
          await expect(page.getByRole('button', { name: 'Set up new report', exact: true })).toBeVisible();
          await expect(selector).toHaveValue(runB); expect(new URL(page.url()).searchParams.get(queryKey)).toBe(runB);
          await expect(result).toContainText(kind === 'report' ? '1h 30m' : '1h');
          expect(posts).toHaveLength(count + 1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
          await page.screenshot({ path: info.outputPath(`report-setup-${kind}-${name}.png`) });
        } finally { held.release(); await page.unroute(routePath); }
      }
    });
  });
}
