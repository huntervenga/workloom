// Real local API/DB comments; dropped responses occur only after a real backend commit.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { meResponseSchema, taskActivityResponseSchema, taskCommentResponseSchema, taskCommentsResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate } from './support/daily-fixture.js';

async function discussion(page: Page, title: string): Promise<Locator> {
  const drawer = page.getByRole('dialog', { name: title, exact: true });
  await drawer.getByRole('tab', { name: /^Discussion/ }).click();
  await expect(drawer.getByRole('region', { name: 'Discussion', exact: true })).toBeVisible();
  return drawer;
}
async function comments(f: Awaited<ReturnType<typeof dailyFixture>>, taskId: string) {
  const r = await f.request.get(`${f.prefix}/tasks/${taskId}/comments?limit=50`); expect(r.status()).toBe(200);
  return taskCommentsResponseSchema.parse(await r.json()).data;
}
for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Comments ${name}`, () => {
    test.use({ viewport });
    test('details draft survives sibling tabs; Ctrl+Enter posts exact literal text once, plain Enter does not post, reload persists and activity is lazy', async ({ page, request, baseURL }, info) => {
      const f = await dailyFixture(request, baseURL, 'Comments literal');
      const task = await f.createTask(`${f.token} details`);
      const writes: string[] = [], activityReads: string[] = [];
      page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/comments')) writes.push(r.postData() ?? ''); if (new URL(r.url()).pathname.endsWith('/activity')) activityReads.push(r.url()); });
      await page.goto(`${f.path}?task=${task.id}`);
      const drawer = page.getByRole('dialog', { name: task.title, exact: true });
      await drawer.getByLabel('Task name', { exact: true }).fill(`${task.title} unsaved`);
      await drawer.getByLabel('Description', { exact: true }).fill('Retained details draft');
      await discussion(page, task.title);
      expect(activityReads).toEqual([]);
      await drawer.getByRole('button', { name: 'Add comment', exact: true }).click();
      await expect(drawer.getByRole('alert')).toContainText('Write a comment before posting.'); expect(writes).toEqual([]);
      const bodyInput = drawer.getByLabel('Comment', { exact: true });
      await bodyInput.fill('first line'); await bodyInput.press('End'); await bodyInput.press('Enter'); await bodyInput.pressSequentially('second line');
      await expect(bodyInput).toHaveValue('first line\nsecond line'); expect(writes).toEqual([]);
      const body = `  ${f.token} <b>literal</b> <script>window.unwantedCommentScript=1</script>\n**not bold** [link](https://example.test/comment)  `;
      await bodyInput.fill(body);
      await drawer.getByRole('tab', { name: 'Details', exact: true }).click();
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(`${task.title} unsaved`);
      await expect(drawer.getByLabel('Description', { exact: true })).toHaveValue('Retained details draft');
      await discussion(page, task.title); await expect(bodyInput).toHaveValue(body);
      const posted = page.waitForResponse(r => apiCall(r, 'POST', `${f.prefix}/tasks/${task.id}/comments`));
      await bodyInput.press('Control+Enter'); const response = await posted; expect(response.status(), await response.text()).toBe(201);
      const comment = taskCommentResponseSchema.parse(await response.json()).data;
      expect(comment.body).toBe(body); expect(comment.authorMembershipId).toBe(f.own.id); expect(comment.authorUserId).toBe(f.live.me.actor.id);
      await expect(bodyInput).toHaveValue(''); expect(writes).toHaveLength(1); expect(JSON.parse(writes[0] ?? '{}')).toEqual({ body });
      const literal = drawer.getByRole('region', { name: 'Discussion', exact: true }).getByText(body, { exact: true });
      await expect(literal).toBeVisible(); expect(await literal.textContent()).toBe(body); await expect(literal.locator('b,script,a')).toHaveCount(0);
      expect(await page.evaluate(() => Object.hasOwn(window, 'unwantedCommentScript'))).toBe(false);
      expect((await f.task(task.id)).revision).toBe(task.revision);
      expect(activityReads).toEqual([]);
      const activity = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/tasks/${task.id}/activity`));
      await drawer.locator('summary').filter({ hasText: /^Activity$/ }).click();
      const events = taskActivityResponseSchema.parse(await (await activity).json()).data;
      expect(events.some(event => event.kind === 'created')).toBe(true); expect(JSON.stringify(events)).not.toContain(body);
      await page.screenshot({ path: info.outputPath(`comments-literal-${name}.png`) });
      page.once('dialog', d => d.accept()); await page.reload(); await discussion(page, task.title);
      await expect(page.getByRole('dialog').getByText(body, { exact: true })).toBeVisible();
      const rows = await comments(f, task.id); expect(rows).toHaveLength(1); expect(rows[0]).toEqual(comment);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    });

    test('pending close/reopen confirms once; real committed lost acknowledgement retries identical comment body/key and leaves one row', async ({ page, request, baseURL }) => {
      test.setTimeout(60_000);
      const f = await dailyFixture(request, baseURL, 'Comments recovery'); const task = await f.createTask(`${f.token} recovery`);
      const routePath = `**${f.prefix}/tasks/${task.id}/comments`, held = gate(), committed = gate();
      let count = 0;
      await page.route(routePath, async route => { if (route.request().method() !== 'POST') return route.continue(); count++; const actual = await route.fetch(); expect(actual.status()).toBe(201); committed.release(); await held.wait; await route.fulfill({ response: actual }); });
      try {
        await page.goto(`${f.path}?task=${task.id}`); let drawer = await discussion(page, task.title);
        await drawer.getByLabel('Comment', { exact: true }).fill('Pending exact comment'); await drawer.getByRole('button', { name: 'Add comment', exact: true }).click(); await committed.wait;
        expect(await comments(f, task.id)).toHaveLength(1);
        await drawer.locator('button[aria-label="Close"]').first().click();
        await page.getByRole('button', { name: task.title, exact: true }).click(); drawer = await discussion(page, task.title);
        await expect(drawer.getByLabel('Comment', { exact: true })).toHaveValue('Pending exact comment'); await expect(drawer.getByLabel('Comment', { exact: true })).toBeDisabled();
        held.release(); await expect(drawer.getByLabel('Comment', { exact: true })).toHaveValue(''); await expect(drawer.getByLabel('Comment', { exact: true })).toBeEnabled(); expect(count).toBe(1);
        await page.unroute(routePath);
        const attempts: { key: string | undefined; body: string | null }[] = [];
        await page.route(routePath, async route => { if (route.request().method() !== 'POST') return route.continue(); attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() }); const actual = await route.fetch(); expect(actual.status()).toBe(201); if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response: actual }); });
        const body = '  Lost acknowledgement\nexact original body  ';
        await drawer.getByLabel('Comment', { exact: true }).fill(body); await drawer.getByRole('button', { name: 'Add comment', exact: true }).click();
        await expect(drawer.getByRole('button', { name: 'Retry original comment', exact: true })).toBeVisible(); await expect(drawer.getByLabel('Comment', { exact: true })).toBeDisabled();
        const committedRows = await comments(f, task.id); expect(committedRows.filter(row => row.body === body)).toHaveLength(1);
        await drawer.getByRole('button', { name: 'Retry original comment', exact: true }).click(); await expect(drawer.getByLabel('Comment', { exact: true })).toHaveValue('');
        expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy();
        const final = await comments(f, task.id); expect(final).toHaveLength(2); expect(final.filter(row => row.body === body)).toHaveLength(1);
        expect((await f.task(task.id)).revision).toBe(task.revision);
      } finally { held.release(); }
    });

    test('API-created allowlisted viewer session reads real feed without composer; injected current403 hides previously loaded feed (UI simulation)', async ({ browser, request, baseURL }, info) => {
      const f = await dailyFixture(request, baseURL, 'Comments viewer'); const task = await f.createTask(`${f.token} viewer`);
      const body = `Visible prior feed ${f.token}`; await f.post(`/tasks/${task.id}/comments`, { body }, taskCommentResponseSchema);
      const viewer = f.members.find(member => member.role === 'viewer'); if (!viewer) throw new Error('Existing allowlisted viewer required.');
      const context = await browser.newContext({ baseURL, viewport });
      try {
        const session = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: viewer.userId } });
        expect(session.status()).toBe(200); expect(meResponseSchema.parse(await session.json()).data.actor.id).toBe(viewer.userId);
        const denied = await context.request.post(`${f.prefix}/tasks/${task.id}/comments`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { body: 'Viewer cannot create this' } }); expect(denied.status()).toBe(403);
        const page = await context.newPage(); const writes: string[] = []; page.on('request', r => { if (!['GET','HEAD','OPTIONS'].includes(r.method())) writes.push(r.url()); });
        await page.goto(`${f.path}?task=${task.id}`); const drawer = await discussion(page, task.title);
        await expect(drawer.getByText(body, { exact: true })).toBeVisible(); await expect(drawer.getByLabel('Comment', { exact: true })).toHaveCount(0);
        await expect(drawer).toContainText('You can read this discussion. Commenting is unavailable with your current access.');
        await page.route(`**${f.prefix}/tasks/${task.id}/comments?**`, route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Not available' }, meta: { requestId: 'qa-current-denial' } }) }));
        const denialResponse = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/tasks/${task.id}/comments`) && r.status() === 403);
        await drawer.getByRole('button', { name: 'Refresh discussion', exact: true }).click(); await denialResponse;
        await expect(drawer.getByText(body, { exact: true })).toHaveCount(0); await expect(drawer.getByLabel('Comment', { exact: true })).toHaveCount(0);
        expect(writes).toEqual([]); expect(await comments(f, task.id)).toHaveLength(1);
        await page.screenshot({ path: info.outputPath(`comments-viewer-denial-${name}.png`) });
      } finally { await context.close(); }
    });
  });
}
