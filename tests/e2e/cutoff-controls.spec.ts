// Phase A only: real migrated API + explicit controls while the normal worker stays OFF.
// No role/grant SQL fixtures and no fake readiness responses. Transport drops ACK only after commit.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { configureCutoffInputSchema, cutoffCommandResponseSchema, cutoffReadinessResponseSchema, meResponseSchema, planBaselineResponseSchema, planningPeriodResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture } from './support/daily-fixture.js';

const panel = (page: Page) => page.getByRole('region', { name: 'Plan freeze status', exact: true });
async function settings(page: Page) {
  const summary = panel(page).locator('summary').filter({ hasText: /^Automatic freeze$/ });
  if (!await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.click();
}
async function refresh(page: Page) { await panel(page).getByRole('button', { name: 'Refresh status', exact: true }).click(); await expect(panel(page).getByRole('button', { name: 'Refresh status', exact: true })).toBeEnabled(); }

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Cutoff explicit controls ${name}`, () => {
    test.use({ viewport });
    test('unconfigured/overdue/blocked/frozen are real distinct states; exact lost ACK reads newer revoked head and viewer has no actions', async ({ page, browser, request, baseURL }, info) => {
      test.setTimeout(90_000); const f = await dailyFixture(request, baseURL, 'Cutoff controls');
      await f.createTask(`${f.token} baseline source`, { estimateMinutes: 60 });
      const capturedNow = new Date();
      const createPeriod = async (label: string, dayOffset: number, cutoffAt: string) => {
        const start = new Date(capturedNow); start.setUTCDate(start.getUTCDate() + dayOffset);
        return (await f.post('/periods', { projectId: f.project.id, name: label, localStart: start.toISOString().slice(0, 10), timezone: 'Asia/Nicosia', cutoffAt, protectEstimate: false }, planningPeriodResponseSchema)).data;
      };
      // Future period first: create all work before an overdue period can invoke a planning guard.
      const future = await createPeriod('Future automation QA', 7, new Date(capturedNow.getTime() + 86_400_000).toISOString());
      const overdue = await createPeriod('Overdue automation QA', 0, new Date(capturedNow.getTime() - 60_000).toISOString());
      const readiness = async (id: string) => { const r = await request.get(`${f.prefix}/periods/${id}/cutoff-readiness`); expect(r.status(), await r.text()).toBe(200); return cutoffReadinessResponseSchema.parse(await r.json()).data; };
      const mutations: string[] = []; page.on('request', r => { if (!['GET','HEAD','OPTIONS'].includes(r.method())) mutations.push(`${r.method()} ${new URL(r.url()).pathname}`); });
      await page.goto(`${f.path}/week?period=${future.id}`);
      await expect(panel(page).getByText('Planning', { exact: true })).toBeVisible(); await settings(page);
      await expect(panel(page).getByText('Automatic freeze has not been enabled for this period.', { exact: true })).toBeVisible();
      await refresh(page); expect(mutations).toEqual([]); expect(await readiness(future.id)).toMatchObject({ readiness: 'planning', persistedState: 'planning', automation: { state: 'not_configured', grant: null }, baseline: null });
      const path = `${f.prefix}/periods/${future.id}/cutoff-automation`; const attempts: { key: string | undefined; body: string | null }[] = [];
      await page.route(`**${path}`, async route => { if (route.request().method() !== 'PUT') return route.continue(); attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(200); cutoffCommandResponseSchema.parse(await actual.json()); if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response: actual }); });
      await panel(page).getByRole('button', { name: 'Enable automatic freeze', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry original cutoff action', exact: true })).toBeVisible();
      const committed = await readiness(future.id); expect(committed.automation.state).toBe('enabled'); expect(committed.automation.grant?.revision).toBe(1); expect(committed.baseline).toBe(null);
      // A legitimate second tab changes the head after the first tab lost its acknowledgement.
      const off = configureCutoffInputSchema.parse({ expectedPeriodRevision: committed.periodRevision, expectedGrantRevision: committed.automation.grant?.revision, enabled: false });
      const revokedResponse = await request.put(path, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: off }); expect(revokedResponse.status()).toBe(200);
      const revoked = cutoffCommandResponseSchema.parse(await revokedResponse.json()).data; expect(revoked.grant).toMatchObject({ state: 'revoked', revision: 2 });
      await page.getByLabel('Period', { exact: true }).selectOption(overdue.id);
      await expect(panel(page).getByText('Deadline passed · baseline not saved', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Retry original cutoff action', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Retry original cutoff action', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Period', { exact: true })).toHaveValue(overdue.id); // Late original ACK cannot navigate.
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedPeriodRevision: future.revision, expectedGrantRevision: 0, enabled: true });
      await page.getByLabel('Period', { exact: true }).selectOption(future.id); await settings(page);
      await expect(panel(page).getByText('Automatic freeze is turned off for this period.', { exact: true })).toBeVisible(); expect((await readiness(future.id)).automation.grant).toEqual(revoked.grant);
      await page.unroute(`**${path}`);
      await page.getByLabel('Period', { exact: true }).selectOption(overdue.id); await settings(page);
      expect(await readiness(overdue.id)).toMatchObject({ readiness: 'overdue_waiting', persistedState: 'planning', baseline: null });
      const enable = page.waitForResponse(r => apiCall(r, 'PUT', `${f.prefix}/periods/${overdue.id}/cutoff-automation`));
      await panel(page).getByRole('button', { name: 'Enable automatic freeze', exact: true }).click(); expect((await enable).status()).toBe(200);
      await expect(panel(page).getByRole('button', { name: 'Turn off automatic freeze', exact: true })).toBeEnabled();
      const disable = page.waitForResponse(r => apiCall(r, 'PUT', `${f.prefix}/periods/${overdue.id}/cutoff-automation`));
      await panel(page).getByRole('button', { name: 'Turn off automatic freeze', exact: true }).click(); expect((await disable).status()).toBe(200);
      await expect(panel(page).getByText('Automatic freeze needs attention', { exact: true })).toBeVisible();
      const blocked = await readiness(overdue.id); expect(blocked).toMatchObject({ readiness: 'blocked', persistedState: 'planning', baseline: null }); expect(blocked.blockers).toContainEqual({ kind: 'cutoff', code: 'cutoff_grant_revoked', seriesId: null, bindingId: null });
      await panel(page).locator('summary').filter({ hasText: /^Review 1 reported blocker$/ }).click();
      await expect(panel(page).getByText('Automatic freeze was turned off. An administrator can enable it again.', { exact: true })).toBeVisible();
      const viewer = f.members.find(member => member.role === 'viewer'); if (!viewer) throw new Error('Existing allowlisted viewer required.');
      const context = await browser.newContext({ baseURL, viewport });
      try {
        const session = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: viewer.userId } }); expect(session.status()).toBe(200); expect(meResponseSchema.parse(await session.json()).data.actor.id).toBe(viewer.userId);
        const view = await context.newPage(); const writes: string[] = []; view.on('request', r => { if (!['GET','HEAD','OPTIONS'].includes(r.method())) writes.push(r.url()); });
        await view.goto(`${f.path}/week?period=${overdue.id}`); await expect(panel(view).getByText('Automatic freeze needs attention', { exact: true })).toBeVisible(); await settings(view); await refresh(view);
        await expect(panel(view).getByRole('button', { name: /^(Enable automatic freeze|Turn off automatic freeze|Renew authorization|Request processing again|Save project baseline)$/ })).toHaveCount(0); expect(writes).toEqual([]);
      } finally { await context.close(); }
      // This is explicitly a MANUAL baseline, never worker-driven freeze evidence.
      await panel(page).getByRole('button', { name: 'Save project baseline', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Save project baseline', exact: true }); const saved = page.waitForResponse(r => apiCall(r, 'POST', `${f.prefix}/periods/${overdue.id}/freeze`));
      await dialog.getByRole('button', { name: 'Confirm baseline', exact: true }).click(); const response = await saved; expect(response.status()).toBe(200); const baseline = planBaselineResponseSchema.parse(await response.json()).data;
      await expect(panel(page).getByText('Project baseline saved', { exact: true })).toBeVisible(); expect((await readiness(overdue.id)).baseline?.id).toBe(baseline.id);
      const beforeReadOnly = mutations.length; await refresh(page); await page.reload(); await expect(panel(page).getByText('Project baseline saved', { exact: true })).toBeVisible(); expect(mutations).toHaveLength(beforeReadOnly);
      await info.attach('cutoff-phase-a.json', { body: JSON.stringify({ capturedNow: capturedNow.toISOString(), futureId: future.id, overdueId: overdue.id, baselineId: baseline.id, manualFreeze: true, workerStartedByTest: false, attempts }), contentType: 'application/json' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await page.screenshot({ path: info.outputPath(`cutoff-controls-${name}.png`) });
    });
  });
}
