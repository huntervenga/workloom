// Real filtered server pages and domain commands. Both sizes share one read-only pagination fixture.
// Execute in isolation through tests/e2e/board-tag-filter.config.ts.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { errorResponseSchema, meResponseSchema, projectDependencyPolicyResponseSchema, taskDependencyResponseSchema, taskListResponseSchema, type TaskDto, type TaskStatusDto } from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { boardPaginationFixture } from './support/board-pagination.js';
import { revealTaskFilters } from './support/disclosures.js';

const PARTIAL = 'More matching tasks may be available. Counts cover only the loaded tasks in this view.';
const lanes = (page: Page) => page.getByRole('region', { name: 'Task status lanes', exact: true });
const views = (page: Page) => page.getByRole('navigation', { name: 'Project views', exact: true });
const tableRows = (page: Page) => page.getByRole('table').locator('[data-task-row]');
function card(page: Page, title: string): Locator { return lanes(page).getByRole('listitem').filter({ has: page.getByRole('button', { name: title, exact: true }) }); }
const editor = (page: Page, task: TaskDto) => page.getByRole('form', { name: `Edit ${task.title} in the task table`, exact: true });
const statusTrigger = (form: Locator) => form.getByRole('combobox', { name: 'Status', exact: true });
async function editStatus(page: Page, task: TaskDto) { if (!await editor(page, task).count()) await card(page, task.title).getByRole('button', { name: 'Change status', exact: true }).click(); return editor(page, task); }
async function overflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }
async function collapseFilters(page: Page) { const summary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ }); if (await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.click(); }
/** Real click on a select-only combobox, then the exact option; its listbox is portalled to the body. */
async function choose(page: Page, scope: Locator | Page, label: string, option: string) {
  const trigger = scope.getByRole('combobox', { name: label, exact: true }), list = page.getByRole('listbox', { name: label, exact: true });
  await expect(trigger).toBeEnabled(); if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(list).toBeVisible(); await list.getByRole('option', { name: option, exact: true }).click(); await expect(list).toHaveCount(0);
}
/** The selected option's accessible name (avatar initials are aria-hidden); closes without choosing. */
async function expectChosen(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click(); const list = page.getByRole('listbox', { name: label, exact: true }); await expect(list).toBeVisible();
  await expect(list.getByRole('option', { selected: true })).toHaveAccessibleName(option); await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
}
/** The inline status editor opens its menu on mount; choosing commits the PATCH at once (no Save). */
async function chooseStatus(page: Page, form: Locator, status: TaskStatusDto) { await expect(statusTrigger(form)).toBeVisible(); await choose(page, form, 'Status', status.name); }
/** Exactly these distinct titles, each on exactly one item, and nothing else. */
async function expectExactTitles(items: Locator, named: (title: string) => Locator, titles: readonly string[]) {
  expect(new Set(titles).size).toBe(titles.length); await expect(items).toHaveCount(titles.length);
  for (const title of titles) await expect(named(title)).toHaveCount(1);
}
const param = (page: Page, key: string) => new URL(page.url()).searchParams.getAll(key);

