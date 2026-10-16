// Focused next-slice acceptance. All setup and writes use real local API/PostgreSQL.
// Route interception forwards the real command before withholding/losing its acknowledgement.
import { expect, test, type Page } from '@playwright/test';
import { projectResponseSchema, taskResponseSchema, taskStatusListResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { openProjectActions } from './support/disclosures.js';

function taskRow(page: Page, title: string) {
  return page.getByRole('table').getByRole('row').filter({ has: page.getByRole('button', { name: title, exact: true }) });
}
function quickForm(page: Page) { return page.getByRole('form', { name: 'Add a task to QA section', exact: true }); }
function inlineForm(page: Page, title: string) { return page.getByRole('form', { name: `Edit ${title} in the task table`, exact: true }); }
async function overflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }

for (const [viewportName, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Daily UX ${viewportName}`, () => {
    test.use({ viewport });
    test('My tasks derives the current person across two projects, filters, opens a task and refetches on return', async ({ page, request, baseURL }, info) => {
      const f = await dailyFixture(request, baseURL, 'Inbox');
      const second = (await f.post('/projects', { name: `Second inbox ${f.token}` }, projectResponseSchema)).data;
      const assigned = await f.createTask(`${f.token} assigned`);
      // Existing status belongs to the first project, so get the second project's current statuses.
      const secondStatuses = taskStatusListResponseSchema.parse(await (await request.get(`${f.prefix}/projects/${second.id}/statuses`)).json());
      const secondTodo = secondStatuses.data.find(row => row.group === 'todo'); if (!secondTodo) throw new Error('Second project status required.');
      const participating = await f.createTask(`${f.token} participating`, { projectId: second.id, sectionId: null, statusId: secondTodo.id, responsibleMembershipId: f.other.id, participantMembershipIds: [f.own.id, f.other.id] });
      await f.createTask(`${f.token} unrelated`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.other.id] });
      const closed = await f.createTask(`${f.token} closed`, { statusId: f.done.id });
      const inbox = `/w/${f.workspace.id}/my-tasks`;
      const reads: URL[] = [];
      page.on('request', r => { if (r.method() === 'GET' && new URL(r.url()).pathname === `${f.prefix}/my-tasks`) reads.push(new URL(r.url())); });
      await page.goto(inbox); await expect(page.getByRole('heading', { name: 'My tasks', exact: true })).toBeVisible();
      const search = async () => { await page.getByLabel('Search my tasks', { exact: true }).fill(f.token); await page.getByRole('button', { name: 'Apply search', exact: true }).click(); };
      await search();
      const list = page.getByRole('list', { name: 'My tasks across projects', exact: true });
      await expect(list.getByRole('link')).toHaveCount(2);
      await expect(list).toContainText(f.project.name); await expect(list).toContainText(second.name);
      await expect(list).not.toContainText(closed.title); await expect(list).not.toContainText(`${f.token} unrelated`);
      await page.getByLabel('My involvement', { exact: true }).selectOption('assigned');
      await expect(list.getByRole('link')).toHaveCount(1); await expect(list).toContainText(assigned.title);
      await page.getByLabel('My involvement', { exact: true }).selectOption('participating');
      await expect(list).toContainText(participating.title);
      await page.getByLabel('My involvement', { exact: true }).selectOption('all');
      await page.getByLabel('Show', { exact: true }).selectOption('all');
      await expect(list.getByRole('link')).toHaveCount(3);
      await page.getByLabel('Show', { exact: true }).selectOption('open');
      await list.getByRole('link', { name: `Open task “${assigned.title}”`, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${f.project.id}\\?task=${assigned.id}$`));
      const drawer = page.getByRole('dialog', { name: assigned.title, exact: true });
      await drawer.getByLabel('Status', { exact: true }).selectOption(f.done.id);
      const saved = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${assigned.id}`));
      await drawer.getByRole('button', { name: 'Save', exact: true }).click();
      expect((await taskResult(await saved, 200)).statusId).toBe(f.done.id);
      const beforeReturn = reads.length; await page.goBack();
      await expect(page.getByRole('heading', { name: 'My tasks', exact: true })).toBeVisible();
      await expect.poll(() => reads.length).toBeGreaterThan(beforeReturn);
      await search(); await expect(list.getByRole('link')).toHaveCount(1); await expect(list).toContainText(participating.title);
      expect(f.own.userId).toBe(f.live.me.actor.id);
      expect(reads.every(url => !url.searchParams.has('membershipId') && !url.searchParams.has('userId') && !url.searchParams.has('actorId'))).toBe(true);
      await overflow(page); await page.screenshot({ path: info.outputPath(`my-tasks-${viewportName}.png`) });
    });

    test('section Enter creates once without a drawer; status, assignee and due date save only explicitly; action modal leaves View reachable', async ({ page, request, baseURL }, info) => {
      const f = await dailyFixture(request, baseURL, 'Quick and inline');
      await page.goto(f.path);
      await page.getByRole('button', { name: 'Add task to QA section', exact: true }).click();
      const form = quickForm(page); const title = `${f.token} quick`;
      await form.getByLabel('Task name', { exact: true }).fill(title);
      await form.getByLabel('Assignee', { exact: true }).selectOption(f.own.id);
      await form.getByLabel('Due date', { exact: true }).fill('2027-05-04');
      const created = page.waitForResponse(r => apiCall(r, 'POST', `${f.prefix}/tasks`));
      await form.getByLabel('Task name', { exact: true }).press('Enter');
      let current = await taskResult(await created, 201);
      expect(current.sectionId).toBe(f.section.id); expect(current.title).toBe(title);
      await expect(taskRow(page, title)).toHaveCount(1); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(form.getByLabel('Task name', { exact: true })).toHaveValue('');
      await expect(form.getByLabel('Task name', { exact: true })).toBeFocused();
      await form.getByRole('button', { name: 'Collapse editor', exact: true }).click();
      const writes: string[] = [];
      page.on('request', r => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === `${f.prefix}/tasks/${current.id}`) writes.push(r.postData() ?? ''); });
      for (const [field, label, value, property] of [
        ['status', 'Status', f.progress.id, 'statusId'],
        ['assignee', 'Assignee', f.other.id, 'responsibleMembershipId'],
        ['due date', 'Due date', '2027-05-05', 'dueDate'],
      ] as const) {
        await taskRow(page, title).getByRole('button', { name: `Edit ${field} for ${title}`, exact: true }).click();
        const editor = inlineForm(page, title); const input = editor.getByLabel(label, { exact: true });
        if (field === 'due date') await input.fill(value); else await input.selectOption(value);
        await input.press('Tab');
        const old = await f.task(current.id); expect(old.revision).toBe(current.revision); expect(writes).toHaveLength(0);
        const response = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${current.id}`));
        await editor.getByRole('button', { name: 'Save', exact: true }).click();
        const next = await taskResult(await response, 200);
        expect(next[property]).toBe(value); expect(next.revision).toBe(current.revision + 1);
        expect(writes).toHaveLength(1);
        expect(Object.keys(JSON.parse(writes[0] ?? '{}') as object).sort()).toEqual(['expectedRevision', property].sort());
        expect(JSON.parse(writes[0] ?? '{}') as object).toMatchObject({ expectedRevision: current.revision, [property]: value });
        current = next; writes.length = 0; await expect(editor).toHaveCount(0);
      }
      // This deliberately does NOT call closeProjectActions: it accepts the product overlay fix.
      await openProjectActions(page); await page.getByRole('button', { name: 'Columns', exact: true }).click();
      const columns = page.getByRole('dialog'); await expect(columns).toBeVisible();
      await columns.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.locator('summary[aria-label="Project actions"]')).toBeFocused();
      const view = page.locator('summary').filter({ hasText: /^View: Daily view$/ }); await view.click();
      await expect(page.getByRole('radio', { name: 'All columns', exact: true })).toBeVisible(); await view.click();
      expect((await f.task(current.id)).revision).toBe(current.revision);
      await overflow(page); await page.screenshot({ path: info.outputPath(`daily-edit-${viewportName}.png`) });
    });

    test('pending collapse/reopen receives the original late success; a committed lost inline acknowledgement retries identical bytes and key once', async ({ page, request, baseURL }) => {
      test.setTimeout(60_000);
      const f = await dailyFixture(request, baseURL, 'Command ownership');
      const held = gate(), committed = gate(); const attempts: { key?: string | undefined; body: string | null }[] = [];
      let createdId = '';
      await page.route(`**${f.prefix}/tasks`, async route => {
        if (route.request().method() !== 'POST') return route.continue();
        attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
        const actual = await route.fetch(); const task = taskResponseSchema.parse(await actual.json()).data;
        createdId = task.id; committed.release(); await held.wait; await route.fulfill({ response: actual });
      });
      try {
        await page.goto(f.path); await page.getByRole('button', { name: 'Add task to QA section', exact: true }).click();
        const title = `${f.token} delayed`;
        await quickForm(page).getByLabel('Task name', { exact: true }).fill(title);
        await quickForm(page).getByLabel('Task name', { exact: true }).press('Enter'); await committed.wait;
        expect((await f.task(createdId)).title).toBe(title);
        await expect(taskRow(page, title)).toHaveCount(0); // no optimistic task before acknowledgement
        await quickForm(page).getByRole('button', { name: 'Collapse editor', exact: true }).click();
        await page.getByRole('button', { name: 'Add task to QA section', exact: true }).click();
        await expect(quickForm(page).getByLabel('Task name', { exact: true })).toHaveValue(title);
        await expect(quickForm(page).getByLabel('Task name', { exact: true })).toBeDisabled();
        held.release(); await expect(taskRow(page, title)).toHaveCount(1);
        await expect(quickForm(page).getByLabel('Task name', { exact: true })).toHaveValue('');
        expect(attempts).toHaveLength(1); await quickForm(page).getByRole('button', { name: 'Collapse editor', exact: true }).click();
        await page.unroute(`**${f.prefix}/tasks`);
        const current = await f.task(createdId); const saved = gate(), reply = gate();
        await page.route(`**${f.prefix}/tasks/${createdId}`, async route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
          const actual = await route.fetch(); saved.release(); await reply.wait; await route.fulfill({ response: actual });
        });
        try {
          await taskRow(page, title).getByRole('button', { name: `Edit status for ${title}`, exact: true }).click();
          await inlineForm(page, title).getByLabel('Status', { exact: true }).selectOption(f.progress.id);
          await inlineForm(page, title).getByRole('button', { name: 'Save', exact: true }).click(); await saved.wait;
          await inlineForm(page, title).getByRole('button', { name: 'Collapse editor', exact: true }).click();
          await taskRow(page, title).getByRole('button', { name: `Edit status for ${title}`, exact: true }).click();
          await expect(inlineForm(page, title).getByLabel('Status', { exact: true })).toBeDisabled();
          reply.release(); await expect(inlineForm(page, title).getByLabel('Status', { exact: true })).toBeEnabled();
          await expect(inlineForm(page, title).getByLabel('Status', { exact: true })).toHaveValue(f.progress.id);
          await inlineForm(page, title).getByRole('button', { name: 'Save', exact: true }).click();
          await expect(inlineForm(page, title)).toHaveCount(0); expect(attempts).toHaveLength(2);
          expect((await f.task(createdId)).revision).toBe(current.revision + 1);
        } finally { reply.release(); await page.unroute(`**${f.prefix}/tasks/${createdId}`); }
        const retried: { key?: string | undefined; body: string | null }[] = [];
        const before = await f.task(createdId);
        await page.route(`**${f.prefix}/tasks/${createdId}`, async route => {
          if (route.request().method() !== 'PATCH') return route.continue();
          retried.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
          const actual = await route.fetch(); expect(actual.status()).toBe(200);
          if (retried.length === 1) await route.abort('failed'); else await route.fulfill({ response: actual });
        });
        await taskRow(page, title).getByRole('button', { name: `Edit due date for ${title}`, exact: true }).click();
        await inlineForm(page, title).getByLabel('Due date', { exact: true }).fill('2027-05-06');
        await inlineForm(page, title).getByRole('button', { name: 'Save', exact: true }).click();
        await expect(inlineForm(page, title).getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
        expect((await f.task(createdId)).dueDate).toBe('2027-05-06');
        await inlineForm(page, title).getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(inlineForm(page, title)).toHaveCount(0);
        expect(retried).toHaveLength(2); expect(retried[1]).toEqual(retried[0]); expect(retried[0]?.key).toBeTruthy();
        expect((await f.task(createdId)).revision).toBe(before.revision + 1);
      } finally { held.release(); }
    });
  });
}
