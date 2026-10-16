// SOURCE-ONLY preparation: run only after the coordinator's compiled/runtime GO.
// Main fixtures use supported APIs in the historical synthetic QA workspace, never Studio.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { errorResponseSchema, projectDependencyPolicyResponseSchema, taskDependencyResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { revealTaskDetails, revealTaskFilters } from './support/disclosures.js';

const completion = (page: Page, id: string) => page.locator(`button[data-task-completion="${id}"]`);
const feedback = (page: Page) => page.getByRole('region', { name: 'Task completion status', exact: true });
const lanes = (page: Page) => page.getByRole('region', { name: 'Task status lanes', exact: true });
async function collapseFilters(page: Page) {
  const summary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ });
  if (await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.click();
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }

// Observation only: retain the actual target/focus chronology around dialog close and keys.
type FocusAudit = { at: number; type: string; key?: string; target: string; active: string };
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const target = (node: EventTarget | null) => node instanceof Element ? `${node.tagName}:${node.getAttribute('aria-label') ?? ''}:${node.getAttribute('data-task-completion') ?? ''}` : 'none';
    const records: FocusAudit[] = [];
    (window as Window & { completionFocusAudit?: FocusAudit[] }).completionFocusAudit = records;
    for (const type of ['focusin', 'keydown', 'keyup', 'click']) document.addEventListener(type, event => {
      records.push({ at: performance.now(), type, ...('key' in event ? { key: String(event.key) } : {}), target: target(event.target), active: target(document.activeElement) });
    }, true);
  });
});
test.afterEach(async ({ page }, info) => {
  const records = await page.evaluate(() => (window as Window & { completionFocusAudit?: FocusAudit[] }).completionFocusAudit ?? []).catch(() => []);
  await info.attach('completion-focus-events.json', { body: JSON.stringify(records), contentType: 'application/json' });
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Task completion ${name}`, () => {
    test.use({ viewport });
    test('Graph selection writes nothing; real dependency refusal, single-done keyboard completion and explicit reopening preserve revision/focus', async ({ page, request, baseURL }, info) => {
      test.setTimeout(75_000);
      const f = await dailyFixture(request, baseURL, 'Completion policy');
      const predecessor = await f.createTask(`${f.token} predecessor`), blocked = await f.createTask(`${f.token} blocked`), work = await f.createTask(`${f.token} keyboard`);
      await f.post('/dependencies', { predecessorTaskId: predecessor.id, successorTaskId: blocked.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema);
      const current = projectDependencyPolicyResponseSchema.parse(await (await request.get(`${f.prefix}/projects/${f.project.id}/dependency-policy`)).json()).data;
      const policy = await request.patch(`${f.prefix}/projects/${f.project.id}/dependency-policy`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: current.revision, mode: 'enforce' } }); expect(policy.status()).toBe(200);
      const writes: { path: string; body: string | null }[] = [];
      page.on('request', r => { if (r.method() === 'PATCH') writes.push({ path: new URL(r.url()).pathname, body: r.postData() }); });
      await page.goto(f.path);
      const square = page.getByRole('checkbox', { name: `Select for graph: ${work.title}`, exact: true });
      await square.check(); await expect(square).toBeChecked(); await square.uncheck(); expect(writes).toEqual([]);
      const refused = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${blocked.id}`));
      await completion(page, blocked.id).click(); const refusal = await refused;
      expect(refusal.status()).toBe(422); expect(errorResponseSchema.parse(await refusal.json()).error).toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED', details: { fields: ['statusId'] } });
      expect(await f.task(blocked.id)).toEqual(blocked); await expect(feedback(page)).toBeVisible();
      // A known refusal keeps its status draft; explicitly discard it before another task command.
      await feedback(page).getByRole('button', { name: 'Review original task', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: blocked.title, exact: true });
      await expect(drawer.getByLabel('Status', { exact: true })).toHaveValue(f.done.id);
      await drawer.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
      const held = gate(), committed = gate(); const attempts: { body: string | null; key: string | undefined }[] = [];
      const path = `${f.prefix}/tasks/${work.id}`;
      await page.route(`**${path}`, async route => {
        if (route.request().method() !== 'PATCH') return route.continue();
        attempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
        const actual = await route.fetch(); expect(actual.status()).toBe(200); committed.release(); await held.wait; await route.fulfill({ response: actual });
      });
      try {
        const saved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); const action = completion(page, work.id);
        await action.focus(); await action.press('Enter'); await committed.wait;
        await expect(action).toBeFocused(); await expect(action).toHaveAttribute('aria-disabled', 'true');
        await expect(page.getByRole('button', { name: `Reopen ${work.title}`, exact: true })).toHaveCount(0);
        await action.press('Space'); await action.press('Enter'); expect(attempts).toHaveLength(1);
        expect((await f.task(work.id)).statusId).toBe(f.done.id); // DB committed; browser ACK still withheld.
        held.release(); const head = await taskResult(await saved, 200); expect(head.revision).toBe(work.revision + 1);
        await expect(action).toHaveAccessibleName(`Reopen ${work.title}`); await expect(action).toBeFocused();
        expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: work.revision, statusId: f.done.id }); expect(attempts[0]?.key).toBeTruthy();
      } finally { held.release(); await page.unroute(`**${path}`); }
      const action = completion(page, work.id); await action.click();
      await expect(page.getByRole('menuitem', { name: `Reopen as ${f.todo.name}`, exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(action).toBeFocused(); expect(writes).toHaveLength(2);
      await action.click(); const reopened = page.waitForResponse(r => apiCall(r, 'PATCH', path));
      await page.getByRole('menuitem', { name: `Reopen as ${f.progress.name}`, exact: true }).click();
      expect((await taskResult(await reopened, 200)).statusId).toBe(f.progress.id); expect((await f.task(work.id)).revision).toBe(work.revision + 2);
      expect(JSON.parse(writes[2]?.body ?? '{}')).toEqual({ expectedRevision: work.revision + 1, statusId: f.progress.id });
      await expect(action).toHaveAccessibleName(`Mark ${work.title} complete`); await expect(action).toBeFocused();
      await noOverflow(page); await page.screenshot({ path: info.outputPath(`completion-policy-${name}.png`) });
    });

    test('rich drafts remain separate; committed unknown completion replays exactly across hidden filters/views and populated later Board lanes stay locally scrollable', async ({ page, request, baseURL }, info) => {
      test.setTimeout(75_000); const f = await dailyFixture(request, baseURL, 'Completion recovery');
      const rich = await f.createTask(`${f.token} rich draft`), work = await f.createTask(`${f.token} unknown`);
      for (const status of f.statuses) await f.createTask(`${f.token} ${status.name} lane`, { statusId: status.id, dueDate: '2027-05-05' });
      let richWrites = 0; page.on('request', r => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === `${f.prefix}/tasks/${rich.id}`) richWrites++; });
      await page.goto(`${f.path}?task=${rich.id}`); const drawer = page.getByRole('dialog', { name: rich.title, exact: true });
      const draftTitle = `${rich.title} unsaved`; await drawer.getByLabel('Task name', { exact: true }).fill(draftTitle);
      await drawer.getByLabel('Description', { exact: true }).fill('Rich retained\ncompletion must not merge this');
      await revealTaskDetails(drawer); await drawer.getByLabel('Priority', { exact: true }).selectOption('urgent');
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
      await expect(completion(page, rich.id)).toHaveAccessibleName(`Resume draft for ${rich.title}`); await completion(page, rich.id).click();
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(draftTitle); await expect(drawer.getByLabel('Description', { exact: true })).toHaveValue('Rich retained\ncompletion must not merge this');
      await revealTaskDetails(drawer); await expect(drawer.getByLabel('Priority', { exact: true })).toHaveValue('urgent');
      expect(richWrites).toBe(0); expect(await f.task(rich.id)).toEqual(rich); await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
      const path = `${f.prefix}/tasks/${work.id}`; const attempts: { body: string | null; key: string | undefined }[] = [];
      await page.route(`**${path}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); attempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] }); const actual = await route.fetch(); expect(actual.status()).toBe(200); if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response: actual }); });
      await expect(drawer).toHaveCount(0); await completion(page, work.id).focus(); await expect(completion(page, work.id)).toBeFocused();
      await completion(page, work.id).press('Space'); await expect(feedback(page).getByRole('button', { name: 'Retry original status change', exact: true })).toBeVisible();
      expect((await f.task(work.id)).revision).toBe(work.revision + 1);
      await revealTaskFilters(page); await page.getByLabel('Task status', { exact: true }).selectOption(f.todo.id); await collapseFilters(page);
      await page.getByRole('button', { name: 'Board', exact: true }).click(); await expect(completion(page, work.id)).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Columns(?: · unsaved)?$/ })).toHaveCount(0);
      const search = page.getByLabel('Search tasks', { exact: true }); await search.focus();
      await feedback(page).getByRole('button', { name: 'Retry original status change', exact: true }).click(); await expect(feedback(page)).toHaveCount(0);
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy();
      expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: work.revision, statusId: f.done.id }); expect((await f.task(work.id)).revision).toBe(work.revision + 1);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(lanes(page).getByRole('listitem')).toHaveCount(6);
      const scroll = lanes(page); await expect(scroll).toBeVisible();
      const geometry = await scroll.evaluate(element => { const before = element.scrollLeft; element.scrollLeft = element.scrollWidth; return { client: element.clientWidth, width: element.scrollWidth, before, after: element.scrollLeft, global: document.documentElement.scrollWidth - innerWidth }; });
      expect(geometry.global).toBeLessThanOrEqual(0); if (name === 'mobile') { expect(geometry.width).toBeGreaterThan(geometry.client); expect(geometry.after).toBeGreaterThan(geometry.before); }
      // Due labels in the populated last lane exposed the original global overflow; retain them.
      const last = lanes(page).locator('section').last(); await expect(last.getByRole('listitem')).toHaveCount(1); await expect(last.locator('dt.sr-only')).toHaveCount(1); await expect(last.locator('dt.sr-only')).toHaveText('Due date');
      await info.attach('populated-lane-geometry.json', { body: JSON.stringify(geometry), contentType: 'application/json' });
      await noOverflow(page); await page.screenshot({ path: info.outputPath(`completion-later-lanes-${name}.png`) });
      await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await completion(page, rich.id).click();
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(draftTitle); await expect(drawer.getByLabel('Description', { exact: true })).toHaveValue('Rich retained\ncompletion must not merge this'); expect(richWrites).toBe(0); expect(await f.task(rich.id)).toEqual(rich);
    });
  });
}
