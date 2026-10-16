// Real API acceptance prepared in source. Execute only in the coordinator's compiled window.
import { expect, test, type Page } from '@playwright/test';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { revealTaskDetails } from './support/disclosures.js';

const editor = (page: Page, title: string) => page.getByRole('form', { name: `Edit ${title} in the task table`, exact: true });
async function rename(page: Page, title: string) { await page.getByRole('button', { name: `Rename ${title}`, exact: true }).click(); const form = editor(page, title); await expect(form.getByLabel('Task name', { exact: true })).toBeFocused(); return form; }

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Inline title ${name}`, () => {
    test.use({ viewport });
    test('explicit title-only saves distinguish opening/Graph/completion; synthetic composition guards and retained rich/unknown drafts preserve original commands', async ({ page, request, baseURL }, info) => {
      test.setTimeout(90_000); const f = await dailyFixture(request, baseURL, 'Inline title');
      let work = await f.createTask(`${f.token} rename`, { estimateMinutes: 120 }); const rich = await f.createTask(`${f.token} rich`);
      const writes: { key: string | undefined; body: string | null }[] = [];
      page.on('request', r => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === `${f.prefix}/tasks/${work.id}`) writes.push({ key: r.headers()['idempotency-key'], body: r.postData() }); });
      await page.goto(f.path);
      await expect(page.getByRole('button', { name: `Mark ${work.title} complete`, exact: true })).toBeVisible();
      const square = page.getByRole('checkbox', { name: `Select for graph: ${work.title}`, exact: true }); await square.check(); await square.uncheck();
      await page.getByRole('button', { name: work.title, exact: true }).click(); let drawer = page.getByRole('dialog', { name: work.title, exact: true });
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(work.title); await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0); expect(writes).toEqual([]);
      let form = await rename(page, work.title); let input = form.getByLabel('Task name', { exact: true });
      const renamed = `${f.token} first saved`; await input.fill(`  ${renamed}  `); await input.press('Tab'); expect(writes).toEqual([]);
      // Browser-dispatched synthetic events check the boundary only; this is NOT physical IME coverage.
      await input.dispatchEvent('compositionstart', { data: '語' });
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true });
      await input.dispatchEvent('compositionend', { data: '語' });
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }); expect(writes).toEqual([]);
      await input.press('Shift+Enter'); await input.press('Alt+Enter'); expect(writes).toEqual([]);
      const first = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${work.id}`)); await input.press('Enter'); const previous = work; work = await taskResult(await first, 200);
      expect(JSON.parse(writes[0]?.body ?? '{}')).toEqual({ expectedRevision: previous.revision, title: renamed }); expect(work).toMatchObject({ title: renamed, statusId: previous.statusId, workPackageId: previous.workPackageId, estimateMinutes: 120, dueDate: previous.dueDate, participantsRevision: previous.participantsRevision });
      await expect(form).toHaveCount(0); await expect(page.getByRole('button', { name: `Rename ${work.title}`, exact: true })).toBeFocused();
      form = await rename(page, work.title); input = form.getByLabel('Task name', { exact: true }); await input.fill(''); await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form.getByRole('alert')).toContainText('Enter a task name'); expect(writes).toHaveLength(1);
      await input.fill(`${f.token} kept after Escape`); await input.press('Escape'); await expect(form).toHaveCount(0); form = await rename(page, work.title); await expect(form.getByLabel('Task name', { exact: true })).toHaveValue(`${f.token} kept after Escape`);
      // A real second title command commits before its acknowledgement is lost.
      const path = `${f.prefix}/tasks/${work.id}`; const attempts: { key: string | undefined; body: string | null }[] = []; const held = gate(), committed = gate();
      await page.route(`**${path}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(200); if (attempts.length === 1) await route.abort('failed'); else { committed.release(); await held.wait; await route.fulfill({ response: actual }); } });
      const finalTitle = `${f.token} final saved`;
      try {
        await form.getByLabel('Task name', { exact: true }).fill(finalTitle); await form.getByRole('button', { name: 'Save', exact: true }).click(); await expect(form.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
        expect((await f.task(work.id)).title).toBe(finalTitle);
        await form.getByRole('button', { name: 'Collapse editor', exact: true }).click(); await page.getByRole('button', { name: 'Board', exact: true }).click();
        const search = page.getByLabel('Search tasks', { exact: true }); await search.fill(rich.title); await expect(page.getByRole('button', { name: finalTitle, exact: true })).toHaveCount(0);
        await page.getByRole('button', { name: 'Resume original editor', exact: true }).click(); drawer = page.getByRole('dialog', { name: finalTitle, exact: true }); await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(finalTitle);
        await drawer.getByRole('button', { name: 'Retry submission', exact: true }).click(); await committed.wait;
        await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0); await search.focus(); held.release();
        await expect(page.getByRole('button', { name: 'Resume original editor', exact: true })).toHaveCount(0); await expect(search).toBeFocused(); await expect(search).toHaveValue(rich.title); await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-current', 'page');
        expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: work.revision, title: finalTitle }); expect((await f.task(work.id)).revision).toBe(work.revision + 1);
      } finally { held.release(); await page.unroute(`**${path}`); }
      await page.getByLabel('Search tasks', { exact: true }).fill(''); await page.getByRole('button', { name: 'Tasks', exact: true }).click();
      await page.getByRole('button', { name: rich.title, exact: true }).click(); const richDrawer = page.getByRole('dialog', { name: rich.title, exact: true });
      await richDrawer.getByLabel('Task name', { exact: true }).fill(`${rich.title} unsaved`); await richDrawer.getByLabel('Description', { exact: true }).fill('Keep this richer draft separate'); await revealTaskDetails(richDrawer); await richDrawer.getByLabel('Priority', { exact: true }).selectOption('urgent');
      await richDrawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(richDrawer).toHaveCount(0);
      await page.getByRole('button', { name: `Rename ${rich.title}`, exact: true }).click(); const foreign = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select for graph: ${rich.title}`, exact: true }) }); await expect(foreign.getByText('This task has other unsaved changes. Resume its full draft to review them.', { exact: true })).toBeVisible(); await expect(foreign.getByLabel('Task name', { exact: true })).toHaveCount(0);
      await foreign.getByRole('button', { name: 'Resume draft', exact: true }).click(); await expect(richDrawer.getByLabel('Task name', { exact: true })).toHaveValue(`${rich.title} unsaved`); await expect(richDrawer.getByLabel('Description', { exact: true })).toHaveValue('Keep this richer draft separate'); expect(await f.task(rich.id)).toEqual(rich);
      await info.attach('composition-boundary.json', { body: JSON.stringify({ syntheticCompositionOnly: true, physicalImeTested: false, attempts }), contentType: 'application/json' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await page.screenshot({ path: info.outputPath(`inline-title-${name}.png`) });
    });
  });
}
