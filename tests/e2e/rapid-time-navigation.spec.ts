// Original rapid sequence from docs25: no settled drawer/URL wait between Close and Week.
import { expect, test } from '@playwright/test';
import { planningPeriodResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture } from './support/daily-fixture.js';

const routesByTest = new Map<string, { at: string; url: string }[]>();
test.beforeEach(async ({ page }, info) => {
  const routes: { at: string; url: string }[] = []; routesByTest.set(info.testId, routes);
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) routes.push({ at: new Date().toISOString(), url: frame.url() }); });
});
test.afterEach(async ({ page: _page }, info) => {
  await info.attach('rapid-route-timeline.json', { body: JSON.stringify(routesByTest.get(info.testId) ?? [], null, 2), contentType: 'application/json' }); routesByTest.delete(info.testId);
});

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Rapid time navigation ${name}`, () => {
    test.use({ viewport });
    test('discard recovered inline draft, close and immediately choose a week without resurrecting the closed task', async ({ page, request, baseURL }) => {
      const f = await dailyFixture(request, baseURL, 'Rapid Close to Week');
      const task = await f.createTask(`${f.token} rapid close`);
      const period = (await f.post('/periods', { projectId: f.project.id, name: 'Rapid navigation QA', localStart: '2027-05-03', timezone: 'Asia/Nicosia', cutoffAt: '2027-06-01T00:00:00.000Z', protectEstimate: false }, planningPeriodResponseSchema)).data;
      let taskWrites = 0;
      page.on('request', r => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === `${f.prefix}/tasks/${task.id}`) taskWrites++; });
      await page.goto(f.path);
      await page.getByRole('button', { name: `Edit status for ${task.title}`, exact: true }).click();
      const inline = page.getByRole('form', { name: `Edit ${task.title} in the task table`, exact: true });
      await inline.getByLabel('Status', { exact: true }).selectOption(f.progress.id);
      await page.getByRole('button', { name: 'Columns', exact: true }).click();
      const columns = page.getByRole('dialog', { name: 'My task columns', exact: true });
      await columns.getByRole('checkbox', { name: 'Status', exact: true }).uncheck();
      const saved = page.waitForResponse(r => apiCall(r, 'PUT', `${f.prefix}/projects/${f.project.id}/table-preferences/me`));
      await columns.getByRole('button', { name: 'Save columns', exact: true }).click(); expect((await saved).status()).toBe(200);
      await expect(columns.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible();
      await columns.getByRole('button', { name: 'Close', exact: true }).last().click();
      await page.getByRole('button', { name: 'Resume original editor', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: task.title, exact: true });
      await expect(drawer.getByLabel('Status', { exact: true })).toHaveValue(f.progress.id);
      // Preserve the originally failing human actions. Assertions come AFTER the week change.
      await drawer.getByRole('button', { name: 'Discard draft', exact: true }).click();
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
      await page.getByLabel('Week for hours', { exact: true }).selectOption(period.id);
      await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(null);
      await expect(drawer).toHaveCount(0); await expect(page.getByLabel('Week for hours', { exact: true })).toHaveValue(period.id);
      // Repeat legitimate close/week changes without waiting for Close's render between actions.
      for (let index = 0; index < 4; index++) {
        await page.getByRole('button', { name: task.title, exact: true }).click();
        await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
        await page.getByLabel('Week for hours', { exact: true }).selectOption(index % 2 === 0 ? '' : period.id);
        await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(null); await expect(drawer).toHaveCount(0);
      }
      expect(taskWrites).toBe(0); expect((await f.task(task.id)).statusId).toBe(f.todo.id);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });
  });
}
