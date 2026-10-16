// Real hierarchy commands and retained UI drafts. No fake protected-draft registry.
import { expect, test, type Page } from '@playwright/test';
import { planningPeriodResponseSchema, taskResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { revealTaskDetails } from './support/disclosures.js';

async function closed(page: Page) { await expect(page.getByRole('dialog')).toHaveCount(0); }
async function dismissNativeReload(page: Page) {
  const url = page.url(), timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const nativeDialog = page.waitForEvent('dialog', { timeout: 5000 });
  // Dismissing Chromium's native beforeunload may leave Playwright's navigation pending.
  // Bound the probe; the real dialog, unchanged document and usable retained draft prove protection.
  const reload = page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 }).then(() => ({ outcome: 'completed' })).catch((error: unknown) => ({ outcome: 'not_completed', detail: error instanceof Error ? error.message : String(error) }));
  const dialog = await nativeDialog; expect(dialog.type()).toBe('beforeunload'); await dialog.dismiss(); const reloadResult = await reload;
  expect(page.url()).toBe(url); expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  return { nativeType: dialog.type(), action: 'dismiss', reloadResult, sameDocument: true };
}

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Task hierarchy and retained guard ${name}`, () => {
    test.use({ viewport });
    test('parent/child drafts and detail/additional packages stay distinct; hidden dirty child really blocks cross-path departure and native reload', async ({ page, request, baseURL }, info) => {
      test.setTimeout(100_000); const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(error.message)); const f = await dailyFixture(request, baseURL, 'Hierarchy guard');
      const parent = await f.createTask(`${f.token} parent`, { estimateMinutes: 180 });
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'Hierarchy context', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      const url = `${f.path}?task=${parent.id}&week=${period.id}&worker=${f.other.id}&view=board#hierarchy`;
      let parentWrites = 0; page.on('request', r => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === `${f.prefix}/tasks/${parent.id}`) parentWrites++; });
      await page.goto(url); const parentDrawer = page.getByRole('dialog', { name: parent.title, exact: true });
      await parentDrawer.getByLabel('Description', { exact: true }).fill('Retained parent rich draft'); await revealTaskDetails(parentDrawer); await parentDrawer.getByLabel('Team estimate, hours', { exact: true }).fill('4');
      await expect(parentDrawer.getByText('The subtask uses this task’s saved estimate. Your unsaved estimate stays in this draft.', { exact: true })).toBeVisible();
      await parentDrawer.getByRole('button', { name: 'Add subtask', exact: true }).click();
      let composer = page.getByRole('dialog', { name: 'New subtask', exact: true }); const detailTitle = `${f.token} detail`;
      await composer.getByLabel('Task name', { exact: true }).fill(detailTitle); await expect(composer.getByRole('radio', { name: 'Detail — included in the parent estimate', exact: true })).toBeChecked();
      await composer.getByRole('button', { name: 'Back to parent', exact: true }).click();
      await expect(parentDrawer.getByLabel('Description', { exact: true })).toHaveValue('Retained parent rich draft'); await revealTaskDetails(parentDrawer); await expect(parentDrawer.getByLabel('Team estimate, hours', { exact: true })).toHaveValue('4');
      await parentDrawer.getByRole('button', { name: 'Resume new task draft', exact: true }).click(); await expect(composer.getByLabel('Task name', { exact: true })).toHaveValue(detailTitle);
      const detailSaved = page.waitForResponse(r => apiCall(r, 'POST', `${f.prefix}/tasks`)); await composer.getByRole('button', { name: 'Create task', exact: true }).click(); const detailResponse = await detailSaved, detail = await taskResult(detailResponse, 201);
      expect(JSON.parse(detailResponse.request().postData() ?? '{}')).toMatchObject({ parentTaskId: parent.id, workScope: 'detail' }); expect(JSON.parse(detailResponse.request().postData() ?? '{}')).not.toHaveProperty('estimateMinutes'); expect(detail).toMatchObject({ parentTaskId: parent.id, workPackageId: parent.workPackageId, estimateMinutes: 180 }); await closed(page);
      await page.getByRole('button', { name: detail.title, exact: true }).click(); const childDrawer = page.getByRole('dialog', { name: detail.title, exact: true });
      const parentRead = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/tasks/${parent.id}`)); await childDrawer.getByRole('button', { name: 'Open parent', exact: true }).click(); expect((await parentRead).status()).toBe(200);
      await expect(parentDrawer.getByLabel('Description', { exact: true })).toHaveValue('Retained parent rich draft'); await revealTaskDetails(parentDrawer); await expect(parentDrawer.getByLabel('Team estimate, hours', { exact: true })).toHaveValue('4');
      await parentDrawer.getByRole('button', { name: 'Add subtask', exact: true }).click(); composer = page.getByRole('dialog', { name: 'New subtask', exact: true });
      const addedTitle = `${f.token} additional`; await composer.getByLabel('Task name', { exact: true }).fill(addedTitle); await composer.getByRole('radio', { name: 'Additional work — separate estimate', exact: true }).check(); await revealTaskDetails(composer); await composer.getByLabel('Team estimate, hours', { exact: true }).fill('0.75');
      const attempts: { key: string | undefined; body: string | null }[] = []; const retryHeld = gate(), retryCommitted = gate(); let addedId = '';
      await page.route(`**${f.prefix}/tasks`, async route => { if (route.request().method() !== 'POST') return route.continue(); attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(201); addedId = taskResponseSchema.parse(await actual.json()).data.id; if (attempts.length === 1) await route.abort('failed'); else { retryCommitted.release(); await retryHeld.wait; await route.fulfill({ response: actual }); } });
      try {
        await composer.getByRole('button', { name: 'Create task', exact: true }).click(); await expect(composer.getByRole('button', { name: 'Retry submission', exact: true })).toBeVisible();
        await composer.getByRole('button', { name: 'Back to parent', exact: true }).click(); await expect(parentDrawer.getByLabel('Description', { exact: true })).toHaveValue('Retained parent rich draft');
        await parentDrawer.getByRole('button', { name: 'Resume new task draft', exact: true }).click(); await expect(composer.getByLabel('Task name', { exact: true })).toHaveValue(addedTitle); await expect(composer.getByRole('radio', { name: 'Additional work — separate estimate', exact: true })).toBeChecked();
        await composer.getByRole('button', { name: 'Retry submission', exact: true }).click(); await retryCommitted.wait;
        await composer.getByRole('button', { name: 'Back to parent', exact: true }).click(); const description = parentDrawer.getByLabel('Description', { exact: true }); await expect(description).toHaveValue('Retained parent rich draft'); await expect(description).toBeDisabled(); const parentClose = parentDrawer.getByRole('button', { name: 'Close', exact: true }).first(); await parentClose.focus(); await expect(parentClose).toBeFocused(); retryHeld.release();
        await expect(parentDrawer.getByRole('button', { name: 'Resume new task draft', exact: true })).toHaveCount(0); await expect(parentClose).toBeFocused(); await expect(description).toBeEnabled(); await expect(description).toHaveValue('Retained parent rich draft'); expect(new URL(page.url()).searchParams.get('task')).toBe(parent.id);
        await description.click(); await description.press('End'); await description.pressSequentially(' after acknowledgement'); await expect(description).toHaveValue('Retained parent rich draft after acknowledgement'); await expect(description).toBeFocused();
        expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(JSON.parse(attempts[0]?.body ?? '{}')).toMatchObject({ parentTaskId: parent.id, workScope: 'added_scope', estimateMinutes: 45 });
        const added = await f.task(addedId); expect(added.workPackageId).not.toBe(parent.workPackageId); expect(added.estimateMinutes).toBe(45); expect((await f.task(parent.id)).estimateMinutes).toBe(180); expect(parentWrites).toBe(0);
      } finally { retryHeld.release(); await page.unroute(`**${f.prefix}/tasks`); }
      // Discard only the parent draft, then make the CHILD the only hidden dirty source.
      await parentDrawer.getByRole('button', { name: 'Discard draft', exact: true }).click(); await parentDrawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await closed(page);
      await page.getByRole('button', { name: detail.title, exact: true }).click(); await childDrawer.getByLabel('Description', { exact: true }).fill('Hidden actual child draft');
      await childDrawer.getByRole('button', { name: 'Open parent', exact: true }).click(); await expect(parentDrawer.getByLabel('Description', { exact: true })).toHaveValue(parent.description); await parentDrawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await closed(page);
      const retainedUrl = page.url(); await page.getByRole('link', { name: 'All projects', exact: true }).click(); const guard = page.getByRole('dialog', { name: 'Leave this page?', exact: true });
      await expect(guard).toContainText('You have an unsaved draft on this page.'); await expect(guard).not.toContainText('The server may have saved'); await guard.getByRole('button', { name: 'Stay', exact: true }).click(); await expect(page).toHaveURL(retainedUrl);
      const native = await dismissNativeReload(page); await page.getByRole('button', { name: 'Resume original editor', exact: true }).click(); await expect(childDrawer.getByLabel('Description', { exact: true })).toHaveValue('Hidden actual child draft');
      expect(new URL(page.url()).searchParams.get('week')).toBe(period.id); expect(new URL(page.url()).searchParams.get('worker')).toBe(f.other.id); expect(new URL(page.url()).searchParams.get('view')).toBe('board'); expect(new URL(page.url()).hash).toBe('#hierarchy');
      expect((await f.task(detail.id)).description).toBe(detail.description); expect(parentWrites).toBe(0);
      expect(pageErrors).toEqual([]); await info.attach('native-retained-draft.json', { body: JSON.stringify({ native, pageErrors, realRegistryViaUiOnly: true, attempts }), contentType: 'application/json' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await page.screenshot({ path: info.outputPath(`hierarchy-retained-${name}.png`) });
    });
  });
}