for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Board and task tag ${name}`, () => {
    test.use({ viewport });
    test('real default100 pagination has honest loaded counts and no cap; tag/status/participant/search match the same table and board tasks', async ({ page, request, baseURL }, info) => {
      test.setTimeout(90_000); const f = await boardPaginationFixture(request, baseURL);
      const prefix = `/api/v1/workspaces/${f.workspaceId}`, path = `/w/${f.workspaceId}/projects/${f.project.id}`;
      const writes: string[] = [], reads: URL[] = [];
      page.on('request', r => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method())) writes.push(r.url()); if (r.method() === 'GET' && new URL(r.url()).pathname === `${prefix}/tasks`) reads.push(new URL(r.url())); });
      const first = page.waitForResponse(r => apiCall(r, 'GET', `${prefix}/tasks`) && new URL(r.url()).searchParams.get('projectId') === f.project.id && !new URL(r.url()).searchParams.has('cursor'));
      await page.goto(`${path}?view=board`); const initial = taskListResponseSchema.parse(await (await first).json()); expect(initial.data).toHaveLength(100); expect(initial.meta.nextCursor).toBeTruthy();
      await expect(lanes(page).getByRole('listitem')).toHaveCount(100); await expect(page.getByText('100 loaded tasks in this view.', { exact: true })).toBeVisible(); await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible();
      const next = page.waitForResponse(r => apiCall(r, 'GET', `${prefix}/tasks`) && new URL(r.url()).searchParams.get('cursor') === initial.meta.nextCursor);
      await page.getByRole('button', { name: 'Load more tasks', exact: true }).click(); const last = taskListResponseSchema.parse(await (await next).json()); expect(last.data).toHaveLength(1); expect(last.meta.nextCursor).toBe(null);
      // Unfiltered and fully loaded: the board may and does drop the partial notice.
      await expect(lanes(page).getByRole('listitem')).toHaveCount(101); await expect(page.getByText('101 loaded tasks in this view.', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Load more tasks', exact: true })).toHaveCount(0); await expect(page.getByText(PARTIAL, { exact: true })).toHaveCount(0);
      await expectExactTitles(lanes(page).getByRole('listitem'), title => card(page, title), f.allTitles);
      await revealTaskFilters(page); await choose(page, page, 'Task tag', f.tag.name); await choose(page, page, 'Task status', f.todo.name); await choose(page, page, 'Task participant', f.own.displayName); await collapseFilters(page);
      await expect.poll(() => [param(page, 'tag'), param(page, 'status'), param(page, 'participant')]).toEqual([[f.tag.id], [f.todo.id], [f.own.id]]);
      const filteredRead = page.waitForResponse(r => { if (!apiCall(r, 'GET', `${prefix}/tasks`)) return false; const q = new URL(r.url()).searchParams; return q.get('projectId') === f.project.id && q.get('tagId') === f.tag.id && q.get('statusId') === f.todo.id && q.get('participantMembershipId') === f.own.id && q.get('search') === f.token && !q.has('cursor'); });
      await page.getByLabel('Search tasks', { exact: true }).fill(f.token);
      const filteredPage = taskListResponseSchema.parse(await (await filteredRead).json()); expect(filteredPage.meta.nextCursor).toBe(null); expect(filteredPage.data.map(task => task.title).sort()).toEqual([...f.titles].sort());
      // Every filtered page is loaded, yet a filtered board never claims to be the whole project.
      await expectExactTitles(lanes(page).getByRole('listitem'), title => card(page, title), f.titles); await expect(page.getByText('97 loaded tasks in this view.', { exact: true })).toBeVisible(); await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Load more tasks', exact: true })).toHaveCount(0);
      await views(page).getByRole('button', { name: 'Tasks', exact: true }).click(); await expectExactTitles(tableRows(page), title => tableRows(page).getByRole('button', { name: title, exact: true }), f.titles);
      await revealTaskFilters(page); await expectChosen(page, 'Task tag', f.tag.name); await expectChosen(page, 'Task status', f.todo.name); await expectChosen(page, 'Task participant', f.own.displayName); await collapseFilters(page);
      expect([param(page, 'tag'), param(page, 'status'), param(page, 'participant')]).toEqual([[f.tag.id], [f.todo.id], [f.own.id]]); await expect(page.getByLabel('Search tasks', { exact: true })).toHaveValue(f.token);
      await views(page).getByRole('button', { name: 'Board', exact: true }).click(); await expectExactTitles(lanes(page).getByRole('listitem'), title => card(page, title), f.titles); await expect(page.getByText(PARTIAL, { exact: true })).toBeVisible();
      expect(reads.every(url => url.searchParams.get('limit') === '100')).toBe(true); expect(reads.some(url => url.searchParams.get('tagId') === f.tag.id && url.searchParams.get('statusId') === f.todo.id && url.searchParams.get('participantMembershipId') === f.own.id && url.searchParams.get('search') === f.token)).toBe(true); expect(writes).toEqual([]);
      await overflow(page); await page.screenshot({ path: info.outputPath(`board-filtered-${name}.png`) });
    });

    test('board status uses current revisions/dependency policy and exact unknown retry across hidden filters/views; late ACK preserves focus and viewer is read-only', async ({ page, browser, request, baseURL }, info) => {
      test.setTimeout(75_000); const f = await dailyFixture(request, baseURL, 'Board command recovery');
      const predecessor = await f.createTask(`${f.token} predecessor`), blocked = await f.createTask(`${f.token} blocked`), movable = await f.createTask(`${f.token} movable`), late = await f.createTask(`${f.token} late`);
      await f.post('/dependencies', { predecessorTaskId: predecessor.id, successorTaskId: blocked.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema);
      const policyResponse = await request.get(`${f.prefix}/projects/${f.project.id}/dependency-policy`); expect(policyResponse.status()).toBe(200); const policy = projectDependencyPolicyResponseSchema.parse(await policyResponse.json()).data;
      const enforced = await request.patch(`${f.prefix}/projects/${f.project.id}/dependency-policy`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: policy.revision, mode: 'enforce' } }); expect(enforced.status()).toBe(200);
      await page.goto(`${f.path}?view=board`); let form = await editStatus(page, blocked);
      const denied = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${blocked.id}`)); await chooseStatus(page, form, f.progress); const refusal = await denied; expect(refusal.status()).toBe(422); expect(errorResponseSchema.parse(await refusal.json()).error).toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED', details: { fields: ['statusId'] } });
      expect(await f.task(blocked.id)).toEqual(blocked); await expect(card(page, blocked.title).locator('xpath=ancestor::section[1]').getByRole('heading', { name: f.todo.name, exact: true })).toBeVisible(); await form.getByRole('button', { name: 'Collapse editor', exact: true }).click(); await expect(form).toHaveCount(0);
      const attempts: { body: string | null; key: string | undefined }[] = [], routePath = `**${f.prefix}/tasks/${movable.id}`;
      await page.route(routePath, async route => { if (route.request().method() !== 'PATCH') return route.continue(); attempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] }); const response = await route.fetch(); expect(response.status()).toBe(200); if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response }); });
      form = await editStatus(page, movable); await chooseStatus(page, form, f.progress); await expect(form.getByRole('button', { name: 'Retry', exact: true })).toBeVisible(); expect(attempts).toHaveLength(1); expect((await f.task(movable.id)).revision).toBe(movable.revision + 1);
      // Deliberately collapse: the unknown attempt stays owned (reopened below), and the open status popover no longer covers Filters.
      await form.getByRole('button', { name: 'Collapse editor', exact: true }).click(); await expect(form).toHaveCount(0);
      await views(page).getByRole('button', { name: 'Tasks', exact: true }).click(); await revealTaskFilters(page); await choose(page, page, 'Task status', f.todo.name); await collapseFilters(page); await expect.poll(() => param(page, 'status')).toEqual([f.todo.id]); await expect(page.getByRole('button', { name: movable.title, exact: true })).toHaveCount(0);
      await views(page).getByRole('button', { name: 'Board', exact: true }).click(); await expect(card(page, movable.title)).toHaveCount(0); await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(card(page, movable.title)).toBeVisible(); form = await editStatus(page, movable);
      // Unknown outcome: the held choice stays shown on a disabled trigger until the exact original is retried.
      await expect(statusTrigger(form)).toBeDisabled(); await expect(statusTrigger(form)).toHaveText(f.progress.name);
      await form.getByRole('button', { name: 'Retry', exact: true }).click(); await expect(form).toHaveCount(0); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: movable.revision, statusId: f.progress.id }); expect((await f.task(movable.id)).revision).toBe(movable.revision + 1);
      await page.unroute(routePath); const held = gate(), committed = gate(); let heldWrites = 0;
      await page.route(`**${f.prefix}/tasks/${late.id}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); heldWrites++; const actual = await route.fetch(); expect(actual.status()).toBe(200); committed.release(); await held.wait; await route.fulfill({ response: actual }); });
      try { form = await editStatus(page, late); const done = page.waitForResponse(r => apiCall(r, 'PATCH', `${f.prefix}/tasks/${late.id}`)); await chooseStatus(page, form, f.progress); await committed.wait;
        await expect(card(page, late.title).locator('xpath=ancestor::section[1]').getByRole('heading', { name: f.todo.name, exact: true })).toBeVisible();
        await views(page).getByRole('button', { name: 'Tasks', exact: true }).click(); const search = page.getByLabel('Search tasks', { exact: true }); await search.fill(blocked.title); await expect(page.getByRole('button', { name: late.title, exact: true })).toHaveCount(0); await search.focus(); held.release(); expect((await taskResult(await done, 200)).statusId).toBe(f.progress.id); await expect(search).toBeFocused(); await expect(search).toHaveValue(blocked.title); await expect(views(page).getByRole('button', { name: 'Tasks', exact: true })).toHaveAttribute('aria-current', 'page'); expect(heldWrites).toBe(1); expect((await f.task(late.id)).revision).toBe(late.revision + 1);
      } finally { held.release(); }
      const viewer = f.members.find(member => member.role === 'viewer'); if (!viewer) throw new Error('Existing allowlisted viewer required.'); const context = await browser.newContext({ baseURL, viewport });
      try { const session = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: viewer.userId } }); expect(session.status()).toBe(200); expect(meResponseSchema.parse(await session.json()).data.actor.id).toBe(viewer.userId); const view = await context.newPage(); const viewerWrites: string[] = []; view.on('request', r => { if (!['GET','HEAD','OPTIONS'].includes(r.method())) viewerWrites.push(r.url()); }); await view.goto(`${f.path}?view=board`); await expect(lanes(view).getByRole('listitem')).toHaveCount(4); await expect(lanes(view).getByRole('button', { name: 'Change status', exact: true })).toHaveCount(0); await overflow(view); expect(viewerWrites).toEqual([]); await view.screenshot({ path: info.outputPath(`board-viewer-${name}.png`) }); } finally { await context.close(); }
      await overflow(page);
    });
  });
}
