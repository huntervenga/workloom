import { expect, test } from '@playwright/test';
import { freezePreviewResponseSchema, periodCommitmentResponseSchema, planBaselineResponseSchema, planningPeriodResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { sizes } from './support/next-ux.js';

for (const [name, viewport] of sizes) test.describe(`Inline team estimate ${name}`, () => {
  test.use({ viewport });
  test('unknown and zero stay distinct; details change one shared package counted once; equivalent input sends nothing; hidden exact retry and protected-package rejection retain original meaning', async ({ page, request, baseURL }, info) => {
    test.setTimeout(80_000);
    const f = await dailyFixture(request, baseURL, 'Inline shared team estimate');
    const root = await f.createTask(`${f.token} unknown shared root`);
    const child = await f.createTask(`${f.token} ordinary detail`, { parentTaskId: root.id });
    const retryTask = await f.createTask(`${f.token} independent retry package`, { estimateMinutes: 60 });
    const lockedFixture = await dailyFixture(request, baseURL, 'Protected team estimate');
    const lockedTask = await lockedFixture.createTask(`${lockedFixture.token} protected package`, { estimateMinutes: 180 });
    const period = (await lockedFixture.post('/periods', { projectId: lockedFixture.project.id, name: 'Explicit protected package QA', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: true }, planningPeriodResponseSchema)).data;
    await lockedFixture.post(`/periods/${period.id}/commitments`, { workPackageId: lockedTask.workPackageId, membershipId: lockedFixture.own.id, expectedAbsent: true, plannedMinutes: 180, allocations: [{ taskId: lockedTask.id, minutes: 180 }] }, periodCommitmentResponseSchema);
    const preview = (await lockedFixture.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
    const baseline = (await lockedFixture.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200)).data;
    const lockedBase = await lockedFixture.task(lockedTask.id);
    expect(root.estimateMinutes).toBeNull(); expect(child.workPackageId).toBe(root.workPackageId);
    const attempts: { taskId: string; key: string | undefined; body: string | null }[] = [], errors: string[] = [];
    const zeroReady = gate(), zeroSend = gate(), retryCommitted = gate(), retryAck = gate();
    let zeroHeld = false, retryCount = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const q = route.request(), url = new URL(q.url());
      if (q.method() !== 'PATCH' || !url.pathname.startsWith(`${f.prefix}/tasks/`)) return route.continue();
      const taskId = url.pathname.split('/').at(-1); if (!taskId) throw Error('Task path missing.');
      attempts.push({ taskId, key: q.headers()['idempotency-key'], body: q.postData() });
      if (taskId === root.id && !zeroHeld) { zeroHeld = true; zeroReady.release(); await zeroSend.wait; }
      const actual = await route.fetch();
      if (taskId === retryTask.id) {
        retryCount++; expect(actual.status()).toBe(200);
        if (retryCount === 1) { await route.abort('failed'); return; }
        retryCommitted.release(); await retryAck.wait;
      }
      await route.fulfill({ response: actual });
    });
    try {
      await page.goto(f.path);
      const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Task', exact: true }) });
      const footer = table.getByRole('row').filter({ has: page.getByText('Loaded team budget', { exact: true }) });
      const budget = footer.locator('td > span').first();
      const edit = (title: string) => page.getByRole('button', { name: `Edit team estimate for ${title}`, exact: true });
      const form = (title: string) => page.getByRole('form', { name: `Edit ${title} in the task table`, exact: true });
      await expect(budget).toHaveText('1h'); await edit(root.title).click();
      const zeroForm = form(root.title), zeroInput = zeroForm.getByRole('textbox', { name: 'Team estimate (hours)', exact: true });
      await expect(zeroInput).toHaveValue(''); await expect(zeroForm).toContainText('This changes the shared budget for the whole team and every task in this work package.');
      await zeroInput.fill('0'); const zeroResponse = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${root.id}`)); await zeroInput.press('Enter');
      await zeroReady.wait; await expect(zeroInput).toBeDisabled(); await expect(budget).toHaveText('1h'); expect((await f.task(root.id)).estimateMinutes).toBeNull();
      zeroSend.release(); const zero = await taskResult(await zeroResponse, 200);
      expect(zero).toMatchObject({ revision: root.revision, estimateMinutes: 0, workPackageRevision: root.workPackageRevision + 1 });
      await expect(zeroForm).toHaveCount(0); await expect(edit(root.title).getByText('0m', { exact: true })).toBeVisible(); await expect(edit(child.title).getByText('0m', { exact: true })).toBeVisible(); await expect(budget).toHaveText('1h');
      const childBase = await f.task(child.id); await edit(child.title).click(); const detailForm = form(child.title), detailInput = detailForm.getByRole('textbox', { name: 'Team estimate (hours)', exact: true });
      await detailInput.fill('0.001'); await detailInput.press('Enter'); await expect(detailInput).toHaveAttribute('aria-invalid', 'true'); await expect(detailInput).toHaveValue('0.001'); expect(attempts).toHaveLength(1);
      await detailInput.fill('2,0'); const detailResponse = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${child.id}`)); await detailForm.getByRole('button', { name: 'Save', exact: true }).click();
      const detail = await taskResult(await detailResponse, 200); expect(detail).toMatchObject({ revision: childBase.revision, estimateMinutes: 120, workPackageRevision: childBase.workPackageRevision + 1 });
      expect(JSON.parse(attempts[1]?.body ?? '{}')).toEqual({ expectedRevision: childBase.revision, estimateMinutes: 120, expectedWorkPackageRevision: childBase.workPackageRevision });
      await expect(detailForm).toHaveCount(0); await expect(edit(root.title).getByText('2h', { exact: true })).toBeVisible(); await expect(edit(child.title).getByText('2h', { exact: true })).toBeVisible(); await expect(budget).toHaveText('3h');
      for (const [title, raw] of [[root.title, '2:00'], [child.title, '2,00']] as const) {
        await edit(title).click(); const sameForm = form(title); await sameForm.getByRole('textbox', { name: 'Team estimate (hours)', exact: true }).fill(raw); await sameForm.getByRole('button', { name: 'Save', exact: true }).click(); await expect(sameForm).toHaveCount(0); expect(attempts).toHaveLength(2);
      }
      await edit(retryTask.title).click(); const retryForm = form(retryTask.title); await retryForm.getByRole('textbox', { name: 'Team estimate (hours)', exact: true }).fill('1,5'); await retryForm.getByRole('button', { name: 'Save', exact: true }).click(); await expect(retryForm.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      expect((await f.task(retryTask.id)).estimateMinutes).toBe(90);
      await retryForm.getByRole('button', { name: 'Collapse editor', exact: true }).click(); await page.getByRole('button', { name: 'Board', exact: true }).click(); await page.getByRole('button', { name: 'Resume original editor', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: retryTask.title, exact: true }); await expect(drawer).toBeVisible();
      const details = drawer.locator('summary').filter({ hasText: /^More details$/ }); if (!(await drawer.getByRole('textbox', { name: 'Team estimate, hours', exact: true }).isVisible())) await details.click();
      await expect(drawer.getByRole('textbox', { name: 'Team estimate, hours', exact: true })).toHaveValue('1,5');
      const retried = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${retryTask.id}`)); await drawer.getByRole('button', { name: 'Retry submission', exact: true }).click(); await retryCommitted.wait;
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0); const search = page.getByLabel('Search tasks', { exact: true }); await search.click(); await expect(search).toBeFocused(); retryAck.release(); const retryResult = await taskResult(await retried, 200); await expect(search).toBeFocused();
      const bAttempts = attempts.filter(a => a.taskId === retryTask.id); expect(bAttempts).toHaveLength(2); expect(bAttempts[1]).toEqual(bAttempts[0]); expect(JSON.parse(bAttempts[0]?.body ?? '{}')).toEqual({ expectedRevision: retryTask.revision, estimateMinutes: 90, expectedWorkPackageRevision: retryTask.workPackageRevision });
      expect(retryResult).toMatchObject({ revision: retryTask.revision, workPackageRevision: retryTask.workPackageRevision + 1, estimateMinutes: 90 });
      await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await expect(budget).toHaveText('3h 30m'); await expect(edit(root.title).getByText('2h', { exact: true })).toBeVisible(); await expect(edit(child.title).getByText('2h', { exact: true })).toBeVisible(); expect(attempts).toHaveLength(4);
      await page.screenshot({ path: info.outputPath(`inline-shared-estimate-${name}.png`), fullPage: true });
      // All main drafts are confirmed and clean before entering the separate protected fixture.
      await page.goto(lockedFixture.path); await edit(lockedTask.title).click(); const lockedForm = form(lockedTask.title), lockedInput = lockedForm.getByRole('textbox', { name: 'Team estimate (hours)', exact: true });
      await lockedInput.fill('4,5'); const refusalResponse = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${lockedTask.id}`)); await lockedForm.getByRole('button', { name: 'Save', exact: true }).click();
      const refusal = await refusalResponse; expect(refusal.status(), await refusal.text()).toBe(409); const rejected = await refusal.json() as { error: { code: string } }; expect(rejected.error.code).toBe('FIELD_LOCKED');
      await expect(lockedForm).toContainText(/locked/i); await expect(lockedInput).toHaveValue('4,5'); expect(await lockedFixture.task(lockedTask.id)).toEqual(lockedBase); await expect(budget).toHaveText('3h');
      await lockedForm.getByRole('button', { name: 'Collapse editor', exact: true }).click(); await edit(lockedTask.title).click(); await expect(form(lockedTask.title).getByRole('textbox', { name: 'Team estimate (hours)', exact: true })).toHaveValue('4,5');
      expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await page.screenshot({ path: info.outputPath(`inline-estimate-lock-${name}.png`), fullPage: true });
      await evidenceJson(info, 'inline-estimate-proof.json', { root, child, zero, detail, retryResult, attempts, lockedTask, lockedBase, period, baseline, rejected, errors, physicalImeTested: false, lateRefetchedCommittedValuesAllowed: true });
    } finally { zeroSend.release(); retryAck.release(); await page.unroute('**/api/**'); }
  });
});
