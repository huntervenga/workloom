// Separately gated Phase B. No worker/process/migration/queue or fixture writes here.
// The coordinator creates/arms ONE new QA period and passes a private fresh manifest.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { cutoffReadinessResponseSchema, idSchema, meResponseSchema, planBaselineListResponseSchema, planBaselineResponseSchema, planningPeriodResponseSchema, projectResponseSchema } from '@workloom/contracts';

const manifestPath = process.env.WORKLOOM_CUTOFF_OBSERVATION_MANIFEST;
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1), capturedAtUtc: z.iso.datetime(),
  workspaceId: z.literal('5eed0000-0000-4000-8000-000000000201'), projectId: idSchema, periodId: idSchema,
  cutoffAt: z.iso.datetime(), personalBaselineId: idSchema, ownMembershipId: idSchema,
  draftMembershipId: idSchema, workPackageId: idSchema, taskId: idSchema, protectedPeriodId: idSchema,
  requestId: idSchema, grantId: idSchema, grantRevision: z.number().int().positive(), periodRevision: z.number().int().positive(),
});
const panel = (page: Page) => page.getByRole('region', { name: 'Plan freeze status', exact: true });
test('separately armed real worker freezes after deadline; two retained browser views refresh actual baseline/report catalogs without POST', async ({ browser, request, baseURL }, info) => {
  test.skip(!manifestPath, 'Pending explicit coordinator worker/arming GO and private fresh manifest.');
  test.setTimeout(180_000);
  if (!manifestPath || !baseURL) throw new Error('Explicit observation manifest and compiled baseURL required.');
  const m = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const remaining = Date.parse(m.cutoffAt) - Date.now();
  expect(remaining, 'Arm 30–90 seconds before the real deadline, after all setup commands.').toBeGreaterThanOrEqual(30_000); expect(remaining).toBeLessThanOrEqual(90_000);
  expect(Date.now() - Date.parse(m.capturedAtUtc)).toBeLessThan(300_000);
  const prefix = `/api/v1/workspaces/${m.workspaceId}`;
  const project = projectResponseSchema.parse(await (await request.get(`${prefix}/projects/${m.projectId}`)).json()).data;
  expect(project.name).toContain('DailyQA-');
  const before = cutoffReadinessResponseSchema.parse(await (await request.get(`${prefix}/periods/${m.periodId}/cutoff-readiness`)).json()).data;
  const protectedBefore = cutoffReadinessResponseSchema.parse(await (await request.get(`${prefix}/periods/${m.protectedPeriodId}/cutoff-readiness`)).json()).data;
  expect(protectedBefore).toMatchObject({ persistedState: 'planning', baseline: null, automation: { state: 'not_configured', grant: null } });
  expect(before).toMatchObject({ periodRevision: m.periodRevision, persistedState: 'planning', baseline: null, readiness: 'planning', automation: { state: 'enabled', grant: { id: m.grantId, revision: m.grantRevision } }, latestRequest: { id: m.requestId }, missingCount: 0, blockedCount: 0 });
  const me = meResponseSchema.parse(await (await request.get('/api/v1/me')).json()).data;
  expect(before.automation.grant?.authorizerUserId).toBe(me.actor.id);
  const storageState = await request.storageState();
  const writes: string[] = []; const contexts: BrowserContext[] = [];
  const timeline: { at: string; viewport: string; readiness: string }[] = [];
  try {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
      const context = await browser.newContext({ baseURL, viewport, storageState }); contexts.push(context);
      // Copy the existing API actor cookies; do not create/change sessions in this phase.
      const page = await context.newPage(); page.on('request', r => { if (!['GET','HEAD','OPTIONS'].includes(r.method())) writes.push(`${label}: ${r.method()} ${new URL(r.url()).pathname}`); });
      await page.goto(`/w/${m.workspaceId}/projects/${m.projectId}/week?period=${m.periodId}&view=plan&worker=${m.draftMembershipId}`);
      await expect(panel(page).getByText('Planning', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Add to plan', exact: true }).click();
      const plan = page.getByRole('dialog', { name: 'Add to weekly plan', exact: true });
      await plan.getByLabel('Whole task', { exact: true }).selectOption(m.workPackageId);
      await plan.getByLabel('Planned hours', { exact: true }).fill('2.25');
      await plan.getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(plan).toHaveCount(0);
      await page.getByRole('button', { name: 'Report', exact: true }).click();
      await page.getByLabel('Saved baseline', { exact: true }).selectOption(m.personalBaselineId);
      const compare = page.getByRole('checkbox', { name: /^Compare only known personal plans/ }); await compare.check();
      timeline.push({ at: new Date().toISOString(), viewport: label, readiness: 'planning' });
    }
    expect(Date.now(), 'Both retained views must be ready before the real cutoff.').toBeLessThan(Date.parse(m.cutoffAt));
    // Default 2s worker polls require relay + queue pickup; allow 60s AFTER deadline,
    // with an absolute <=150s observation bound. No browser clock/time/network manipulation.
    await expect.poll(async () => {
      const statuses = [];
      for (let i = 0; i < contexts.length; i++) {
        const page = contexts[i]?.pages()[0]; if (!page) throw new Error('Retained observation page missing.');
        const refreshed = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname === `${prefix}/periods/${m.periodId}/cutoff-readiness`);
        await panel(page).getByRole('button', { name: 'Refresh status', exact: true }).click();
        const response = await refreshed; expect(response.status()).toBe(200); const status = cutoffReadinessResponseSchema.parse(await response.json()).data;
        statuses.push(status.persistedState); timeline.push({ at: new Date().toISOString(), viewport: i === 0 ? 'desktop' : 'mobile', readiness: status.readiness });
      }
      expect(writes).toEqual([]); return statuses;
    }, { timeout: Math.min(150_000, remaining + 60_000), intervals: [1500] }).toEqual(['frozen', 'frozen']);
    const protectedAfter = cutoffReadinessResponseSchema.parse(await (await request.get(`${prefix}/periods/${m.protectedPeriodId}/cutoff-readiness`)).json()).data;
    expect(protectedAfter).toMatchObject({ periodRevision: protectedBefore.periodRevision, persistedState: 'planning', baseline: null, automation: { state: 'not_configured', grant: null } });
    const head = cutoffReadinessResponseSchema.parse(await (await request.get(`${prefix}/periods/${m.periodId}/cutoff-readiness`)).json()).data;
    expect(head.latestOutcome).toMatchObject({ requestId: m.requestId, periodId: m.periodId, status: 'frozen', createdCount: 0, remainingCount: 0, blockedCode: null });
    if (!head.baseline) throw new Error('Actual persisted project baseline missing.');
    const baseline = planBaselineResponseSchema.parse(await (await request.get(`${prefix}/baselines/${head.baseline.id}`)).json()).data;
    expect(baseline.snapshot.commitments).toHaveLength(1); expect(baseline.snapshot.commitments[0]).toMatchObject({ membershipId: m.ownMembershipId, workPackageId: m.workPackageId, plannedMinutes: 90, allocations: [{ taskId: m.taskId, minutes: 90 }] });
    expect(baseline.snapshot.packages).toHaveLength(1); expect(baseline.snapshot.packages[0]).toMatchObject({ id: m.workPackageId, estimateMinutes: 180 });
    expect(baseline).toMatchObject({ periodId: m.periodId, scope: 'project', mode: 'cutoff', source: 'job', requestedCutoffAt: m.cutoffAt }); expect(Date.parse(baseline.frozenAt)).toBeGreaterThanOrEqual(Date.parse(m.cutoffAt));
    const period = planningPeriodResponseSchema.parse(await (await request.get(`${prefix}/periods/${m.periodId}`)).json()).data; expect(period).toMatchObject({ state: 'frozen', projectBaselineId: baseline.id });
    const baselines = planBaselineListResponseSchema.parse(await (await request.get(`${prefix}/periods/${m.periodId}/baselines`)).json()).data; expect(baselines.some(row => row.id === baseline.id)).toBe(true);
    for (let i = 0; i < contexts.length; i++) {
      const page = contexts[i]?.pages()[0]; if (!page) throw new Error('Retained observation page missing.');
      await expect(panel(page).getByText('Project baseline saved', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Saved baseline', { exact: true })).toHaveValue(m.personalBaselineId);
      await expect(page.getByLabel('Saved baseline', { exact: true }).locator(`option[value="${baseline.id}"]`)).toHaveCount(1);
      await expect(page.getByRole('checkbox', { name: /^Compare only known personal plans/ })).toBeChecked();
      await expect(page.getByLabel('Period', { exact: true })).toHaveValue(m.periodId); expect(new URL(page.url()).searchParams.get('view')).toBe('report');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`worker-frozen-${i === 0 ? 'desktop' : 'mobile'}.png`) });
      await page.getByRole('button', { name: 'Plan and hours', exact: true }).click();
      await expect(page.getByLabel('Time entry for', { exact: true })).toHaveValue(m.draftMembershipId);
      await page.getByRole('button', { name: 'Add to plan', exact: true }).click();
      const retained = page.getByRole('dialog', { name: 'Add to weekly plan', exact: true });
      await expect(retained.getByLabel('Whole task', { exact: true })).toHaveValue(m.workPackageId);
      await expect(retained.getByLabel('Planned hours', { exact: true })).toHaveValue('2.25');
    }
    expect(writes).toEqual([]);
    await info.attach('real-worker-observation.json', { body: JSON.stringify({ manifest: m, baseline: { id: baseline.id, source: baseline.source, mode: baseline.mode, frozenAt: baseline.frozenAt, changeSeq: baseline.changeSeq }, outcome: head.latestOutcome, writes, timeline }), contentType: 'application/json' });
    // Coordinator must separately capture matching immutable request receipt + baseline
    // audit source='job' in read-only RR, and the real queue job/worker completion evidence.
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
