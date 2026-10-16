// Source preparation; real API fixture creation requires the coordinator's compiled browser GO.
import { expect, test } from '@playwright/test';
import { myTasksResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture } from './support/daily-fixture.js';

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`My tasks URL lens ${name}`, () => {
    test.use({ viewport });
    test('applied self filters/search survive task Back and reload; local typing survives another filter and malformed URL stays safe without cleanup', async ({ page, request, baseURL }, info) => {
      const f = await dailyFixture(request, baseURL, 'My tasks lens');
      const assigned = await f.createTask(`${f.token} assigned`);
      const participating = await f.createTask(`${f.token} participating`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.own.id, f.other.id] });
      await f.createTask(`${f.token} closed`, { statusId: f.done.id });
      await f.createTask(`${f.token} unrelated`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.other.id] });
      const route = `/w/${f.workspace.id}/my-tasks`; const reads: URL[] = [], writes: string[] = [];
      page.on('request', r => { if (apiCallLike(r.method(), r.url(), `${f.prefix}/my-tasks`)) reads.push(new URL(r.url())); if (!['GET','HEAD','OPTIONS'].includes(r.method())) writes.push(`${r.method()} ${r.url()}`); });
      await page.goto(`${route}?relation=assigned&completion=all&includeArchived=true&search=${encodeURIComponent(f.token)}&actorId=${f.other.userId}&extra=keep#inbox`);
      const list = page.getByRole('list', { name: 'My tasks across projects', exact: true }); const search = page.getByLabel('Search my tasks', { exact: true });
      await expect(list.getByRole('link')).toHaveCount(2); await expect(list).toContainText(assigned.title); await expect(list).not.toContainText(participating.title);
      const pending = `${f.token} unsent`; const countBeforeTyping = reads.length; await search.fill(pending); await search.press('Tab');
      expect(new URL(page.url()).searchParams.get('search')).toBe(f.token); expect(reads).toHaveLength(countBeforeTyping);
      await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('open'); await expect(list.getByRole('link')).toHaveCount(1); await expect(search).toHaveValue(pending);
      expect(new URL(page.url()).searchParams.has('completion')).toBe(false); expect(new URL(page.url()).searchParams.get('search')).toBe(f.token);
      expect(reads.every(url => url.searchParams.get('search') !== pending)).toBe(true);
      await search.fill(f.token); await page.getByRole('button', { name: 'Apply search', exact: true }).click();
      await page.getByRole('combobox', { name: 'My involvement', exact: true }).selectOption('all'); await expect(page.getByRole('checkbox', { name: 'Include archived', exact: true })).toBeChecked(); await page.getByRole('checkbox', { name: 'Include archived', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Include archived', exact: true })).not.toBeChecked();
      await expect(list.getByRole('link')).toHaveCount(2); await expect.poll(() => reads.at(-1)?.searchParams.get('includeArchived')).toBe('false'); const applied = page.url();
      expect(new URL(applied).searchParams.has('relation')).toBe(false); expect(new URL(applied).searchParams.has('includeArchived')).toBe(false); expect(new URL(applied).hash).toBe('#inbox'); expect(new URL(applied).searchParams.get('extra')).toBe('keep');
      await list.getByRole('link', { name: `Open task “${participating.title}”`, exact: true }).click(); await expect(page.getByRole('dialog', { name: participating.title, exact: true })).toBeVisible();
      const beforeBack = reads.length; await page.goBack(); await expect(page).toHaveURL(applied); await expect.poll(() => reads.length).toBeGreaterThan(beforeBack);
      await expect(search).toHaveValue(f.token); await expect(list.getByRole('link')).toHaveCount(2); await page.reload(); await expect(page).toHaveURL(applied); await expect(search).toHaveValue(f.token); await expect(list.getByRole('link')).toHaveCount(2);
      await expect(page.getByRole('combobox', { name: 'My involvement', exact: true })).toHaveValue('all'); await expect(page.getByRole('combobox', { name: 'Show', exact: true })).toHaveValue('open'); await expect(page.getByRole('checkbox', { name: 'Include archived', exact: true })).not.toBeChecked();
      const malformed = `${route}?relation=assigned&relation=participating&completion=invalid&includeArchived=false&search=${f.token}&search=ambiguous&actorId=${f.other.userId}&membershipId=${f.other.id}#safe`;
      const loaded = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/my-tasks`)); await page.goto(malformed); const response = await loaded; expect(response.status()).toBe(200); myTasksResponseSchema.parse(await response.json());
      await expect(page.getByRole('heading', { name: 'My tasks', exact: true })).toBeVisible(); await expect(page).toHaveURL(new URL(malformed, baseURL).href);
      await expect(page.getByRole('combobox', { name: 'My involvement', exact: true })).toHaveValue('all'); await expect(page.getByRole('combobox', { name: 'Show', exact: true })).toHaveValue('open'); await expect(page.getByRole('checkbox', { name: 'Include archived', exact: true })).not.toBeChecked(); await expect(search).toHaveValue('');
      expect(reads.every(url => !url.searchParams.has('actorId') && !url.searchParams.has('userId') && !url.searchParams.has('membershipId'))).toBe(true);
      expect(reads.at(-1)?.searchParams.get('relation')).toBe('all'); expect(reads.at(-1)?.searchParams.get('completion')).toBe('open'); expect(reads.at(-1)?.searchParams.get('includeArchived')).toBe('false');
      expect(writes).toEqual([]); expect((await f.task(assigned.id)).revision).toBe(assigned.revision); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await info.attach('self-lens-requests.json', { body: JSON.stringify(reads.map(url => url.href)), contentType: 'application/json' }); await page.screenshot({ path: info.outputPath(`my-tasks-lens-${name}.png`) });
    });
  });
}
function apiCallLike(method: string, url: string, path: string) { return method === 'GET' && new URL(url).pathname === path; }
