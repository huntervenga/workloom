import { expect, test, type Locator, type Page } from '@playwright/test';
import { manualPeriodWorkLogListResponseSchema, manualPeriodWorkLogResponseSchema, personalTablePreferenceResponseSchema, planningPeriodResponseSchema, projectColumnsResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { sizes } from './support/next-ux.js';

type View = 'Tasks' | 'Board' | 'Timeline' | 'Graph' | 'CSV import';
const columnsTrigger = (page: Page) => page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ });
const filtersTrigger = (page: Page) => page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ });
const columnsDialog = (page: Page) => page.getByRole('dialog', { name: 'My task columns', exact: true });
const tagsChoice = (dialog: Locator) => dialog.getByRole('listitem').filter({ has: dialog.page().getByText('Tags', { exact: true }) }).getByRole('checkbox');
async function closeColumns(dialog: Locator) { await dialog.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(dialog).toHaveCount(0); }
async function matrix(page: Page, view: View) {
  const table = view === 'Tasks', searchable = table || view === 'Board' || view === 'Timeline', sortable = table || view === 'Board';
  await expect(page.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveCount(table ? 1 : 0);
  await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveCount(table ? 1 : 0);
  await expect(page.getByLabel('Search tasks', { exact: true })).toHaveCount(searchable ? 1 : 0);
  await expect(filtersTrigger(page)).toHaveCount(searchable ? 1 : 0);
  await expect(page.getByRole('combobox', { name: 'Group by', exact: true })).toHaveCount(table ? 1 : 0);
  await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveCount(sortable ? 1 : 0);
  await expect(columnsTrigger(page)).toHaveCount(table ? 1 : 0);
  if (searchable) await expect(page.getByLabel('Search tasks', { exact: true })).toBeVisible();
  if (!table) await expect(page.locator('summary').filter({ hasText: /^About hours$/ })).toHaveCount(0);
}

for (const [name, viewport] of sizes) test.describe(`Contextual project toolbar ${name}`, () => {
  test.use({ viewport });
  test('native view controls retain Table context and unsaved columns without writes; original lost column/hour saves recover from hidden controls with exact retry and current focus', async ({ page, request, baseURL }, info) => {
    test.setTimeout(85_000);
    const f = await dailyFixture(request, baseURL, 'Contextual toolbar');
    const work = await f.createTask(`${f.token} focused work`, { estimateMinutes: 180, startDate: '2027-05-03', dueDate: '2027-05-06' });
    await f.createTask(`${f.token} different status`, { statusId: f.progress.id, estimateMinutes: 60, dueDate: '2027-05-07' });
    const createPeriod = async (name: string, localStart: string, cutoffAt: string) => (await f.post('/periods', { projectId: f.project.id, name, localStart, cutoffAt, timezone: 'Asia/Nicosia', protectEstimate: false }, planningPeriodResponseSchema)).data;
    const originalPeriod = await createPeriod('Original toolbar week', '2027-05-03', '2027-06-01T00:00:00.000Z');
    const otherPeriod = await createPeriod('Different selected hours lens', '2027-05-10', '2027-06-08T00:00:00.000Z');
    const preferencePath = `${f.prefix}/projects/${f.project.id}/table-preferences/me`;
    const head = async () => { const response = await request.get(preferencePath); expect(response.status()).toBe(200); return personalTablePreferenceResponseSchema.parse(await response.json()).data; };
    const teamHead = async () => { const response = await request.get(`${f.prefix}/projects/${f.project.id}/columns`); expect(response.status()).toBe(200); return projectColumnsResponseSchema.parse(await response.json()).data; };
    const originalPreference = await head(), originalTeam = await teamHead(); expect(originalPreference.revision).toBe(0); expect(originalPreference.columns).toBeNull();
    const writes: { method: string; path: string }[] = [], errors: string[] = [], geometry: unknown[] = [];
    page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: new URL(q.url()).pathname }); }); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.path}?week=${originalPeriod.id}&worker=${f.other.id}#toolbar-context`); await matrix(page, 'Tasks');
    await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveValue(originalPeriod.id); await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveValue(f.other.id);
    await page.getByLabel('Search tasks', { exact: true }).fill(f.token); await filtersTrigger(page).click(); await page.getByLabel('Task status', { exact: true }).selectOption(f.todo.id); await filtersTrigger(page).click();
    await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('assignee'); await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('due_asc'); await expect(page.getByRole('button', { name: work.title, exact: true })).toBeVisible();
    await columnsTrigger(page).click(); const chooser = columnsDialog(page); await expect(tagsChoice(chooser)).not.toBeChecked(); await tagsChoice(chooser).check(); await closeColumns(chooser);
    for (const view of ['Board', 'Timeline', 'Graph', 'CSV import'] as const) {
      await page.getByRole('button', { name: view, exact: true }).click(); await matrix(page, view);
      expect(new URL(page.url()).searchParams.get('week')).toBe(originalPeriod.id); expect(new URL(page.url()).searchParams.get('worker')).toBe(f.other.id); expect(new URL(page.url()).searchParams.get('sort')).toBe('due_asc');
      if (view === 'Board' || view === 'Timeline') { await expect(page.getByLabel('Search tasks', { exact: true })).toHaveValue(f.token); await expect(filtersTrigger(page)).toHaveText('Filters (1)'); }
      if (view === 'Graph' || view === 'CSV import') {
        const body = page.getByRole('region', { name: view === 'Graph' ? 'Project dependencies' : 'Project CSV import', exact: true }); await expect(body).toBeVisible();
        if (view === 'Graph') await expect(body.getByRole('list', { name: 'Graph tasks and dependencies', exact: true }).getByRole('listitem')).toHaveCount(1);
        else await expect(body.getByRole('heading', { name: 'Import CSV', exact: true })).toBeVisible();
        for (const width of name === 'mobile' ? [390, 320] : [1440]) {
          await page.setViewportSize({ width, height: viewport.height }); const bounds = await body.boundingBox(); expect(bounds).not.toBeNull(); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth); expect(overflow).toBeLessThanOrEqual(0);
          geometry.push({ view, width, body: bounds, globalOverflow: overflow, browserWrites: writes.length }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: info.outputPath(`toolbar-${view === 'Graph' ? 'graph' : 'import'}-${width}.png`), fullPage: true });
        }
        await page.setViewportSize(viewport);
      }
    }
    await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await matrix(page, 'Tasks'); await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveValue(originalPeriod.id); await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveValue(f.other.id); await expect(page.getByLabel('Search tasks', { exact: true })).toHaveValue(f.token); await expect(filtersTrigger(page)).toHaveText('Filters (1)'); await expect(page.getByRole('combobox', { name: 'Group by', exact: true })).toHaveValue('assignee'); await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveValue('due_asc');
    await columnsTrigger(page).click(); await expect(tagsChoice(chooser)).toBeChecked(); expect(await head()).toEqual(originalPreference); expect(await teamHead()).toEqual(originalTeam); expect(writes).toEqual([]);
    const columnAttempts: { key: string | undefined; body: string | null }[] = [];
    await page.route(`**${preferencePath}`, async route => { if (route.request().method() !== 'PUT') return route.continue(); columnAttempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(200); if (columnAttempts.length === 1) await route.abort('failed'); else await route.fulfill({ response: actual }); });
    try {
      await chooser.getByRole('button', { name: 'Save columns', exact: true }).click(); await expect(chooser.getByRole('button', { name: 'Retry original columns', exact: true })).toBeVisible(); const committedPreference = await head(); expect(committedPreference.revision).toBe(1); await closeColumns(chooser);
      const recoveryView: View = name === 'desktop' ? 'Graph' : 'CSV import'; const activeView = page.getByRole('button', { name: recoveryView, exact: true }); await activeView.click(); await matrix(page, recoveryView); const resumeColumns = page.getByRole('button', { name: 'Resume column save', exact: true }); await expect(resumeColumns).toHaveCount(1); await resumeColumns.click(); await expect(chooser).toBeVisible(); await expect(tagsChoice(chooser)).toBeChecked(); await expect(tagsChoice(chooser)).toBeDisabled();
      const columnsResponse = page.waitForResponse(r => apiCall(r, 'PUT', preferencePath)); await chooser.getByRole('button', { name: 'Retry original columns', exact: true }).click(); const columnsAck = await columnsResponse; expect(columnsAck.status()).toBe(200); await expect(chooser.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible(); await expect(resumeColumns).toHaveCount(0); await closeColumns(chooser); await expect(activeView).toBeFocused();
      expect(columnAttempts).toHaveLength(2); expect(columnAttempts[1]).toEqual(columnAttempts[0]); expect(columnAttempts[0]?.key).toBeTruthy(); expect(JSON.parse(columnAttempts[0]?.body ?? '{}')).toMatchObject({ expectedRevision: 0 }); expect(await head()).toEqual(committedPreference); expect(await teamHead()).toEqual(originalTeam);
      await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await matrix(page, 'Tasks'); await expect(page.getByRole('columnheader', { name: 'Tags', exact: true })).toBeVisible();
      await page.getByRole('button', { name: `Weekly actual hours: ${work.title}`, exact: true }).click(); const fact = page.getByRole('dialog', { name: 'Record weekly actual hours', exact: true }); await fact.getByLabel('Actual hours this week', { exact: true }).fill('1.25');
      const hoursPath = `${f.prefix}/tasks/${work.id}/manual-period-work/${originalPeriod.id}/${f.other.id}`; const hoursAttempts: { key: string | undefined; body: string | null }[] = []; const firstCommitted = gate(), firstHeld = gate(), retryCommitted = gate(), retryHeld = gate();
      await page.route(`**${hoursPath}`, async route => { if (route.request().method() !== 'PUT') return route.continue(); hoursAttempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(200); expect(manualPeriodWorkLogResponseSchema.parse(await actual.json()).data).toMatchObject({ taskId: work.id, periodId: originalPeriod.id, membershipId: f.other.id, minutes: 75, revision: 1 }); if (hoursAttempts.length === 1) { firstCommitted.release(); await firstHeld.wait; await route.abort('failed'); } else { retryCommitted.release(); await retryHeld.wait; await route.fulfill({ response: actual }); } });
      try {
        await fact.getByRole('button', { name: 'Save actual hours', exact: true }).click(); await firstCommitted.wait; await fact.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(fact).toHaveCount(0);
        await page.getByRole('combobox', { name: 'Week for hours', exact: true }).selectOption(otherPeriod.id); await page.getByRole('combobox', { name: 'Whose hours to show', exact: true }).selectOption(f.own.id); await page.getByRole('button', { name: 'Timeline', exact: true }).click(); await matrix(page, 'Timeline'); const recoverHours = page.getByRole('button', { name: 'Open original hours save', exact: true }); await expect(recoverHours).toHaveCount(1); const search = page.getByLabel('Search tasks', { exact: true }); await search.click(); firstHeld.release(); await expect(page.getByText(/The original week and person are preserved/)).toBeVisible(); await expect(search).toBeFocused();
        await recoverHours.click(); await expect(fact).toBeVisible(); await expect(fact.getByRole('region', { name: 'Time entry context', exact: true })).toContainText(f.other.displayName); await expect(fact.getByLabel('Actual hours this week', { exact: true })).toHaveValue('1:15'); expect(new URL(page.url()).searchParams.get('week')).toBe(originalPeriod.id); expect(new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
        const hoursResponse = page.waitForResponse(r => apiCall(r, 'PUT', hoursPath)); await fact.getByRole('button', { name: 'Retry original save', exact: true }).click(); await retryCommitted.wait; await fact.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(fact).toHaveCount(0); await search.click(); await expect(search).toBeFocused(); const currentUrl = page.url(); retryHeld.release(); expect((await hoursResponse).status()).toBe(200); await expect(recoverHours).toHaveCount(0); await expect(search).toBeFocused(); expect(page.url()).toBe(currentUrl); await expect(page.getByRole('button', { name: 'Timeline', exact: true })).toHaveAttribute('aria-current', 'page'); await matrix(page, 'Timeline');
        expect(hoursAttempts).toHaveLength(2); expect(hoursAttempts[1]).toEqual(hoursAttempts[0]); expect(hoursAttempts[0]?.key).toBeTruthy(); expect(JSON.parse(hoursAttempts[0]?.body ?? '{}')).toEqual({ expectedRevision: null, minutes: 75, state: 'active', reason: null });
        const logResponse = await request.get(`${f.prefix}/worklogs?periodId=${originalPeriod.id}`); expect(logResponse.status()).toBe(200); const logs = manualPeriodWorkLogListResponseSchema.parse(await logResponse.json()).data; expect(logs).toHaveLength(1); expect(logs[0]).toMatchObject({ taskId: work.id, periodId: originalPeriod.id, membershipId: f.other.id, minutes: 75, revision: 1 }); const otherLogs = await request.get(`${f.prefix}/worklogs?periodId=${otherPeriod.id}`); expect(otherLogs.status()).toBe(200); expect(manualPeriodWorkLogListResponseSchema.parse(await otherLogs.json()).data).toEqual([]);
        const href = await page.getByRole('link', { name: 'Week', exact: true }).getAttribute('href'); const carried = new URL(href ?? '', f.origin); expect(carried.searchParams.get('period')).toBe(originalPeriod.id); expect(carried.searchParams.get('worker')).toBe(f.other.id); expect(new URL(page.url()).hash).toBe('#toolbar-context');
        await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await matrix(page, 'Tasks'); await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveValue(originalPeriod.id); await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveValue(f.other.id); await expect(page.getByRole('combobox', { name: 'Group by', exact: true })).toHaveValue('assignee'); await expect(page.getByRole('combobox', { name: 'Sort', exact: true })).toHaveValue('due_asc'); await expect(page.getByLabel('Search tasks', { exact: true })).toHaveValue(f.token); await expect(filtersTrigger(page)).toHaveText('Filters (1)');
        expect(writes).toEqual([{ method: 'PUT', path: preferencePath }, { method: 'PUT', path: preferencePath }, { method: 'PUT', path: hoursPath }, { method: 'PUT', path: hoursPath }]); expect(await head()).toEqual(committedPreference); expect(await teamHead()).toEqual(originalTeam); expect(await f.task(work.id)).toEqual(work); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await page.screenshot({ path: info.outputPath(`toolbar-return-table-${name}.png`), fullPage: true });
        await evidenceJson(info, 'contextual-toolbar-proof.json', { projectId: f.project.id, columnAttempts, hoursAttempts, originalPeriod, otherPeriod, originalMembershipId: f.other.id, committedPreference, originalTeam, logs, geometry, writes, errors, changedHoursLensIsNotActorSwitch: true, actorSwitchCovered: false });
      } finally { firstHeld.release(); retryHeld.release(); if (!page.isClosed()) await page.unroute(`**${hoursPath}`); }
    } finally { if (!page.isClosed()) await page.unroute(`**${preferencePath}`); }
  });
});
