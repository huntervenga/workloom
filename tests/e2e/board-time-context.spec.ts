// Real retained hours command; Board hides controls, never their original session/recovery.
import { expect, test, type Page } from '@playwright/test';
import { manualPeriodWorkLogListResponseSchema, manualPeriodWorkLogResponseSchema, planningPeriodResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate } from './support/daily-fixture.js';

async function noBoardPickers(page: Page) {
  await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveCount(0);
  await expect(page.locator('summary').filter({ hasText: /^About hours$/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Weekly hours in table', exact: true })).toHaveCount(0);
}
for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Board time context ${name}`, () => {
    test.use({ viewport });
    test('no time-control box on Board; pending/unknown real hours save remains singly recoverable with original person/week and no late focus/view changes', async ({ page, request, baseURL }, info) => {
      test.setTimeout(80_000); const f = await dailyFixture(request, baseURL, 'Board time recovery');
      const work = await f.createTask(`${f.token} hours`, { estimateMinutes: 180 });
      for (const status of f.statuses) await f.createTask(`${f.token} ${status.name}`, { statusId: status.id, dueDate: '2027-05-05' });
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'Board hours week', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      const another = (await f.post('/periods', { projectId: f.project.id, name: 'Different lens only', localStart: '2027-05-10', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-08T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      await page.goto(`${f.path}?week=${period.id}&worker=${f.other.id}#time-context`);
      await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveValue(period.id); await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveValue(f.other.id);
      await page.getByRole('button', { name: `Weekly actual hours: ${work.title}`, exact: true }).click();
      const fact = page.getByRole('dialog', { name: 'Record weekly actual hours', exact: true }); await fact.getByLabel('Actual hours this week', { exact: true }).fill('1.25');
      const path = `${f.prefix}/tasks/${work.id}/manual-period-work/${period.id}/${f.other.id}`;
      const firstHeld = gate(), firstCommitted = gate(), retryHeld = gate(), retryCommitted = gate();
      const attempts: { key: string | undefined; body: string | null }[] = [];
      await page.route(`**${path}`, async route => { if (route.request().method() !== 'PUT') return route.continue(); attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(200); expect(manualPeriodWorkLogResponseSchema.parse(await actual.json()).data).toMatchObject({ taskId: work.id, periodId: period.id, membershipId: f.other.id, minutes: 75, revision: 1 }); if (attempts.length === 1) { firstCommitted.release(); await firstHeld.wait; await route.abort('failed'); } else { retryCommitted.release(); await retryHeld.wait; await route.fulfill({ response: actual }); } });
      try {
        await fact.getByRole('button', { name: 'Save actual hours', exact: true }).click(); await firstCommitted.wait;
        await fact.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(fact).toHaveCount(0);
        await page.getByRole('combobox', { name: 'Week for hours', exact: true }).selectOption(another.id); await page.getByRole('combobox', { name: 'Whose hours to show', exact: true }).selectOption(f.own.id);
        await page.getByRole('button', { name: 'Board', exact: true }).click(); await noBoardPickers(page);
        const recovery = page.getByRole('button', { name: 'Open original hours save', exact: true }); await expect(recovery).toHaveCount(1);
        const search = page.getByLabel('Search tasks', { exact: true }); await search.focus(); firstHeld.release();
        await expect(page.getByText(/The original week and person are preserved/)).toBeVisible(); await expect(search).toBeFocused(); await noBoardPickers(page);
        await recovery.click(); await expect(fact.getByRole('region', { name: 'Time entry context', exact: true })).toContainText(f.other.displayName); await expect(fact.getByLabel('Actual hours this week', { exact: true })).toHaveValue('1:15');
        expect(new URL(page.url()).searchParams.get('week')).toBe(period.id); expect(new URL(page.url()).searchParams.get('worker')).toBe(f.other.id);
        const done = page.waitForResponse(r => apiCall(r, 'PUT', path)); await fact.getByRole('button', { name: 'Retry original save', exact: true }).click(); await retryCommitted.wait;
        await fact.getByRole('button', { name: 'Close', exact: true }).last().click(); await expect(fact).toHaveCount(0); await search.fill(f.token); await search.focus(); retryHeld.release();
        expect((await done).status()).toBe(200); await expect(recovery).toHaveCount(0); await expect(search).toBeFocused(); await expect(search).toHaveValue(f.token); await expect(page.getByRole('button', { name: 'Board', exact: true })).toHaveAttribute('aria-current', 'page');
        expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: null, minutes: 75, state: 'active', reason: null }); await noBoardPickers(page);
        const current = manualPeriodWorkLogListResponseSchema.parse(await (await request.get(`${f.prefix}/worklogs?periodId=${period.id}`)).json()).data;
        expect(current).toHaveLength(1); expect(current[0]).toMatchObject({ periodId: period.id, membershipId: f.other.id, taskId: work.id, minutes: 75, revision: 1 });
        expect(manualPeriodWorkLogListResponseSchema.parse(await (await request.get(`${f.prefix}/worklogs?periodId=${another.id}`)).json()).data).toEqual([]);
        const weekHref = await page.getByRole('link', { name: 'Week', exact: true }).getAttribute('href'); const carried = new URL(weekHref ?? '', f.origin); expect(carried.searchParams.get('period')).toBe(period.id); expect(carried.searchParams.get('worker')).toBe(f.other.id); expect(new URL(page.url()).hash).toBe('#time-context');
        const lanes = page.getByRole('region', { name: 'Task status lanes', exact: true }); await expect(lanes.getByRole('listitem')).toHaveCount(5);
        const geometry = await lanes.evaluate(element => { const firstCard = element.querySelector('li'); element.scrollLeft = element.scrollWidth; return { firstCardY: firstCard?.getBoundingClientRect().y ?? null, client: element.clientWidth, width: element.scrollWidth, lastScroll: element.scrollLeft, global: document.documentElement.scrollWidth - innerWidth, lanes: [...element.querySelectorAll(':scope > div > section')].map(lane => ({ cards: lane.querySelectorAll('li').length, dueLabels: lane.querySelectorAll('dt.sr-only').length })) }; });
        expect(geometry.global).toBeLessThanOrEqual(0); expect(geometry.lanes).toHaveLength(4); expect(geometry.lanes.every(lane => lane.cards >= 1 && lane.dueLabels >= 1)).toBe(true); if (name === 'mobile') { expect(geometry.width).toBeGreaterThan(geometry.client); expect(geometry.lastScroll).toBeGreaterThan(0); }
        await page.screenshot({ path: info.outputPath(`board-time-${name}.png`) });
        await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await expect(page.getByRole('combobox', { name: 'Week for hours', exact: true })).toHaveValue(period.id); await expect(page.getByRole('combobox', { name: 'Whose hours to show', exact: true })).toHaveValue(f.other.id);
        await info.attach('board-hours-recovery.json', { body: JSON.stringify({ attempts, geometry, originalPeriodId: period.id, originalMembershipId: f.other.id }), contentType: 'application/json' }); expect((await f.task(work.id)).revision).toBe(work.revision);
      } finally { firstHeld.release(); retryHeld.release(); await page.unroute(`**${path}`); }
    });
  });
}
