// Root executes this only through the private compiled BFF/PG runner. No main/env discovery.
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@workloom/db';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { applyWeeklyDemo, FIXTURE_SHA, type DemoState } from '../../scripts/bootstrap-hunterman-weekly-demo.mjs';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';

const APP = 'http://127.0.0.1:49318';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function data<T>(response: APIResponse): Promise<T> {
  expect(response.status()).toBe(200);
  return (await response.json() as { data: T }).data;
}
async function theme(page: Page, dark: boolean) {
  const control = page.getByRole('button', { name: 'Dark theme', exact: true });
  if (await control.getAttribute('aria-pressed') !== String(dark)) await control.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', dark ? 'dark' : 'light');
}

test.describe('Five-person saved reports on the private compiled app', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1') throw new Error('PRIVATE_REPORT_RUNNER_REQUIRED');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('PRIVATE_REPORT_TRACE_VIDEO_OFF_REQUIRED');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  test('discovers the team report, preserves personal originals and category denominator in both themes', async ({ page, context }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.name));
    const identity = provider.registerIdentity(`Reports ${randomUUID()}`);
    await page.goto(`${APP}/app`);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: identity.buttonName, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
    const me = await data<{ actor: { id: string } }>(await page.request.get(`${APP}/api/v1/me`));
    const workspaces = await data<{ id: string }[]>(await page.request.get(`${APP}/api/v1/workspaces`));
    expect(workspaces).toHaveLength(1);
    const workspaceId = workspaces[0]?.id;
    if (!workspaceId) throw new Error('PRIVATE_OWNER_WORKSPACE_MISSING');
    const dsn = new URL(process.env.WORKLOOM_QA_DATABASE_URL ?? '');
    if (dsn.protocol !== 'postgresql:' || dsn.hostname !== '127.0.0.1' || dsn.port !== '60651' || dsn.username !== 'workloom_qa' || dsn.password || dsn.search || dsn.hash || !/^\/workloom_test_autosave_reports_[a-z0-9]+_test$/.test(dsn.pathname)) throw new Error('PRIVATE_REPORT_CHILD_REQUIRED');
    const db = createDatabase(dsn.href, { requireLoopback: true, maxConnections: 1 });
    const state: DemoState = { version: 1, workspaceId, ownerUserId: me.actor.id, fixtureSHA: FIXTURE_SHA, commands: {} };
    let demo: Awaited<ReturnType<typeof applyWeeklyDemo>>;
    try { demo = await applyWeeklyDemo({ db, workspaceId, ownerUserId: me.actor.id, state, persist: async () => {} }); }
    finally { await db.close(); }
    expect(demo.checks.failed).toBe(0);
    const writes: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push(request.method()); });
    const { projectId, periodId, runId, typeRunId } = demo.complete;
    const projectUrl = `${APP}/app/w/${workspaceId}/projects/${projectId}`;
    const reportUrl = `${projectUrl}/week?period=${periodId}&view=report&run=${runId}`;
    await page.goto(`${projectUrl}?week=${periodId}`);
    await page.getByRole('link', { name: 'Reports', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Saved results by person', exact: true })).toBeVisible();
    const people = page.getByRole('table', { name: 'Saved baseline, added and unplanned hours for every person in this report, sorted by name', exact: true });
    await expect(people.locator('tbody tr')).toHaveCount(5);
    const names = ['QA Shared Auth', 'Maya Chen', 'Leo Bennett', 'Sofia Rivera', 'Noah Patel'];
    const facts = ['40h', '39h 30m', '38h 30m', '36h', '43h'];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]; if (!name) throw new Error('PERSON_ORACLE_MISSING');
      const row = people.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
      await expect(row.getByRole('cell').nth(0)).toHaveText('40h');
      await expect(row.getByRole('cell').nth(1)).toHaveText(facts[index] ?? 'ORACLE_MISSING');
    }
    // All displayed totals are the pinned server cohort, not a sum of loaded task pages.
    for (const dark of [false, true]) {
      await theme(page, dark);
      await expect(people.locator('tbody tr')).toHaveCount(5);
      const saved = page.getByRole('region', { name: 'Saved report', exact: true });
      await expect(saved.getByText('200h', { exact: true })).toBeVisible();
      await expect(saved.getByText('197h', { exact: true })).toBeVisible();
      const originalRows = page.getByRole('table', { name: 'Saved planned and actual hours', exact: true });
      await expect(originalRows.getByRole('columnheader', { name: 'Completed work review', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
      await page.screenshot({ path: info.outputPath(`team-report-${dark ? 'dark' : 'light'}.png`), fullPage: true });
    }
    // Explicitly pin an existing personal report; no new report POST is needed to inspect it.
    const personal = state.commands['person-report:maya'] as { response?: { id: string } } | undefined;
    if (!personal?.response?.id) throw new Error('PRIVATE_PERSONAL_REPORT_MISSING');
    await page.goto(`${projectUrl}/week?period=${periodId}&view=report&run=${personal.response.id}`);
    await expect(people.locator('tbody tr')).toHaveCount(1);
    await expect(people.getByRole('rowheader', { name: 'Maya Chen', exact: true })).toBeVisible();
    await expect(people.getByRole('cell').nth(0)).toHaveText('40h');
    await page.goto(`${projectUrl}/week?period=${periodId}&view=work-types&typeRun=${typeRunId}`);
    const distribution = page.getByRole('region', { name: 'Work-type distribution', exact: true });
    const shares = distribution.getByRole('table', { name: 'Share of recorded hours', exact: true });
    await expect(shares.locator('tbody tr')).toHaveCount(6);
    const categoryHours: Record<string, string> = { Bugfix: '23h', Development: '45h', Business: '54h 30m', Sales: '34h', Management: '34h 15m', Uncategorized: '9h' };
    for (const [category, hours] of Object.entries(categoryHours)) {
      const row = shares.getByRole('row').filter({ has: page.getByRole('cell', { name: category, exact: true }) });
      await expect(row.getByRole('cell').nth(1)).toHaveText(hours);
    }
    const percentages = await shares.locator('tbody tr td:last-child').allTextContents();
    expect(percentages.map(value => Number(value.replace('%', '').trim())).reduce((sum, value) => sum + value, 0)).toBeCloseTo(100, 0);
    await expect(page.getByRole('region', { name: 'Saved breakdown', exact: true }).getByText('199h 45m', { exact: true })).toBeVisible();
    await page.goto(reportUrl);
    const first = page.getByRole('table', { name: 'Saved planned and actual hours', exact: true }).getByRole('row').filter({ hasText: 'Define the release success criteria' });
    await first.getByRole('button', { name: 'View linked task (1)', exact: true }).click();
    const opened = context.waitForEvent('page');
    await first.getByRole('link', { name: /Define the release success criteria/ }).click();
    const taskPage = await opened;
    await expect(taskPage).toHaveURL(/task=[a-f0-9-]+/);
    await expect(taskPage.getByRole('group', { name: 'Task fields', exact: true })).toBeVisible();
    await taskPage.close();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
});
