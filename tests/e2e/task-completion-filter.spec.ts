// SOURCE-ONLY native acceptance for the task completion filter; execute only through
// tests/e2e/task-completion-filter.config.ts in the coordinator's authorized private QA window.
// Fixtures are new, uniquely named projects in the historical synthetic QA workspace, written only
// through supported APIs (dailyFixture). No showcase, membership, seed or direct database change.
//
// Intended contract at 1440 and 390:
// 1. A prominent "Task completion" picker (All tasks / Incomplete tasks) is keyboard-operable; Incomplete
//    writes only completion=open, All omits it; view/sort/week/worker/task/unrelated params and the hash
//    survive; Back/Forward/reload restore it; the first read after a filtered load is already filtered.
//    Table, Board and Timeline show exactly the server's completion=open task IDs (todo/in_progress groups);
//    budget and Board counts say partial whenever filtered; Graph roots stay as selected. No writes.
// 2. A confirmed completion keeps the old list row (original status) until the server's filtered refetch,
//    then removes it; a retained drawer
//    can complete and reopen a task while its row leaves and returns; an exact draft on a filtered-out
//    task survives filter switches. Only the three intended PATCHes are sent.
// Picker labels follow the feature contract; if the frontend catalog differs, change only these constants.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { taskListResponseSchema, type TaskDto, type TaskStatusGroup } from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { futurePeriod, type Daily } from './support/next-ux.js';

const COMPLETION = 'Task completion', ALL = 'All tasks', OPEN = 'Incomplete tasks';
const PARTIAL_BOARD = 'More matching tasks may be available. Counts cover only the loaded tasks in this view.';
const PARTIAL_BUDGET = 'Budget covers loaded tasks only.';
const OPEN_GROUPS: readonly TaskStatusGroup[] = ['todo', 'in_progress'];
const sizes = [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const;

const picker = (page: Page) => page.getByRole('combobox', { name: COMPLETION, exact: true });
const row = (page: Page, task: TaskDto) => page.locator(`[data-task-row="${task.id}"]`);
const completion = (page: Page, task: TaskDto) => page.locator(`button[data-task-completion="${task.id}"]`);
const lanes = (page: Page) => page.getByRole('region', { name: 'Task status lanes', exact: true });
const views = (page: Page) => page.getByRole('navigation', { name: 'Project views', exact: true });
const sorted = (ids: readonly string[]) => [...ids].sort();
const idsOf = (tasks: readonly TaskDto[]) => sorted(tasks.map(task => task.id));
async function overflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); }
/** Every page parameter; a repeated key stays visible as `a|b`. */
function params(page: Page) {
  const search = new URL(page.url()).searchParams;
  return Object.fromEntries([...new Set(search.keys())].map(key => [key, search.getAll(key).join('|')]));
}
const hash = (page: Page) => new URL(page.url()).hash;

/** Real keyboard choice on the select-only combobox: open, move, commit; focus returns to the trigger. */
async function chooseByKeyboard(page: Page, option: typeof ALL | typeof OPEN) {
  const trigger = picker(page);
  await trigger.focus(); await trigger.press('ArrowDown');
  const list = page.getByRole('listbox', { name: COMPLETION, exact: true });
  await expect(list).toBeVisible(); await expect(list.getByRole('option')).toHaveText([ALL, OPEN]);
  await trigger.press(option === OPEN ? 'End' : 'Home'); await trigger.press('Enter');
  await expect(list).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(trigger).toContainText(option);
}
/** A picker inside a modal drawer portals its listbox into that same dialog. */
async function choose(scope: Locator, label: string, option: string) {
  const trigger = scope.getByRole('combobox', { name: label, exact: true }); await trigger.click();
  const list = scope.getByRole('listbox', { name: label, exact: true }); await expect(list).toBeVisible();
  await list.getByRole('option', { name: option, exact: true }).click(); await expect(list).toHaveCount(0);
}
async function openTaskDrawer(page: Page, task: TaskDto) {
  await row(page, task).hover(); await page.getByRole('button', { name: `Open task “${task.title}”`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true }); await expect(drawer).toBeVisible(); return drawer;
}
/** Read-only DOM IDs of what each view actually rendered. */
const tableIds = (page: Page) => page.locator('[data-task-row]').evaluateAll(rows => rows.map(r => r.getAttribute('data-task-row') ?? '').sort());
const boardTitles = (page: Page) => lanes(page).getByRole('listitem').evaluateAll(cards => cards.map(card => card.querySelector('button[id$="-title"]')?.textContent ?? '').sort());
const timelineTitles = (page: Page) => page.getByRole('region', { name: 'Project timeline', exact: true }).locator('[role="group"][aria-label^="Calendar dates: "]').evaluateAll(rows => rows.map(r => (r.getAttribute('aria-label') ?? '').slice('Calendar dates: '.length)).sort());

/** The server's own answer for the same project, so UI IDs are compared with actual filtered tasks. */
async function serverTasks(f: Daily, extra: Record<string, string> = {}) {
  const response = await f.request.get(`${f.prefix}/tasks`, { params: { projectId: f.project.id, limit: 200, ...extra } });
  expect(response.status(), await response.text()).toBe(200);
  return taskListResponseSchema.parse(await response.json()).data;
}
function observe(page: Page, f: Daily) {
  const writes: { method: string; path: string; body: string | null }[] = [], reads: URL[] = [], errors: string[] = [];
  page.on('request', q => {
    const url = new URL(q.url());
    if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: url.pathname, body: q.postData() });
    else if (q.method() === 'GET' && url.pathname === `${f.prefix}/tasks` && url.searchParams.get('projectId') === f.project.id) reads.push(url);
  });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, reads, errors, lastCompletion: () => reads.at(-1)?.searchParams.getAll('completion') ?? null };
}

for (const [name, viewport] of sizes) test.describe(`Task completion filter ${name}`, () => {
  test.use({ viewport });

  test('keyboard picker, URL carry, Back/Forward/reload and Table/Board/Timeline show exactly the server open tasks; partial counts while filtered; Graph roots retained; no writes', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Completion filter QA');
    const cancelled = f.statuses.find(status => status.group === 'cancelled'); if (!cancelled) throw new Error('Expected the default cancelled status group.');
    const openTodo = await f.createTask(`${f.token} open todo`, { startDate: '2027-05-03', dueDate: '2027-05-04', estimateMinutes: 120 });
    const closedDone = await f.createTask(`${f.token} closed done`, { statusId: f.done.id, dueDate: '2027-05-05', estimateMinutes: 60 });
    const openProgress = await f.createTask(`${f.token} open progress`, { statusId: f.progress.id, dueDate: '2027-05-06' });
    const closedCancelled = await f.createTask(`${f.token} closed cancelled`, { statusId: cancelled.id, dueDate: '2027-05-07' });
    const openUndated = await f.createTask(`${f.token} open undated`);
    const all = [openTodo, closedDone, openProgress, closedCancelled, openUndated], open = [openTodo, openProgress, openUndated];
    const title = new Map(all.map(task => [task.title, task.id]));
    const toIds = (titles: readonly string[]) => sorted(titles.map(text => title.get(text) ?? `unexpected:${text}`));
    const period = await futurePeriod(f);
    // The server, not the client, decides which status groups are open.
    const groupOf = new Map(f.statuses.map(status => [status.id, status.group]));
    const serverOpen = await serverTasks(f, { completion: 'open' });
    expect(idsOf(serverOpen)).toEqual(idsOf(open));
    expect(serverOpen.every(task => OPEN_GROUPS.includes(groupOf.get(task.statusId) as TaskStatusGroup))).toBe(true);
    expect(idsOf(await serverTasks(f))).toEqual(idsOf(all));
    const before = await Promise.all(all.map(task => f.task(task.id)));
    const net = observe(page, f);
    const base = { sort: 'due_asc', week: period.id, worker: f.other.id, extra: 'keep' };
    const filtered = { ...base, completion: 'open' };

    await page.goto(`${f.path}?sort=due_asc&week=${period.id}&worker=${f.other.id}&extra=keep#completion-filter`);
    // Prominent: visible without opening the Filters disclosure.
    await expect(picker(page)).toBeVisible(); await expect(picker(page)).toContainText(ALL);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(all));
    expect(net.reads.length).toBeGreaterThan(0); expect(net.reads.every(url => !url.searchParams.has('completion'))).toBe(true);
    await expect(page.getByText(PARTIAL_BUDGET)).toHaveCount(0);
    expect(params(page)).toEqual(base); expect(hash(page)).toBe('#completion-filter');

    await chooseByKeyboard(page, OPEN);
    await expect.poll(() => params(page)).toEqual(filtered); expect(hash(page)).toBe('#completion-filter');
    await expect.poll(net.lastCompletion).toEqual(['open']);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(serverOpen));
    for (const task of [closedDone, closedCancelled]) await expect(row(page, task)).toHaveCount(0);
    await expect(page.getByText(PARTIAL_BUDGET)).toBeVisible();
    await overflow(page);

    await page.goBack();
    await expect.poll(() => params(page)).toEqual(base); await expect(picker(page)).toContainText(ALL);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(all));
    await page.goForward();
    await expect.poll(() => params(page)).toEqual(filtered); await expect(picker(page)).toContainText(OPEN);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(serverOpen));

    const readsBeforeReload = net.reads.length;
    await page.reload(); await expect(picker(page)).toContainText(OPEN);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(serverOpen));
    // No unfiltered flash: every read of the reloaded document is already filtered.
    expect(net.reads.slice(readsBeforeReload).length).toBeGreaterThan(0);
    expect(net.reads.slice(readsBeforeReload).every(url => url.searchParams.getAll('completion').join('|') === 'open')).toBe(true);
    expect(params(page)).toEqual(filtered); expect(hash(page)).toBe('#completion-filter');

    // The drawer adds and removes only task=; the filter stays.
    const drawer = await openTaskDrawer(page, openTodo);
    await expect.poll(() => params(page)).toEqual({ ...filtered, task: openTodo.id });
    await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
    await expect.poll(() => params(page)).toEqual(filtered);

    await views(page).getByRole('button', { name: 'Board', exact: true }).click();
    await expect.poll(() => params(page)).toEqual({ ...filtered, view: 'board' });
    await expect.poll(async () => toIds(await boardTitles(page))).toEqual(idsOf(serverOpen));
    // All matching tasks are loaded, yet filtered counts never claim to be project totals.
    await expect(page.getByText(PARTIAL_BOARD, { exact: true })).toBeVisible();
    expect(net.lastCompletion()).toEqual(['open']); await overflow(page);
    await page.screenshot({ path: info.outputPath(`completion-board-${name}.png`) });

    await views(page).getByRole('button', { name: 'Timeline', exact: true }).click();
    await expect.poll(() => params(page)).toEqual({ ...filtered, view: 'gantt' });
    await expect.poll(async () => toIds(await timelineTitles(page))).toEqual(idsOf(serverOpen));
    expect(net.lastCompletion()).toEqual(['open']); await overflow(page);

    await views(page).getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect.poll(() => params(page)).toEqual(filtered);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(serverOpen));

    // All omits the key and drops the partial notices when everything is loaded.
    await chooseByKeyboard(page, ALL);
    await expect.poll(() => params(page)).toEqual(base); await expect.poll(net.lastCompletion).toEqual([]);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(all));
    await expect(page.getByText(PARTIAL_BUDGET)).toHaveCount(0);
    await views(page).getByRole('button', { name: 'Board', exact: true }).click();
    await expect.poll(async () => toIds(await boardTitles(page))).toEqual(idsOf(all));
    await expect(page.getByText(PARTIAL_BOARD, { exact: true })).toHaveCount(0);
    await views(page).getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect.poll(() => params(page)).toEqual(base);

    // Graph roots are a selection, not a filter result: a filtered-out root stays selected.
    for (const task of [closedDone, openTodo]) await page.getByRole('checkbox', { name: `Select for graph: ${task.title}`, exact: true }).check();
    const graphButton = views(page).getByRole('button', { name: 'Selected graph (2)', exact: true });
    await expect(graphButton).toBeVisible();
    await chooseByKeyboard(page, OPEN);
    await expect.poll(() => tableIds(page)).toEqual(idsOf(serverOpen));
    await expect(graphButton).toBeVisible();
    await graphButton.click(); await expect.poll(() => params(page)).toEqual({ ...filtered, view: 'graph' });
    const graph = page.getByRole('region', { name: 'Project dependencies', exact: true });
    await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
    const diagram = graph.getByRole('region', { name: 'Dependency graph', exact: true });
    await expect.poll(() => diagram.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-id') ?? '').sort())).toEqual(sorted([closedDone.id, openTodo.id]));
    await overflow(page);

    expect(net.writes).toEqual([]); expect(net.errors).toEqual([]);
    expect(await Promise.all(all.map(task => f.task(task.id)))).toEqual(before);
    await evidenceJson(info, `completion-filter-views-${name}.json`, { reads: net.reads.map(url => url.pathname + url.search), finalUrl: page.url(), serverOpen: idsOf(serverOpen) });
  });

  test('confirmed completion removes the row only after the filtered refetch; a retained drawer completes and reopens; an exact draft survives filter switches; only intended writes', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Completion filter QA flow');
    const work = await f.createTask(`${f.token} complete me`);
    const reopen = await f.createTask(`${f.token} reopen me`, { statusId: f.progress.id });
    const keep = await f.createTask(`${f.token} stays open`);
    const drafted = await f.createTask(`${f.token} closed draft`, { statusId: f.done.id });
    const net = observe(page, f);
    const filtered = { completion: 'open', extra: 'keep' };

    await page.goto(`${f.path}?completion=open&extra=keep#completion-flow`);
    await expect(picker(page)).toContainText(OPEN);
    await expect.poll(() => tableIds(page)).toEqual(idsOf([work, reopen, keep]));
    expect(net.reads[0]?.searchParams.getAll('completion')).toEqual(['open']);
    expect(idsOf(await serverTasks(f, { completion: 'open' }))).toEqual(idsOf([work, reopen, keep]));

    // 1. Keyboard completion: the PATCH receipt says done, but the held list keeps the old row and its
    //    original status until the server's filtered refetch is released; no optimistic list update.
    const listPath = `${f.prefix}/tasks`, workPath = `${f.prefix}/tasks/${work.id}`;
    const held = gate(); let holding = false, heldReads = 0;
    const listRoute = (url: URL) => url.pathname === listPath;
    await page.route(listRoute, async route => {
      if (holding && route.request().method() === 'GET') { heldReads++; await held.wait; }
      await route.continue();
    });
    try {
      const action = completion(page, work);
      await expect(action).toHaveAccessibleName(`Mark ${work.title} complete`);
      const saved = page.waitForResponse(r => apiCall(r, 'PATCH', workPath));
      holding = true; await action.focus(); await action.press('Enter');
      expect((await taskResult(await saved, 200)).statusId).toBe(f.done.id);
      await expect.poll(() => heldReads).toBeGreaterThan(0);
      await expect(row(page, work)).toHaveCount(1);
      await expect(row(page, work).locator(`[data-task-cell="${work.id}:statusId"]`)).toContainText(f.todo.name);
      holding = false; held.release();
      await expect(row(page, work)).toHaveCount(0);
    } finally { holding = false; held.release(); await page.unroute(listRoute); }
    await expect.poll(() => tableIds(page)).toEqual(idsOf([reopen, keep]));
    expect(params(page)).toEqual(filtered); expect(hash(page)).toBe('#completion-flow');

    // 2. Retained drawer: completing removes the row behind it; reopening from the same drawer returns it.
    const drawer = await openTaskDrawer(page, reopen);
    const reopenPath = `${f.prefix}/tasks/${reopen.id}`;
    await choose(drawer, 'Status', f.done.name);
    let saved = page.waitForResponse(r => apiCall(r, 'PATCH', reopenPath));
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await taskResult(await saved, 200)).statusId).toBe(f.done.id);
    await expect(row(page, reopen)).toHaveCount(0);
    await expect(drawer).toBeVisible(); await expect(drawer.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(reopen.title);
    expect(params(page)).toEqual({ ...filtered, task: reopen.id });
    await choose(drawer, 'Status', f.todo.name);
    saved = page.waitForResponse(r => apiCall(r, 'PATCH', reopenPath));
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await taskResult(await saved, 200)).statusId).toBe(f.todo.id);
    await expect(row(page, reopen)).toHaveCount(1);
    await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
    await expect.poll(() => params(page)).toEqual(filtered);
    await expect.poll(() => tableIds(page)).toEqual(idsOf([reopen, keep]));

    // 3. An exact in-memory draft on a closed task survives being filtered out and back in, unsent.
    await chooseByKeyboard(page, ALL);
    await expect.poll(() => tableIds(page)).toEqual(idsOf([work, reopen, keep, drafted]));
    const draftDrawer = await openTaskDrawer(page, drafted);
    const draftTitle = `${drafted.title} unsaved`, draftText = 'Exact retained\ndraft across completion filters';
    await draftDrawer.getByRole('textbox', { name: 'Task name', exact: true }).fill(draftTitle);
    await draftDrawer.getByLabel('Description', { exact: true }).fill(draftText);
    await draftDrawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(draftDrawer).toHaveCount(0);
    await expect(completion(page, drafted)).toHaveAccessibleName(`Resume draft for ${drafted.title}`);
    await chooseByKeyboard(page, OPEN);
    await expect.poll(() => tableIds(page)).toEqual(idsOf([reopen, keep]));
    await expect(page.getByRole('dialog', { name: 'Leave this page?', exact: true })).toHaveCount(0);
    await chooseByKeyboard(page, ALL);
    await expect.poll(() => tableIds(page)).toEqual(idsOf([work, reopen, keep, drafted]));
    await expect(completion(page, drafted)).toHaveAccessibleName(`Resume draft for ${drafted.title}`);
    await completion(page, drafted).click();
    const resumed = page.getByRole('dialog', { name: drafted.title, exact: true });
    await expect(resumed.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(draftTitle);
    await expect(resumed.getByLabel('Description', { exact: true })).toHaveValue(draftText);
    await resumed.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(resumed).toHaveCount(0);
    await overflow(page);

    expect(net.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([`PATCH ${workPath}`, `PATCH ${reopenPath}`, `PATCH ${reopenPath}`]);
    expect(net.writes.map(write => JSON.parse(write.body ?? '{}'))).toEqual([
      { expectedRevision: work.revision, statusId: f.done.id },
      { expectedRevision: reopen.revision, statusId: f.done.id },
      { expectedRevision: reopen.revision + 1, statusId: f.todo.id },
    ]);
    expect(net.errors).toEqual([]);
    expect(await f.task(work.id)).toMatchObject({ statusId: f.done.id, revision: work.revision + 1 });
    expect(await f.task(reopen.id)).toMatchObject({ statusId: f.todo.id, revision: reopen.revision + 2 });
    expect(await f.task(keep.id)).toEqual(keep); expect(await f.task(drafted.id)).toEqual(drafted);
    await page.screenshot({ path: info.outputPath(`completion-flow-${name}.png`) });
    await evidenceJson(info, `completion-filter-flow-${name}.json`, { writes: net.writes, reads: net.reads.map(url => url.pathname + url.search), finalUrl: page.url() });
  });
});
