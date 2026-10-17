// First night UX batch: native acceptance prepared in source. Execute only in the coordinator's compiled
// window (tests/e2e/night-ux.config.ts); no result is claimed from source.
//
// Intended contract, one journey per test at 1440, 1024 and 390:
// 1. Sidebar: active projects are real links; only the current project is aria-current (Projects is exact);
//    links navigate natively; a dirty quick-add draft is guarded (Stay keeps it, Leave discards it unsent);
//    a failed project list shows no stale links, never blocks the page, and an explicit retry recovers.
// 2. Filters: status/participant/tag live in validated URL params that survive the drawer, Back, Board and
//    reload alongside unrelated params; search text is applied on the server but never written to the URL;
//    malformed or repeated params are ignored without rewriting the URL.
// 3. Gantt: the first settled load fits once; Today is respected until explicit Fit; the fitted window draws
//    aligned bars on compact rows with month/weekend axis cells, keeps undated work in a No dates group,
//    and overflows only inside its own scroller; viewing never sends a mutation.
// 4. Graph: A(done)→B(todo)→C(in progress); resolved/unresolved arrows and nodes have accessible labels;
//    clicking a node focuses its incident edges and dims the rest; task cards collapse behind a disclosure;
//    automatic layout refits the viewport; nothing writes tasks, dates or layout.
// 5. Weekly: the newest saved project report is shown without any POST; an explicit saved run wins;
//    Calculate current report sends one exact idempotent command; a lost acknowledgement is retried with
//    the identical body and key and creates no duplicate; pinned totals keep missing and zero distinct.
// 6. Organizing: exact fresh-revision section moves, immutable grid, collapsed target expansion, child scope/draft preservation.
// 7. Original estimates: captured zero and original unknown stay immutable through later fills and detail children.
// Shared desktop/mobile cases add five-person meeting preparation and strict actual-SVG connector geometry.
// All labels come from the current English catalogs. Fixtures are new QA projects in the historical
// synthetic workspace, written only through supported APIs.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  attendancePostingResponseSchema, freezePreviewResponseSchema, manualPeriodWorkLogResponseSchema, meetingAttendanceListResponseSchema, meetingCreationResponseSchema, meetingPlanPreviewResponseSchema, meetingPlanResultResponseSchema, meetingResponseSchema, originalPackageEstimateResponseSchema, periodCommitmentResponseSchema, planBaselineResponseSchema, recordedWorkListResponseSchema, sectionResponseSchema, taskResponseSchema,
  projectResponseSchema, tagResponseSchema, taskDependencyResponseSchema, taskListResponseSchema,
  weeklyPlanFactReportRunListResponseSchema, weeklyPlanFactReportRunResponseSchema, weeklyPlanFactRowListResponseSchema, type TaskDto,
} from '@workloom/contracts';
import { dailyFixture } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { futurePeriod, mutate, type Daily } from './support/next-ux.js';

const viewports = [['desktop', { width: 1440, height: 1000 }], ['medium', { width: 1024, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const;
type Size = (typeof viewports)[number][1];
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Read-only: horizontal overflow of the whole document; any positive value is a global overflow. */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const openTask = (page: Page, task: TaskDto) => page.getByRole('button', { name: `Open task “${task.title}”`, exact: true });
/** The details icon is a real row-hover affordance; reveal it before a native pointer click. */
async function openTaskDrawer(page: Page, task: TaskDto) {
  await page.locator(`[data-task-row="${task.id}"]`).hover();
  await openTask(page, task).click();
}

/**
 * Every non-GET request the page sends, plus failed API/asset requests and page errors. A request the test
 * fails on purpose is declared with `expect`; GET requests the app aborts itself (query cancellation) are
 * kept as evidence only.
 */
function watch(page: Page) {
  const writes: { method: string; path: string }[] = [], failures: string[] = [], plannedFailures: string[] = [], cancelled: string[] = [], errors: string[] = [];
  const planned: ((method: string, path: string) => boolean)[] = [];
  const isPlanned = (method: string, path: string) => planned.some(match => match(method, path));
  const relevant = (path: string) => path.startsWith('/api/') || /\.(?:js|css)$/.test(path);
  page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: new URL(q.url()).pathname }); });
  page.on('requestfailed', q => {
    const path = new URL(q.url()).pathname, text = q.failure()?.errorText ?? '';
    if (isPlanned(q.method(), path)) { plannedFailures.push(`${q.method()} ${path} ${text}`); return; }
    if (q.method() === 'GET' && text === 'net::ERR_ABORTED') cancelled.push(path); else if (relevant(path)) failures.push(`${q.method()} ${path} ${text}`);
  });
  page.on('response', r => {
    const path = new URL(r.url()).pathname;
    if (r.status() >= 400 && relevant(path)) (isPlanned(r.request().method(), path) ? plannedFailures : failures).push(`${r.request().method()} ${path} ${r.status()}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, failures, plannedFailures, cancelled, errors, expect: (match: (method: string, path: string) => boolean) => { planned.push(match); } };
}
type Net = ReturnType<typeof watch>;
function expectClean(net: Net) {
  expect(net.failures, 'failed API or asset requests').toEqual([]);
  expect(net.errors, 'page errors').toEqual([]);
}

/** The sidebar a person can use at this width: the fixed aside from lg (64rem), otherwise the menu drawer. */
async function sidebar(page: Page, size: Size): Promise<Locator> {
  if (size.width >= 1024) {
    const aside = page.getByRole('complementary', { name: 'Sidebar', exact: true });
    await expect(aside).toBeVisible(); return aside;
  }
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  if (!(await drawer.isVisible())) await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await expect(drawer).toBeVisible(); return drawer;
}
async function activeProjects(page: Page, size: Size) {
  const root = await sidebar(page, size);
  const nav = root.getByRole('navigation', { name: 'Active projects', exact: true });
  return { root, nav, link: (name: string) => nav.getByRole('link', { name, exact: true }) };
}
const pathOf = (page: Page) => new URL(page.url()).pathname;

/** Custom ChoicePicker: open with a real click, choose the option by its visible label, expect it closed. */
async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true });
  await trigger.click();
  const list = page.getByRole('listbox', { name: label, exact: true });
  await expect(list).toBeVisible();
  // An avatar may add initials before the label; the label always ends the option name.
  await list.getByRole('option', { name: new RegExp(`(?:^|\\s)${escape(option)}$`) }).click();
  await expect(list).toHaveCount(0);
  await expect(trigger).toContainText(option);
}

async function chooseIndex(page: Page, label: string, index: number) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  const list = page.getByRole('listbox', { name: label, exact: true });
  await expect(list).toBeVisible();
  const option = list.getByRole('option').nth(index);
  const text = await option.innerText(); await option.click();
  await expect(list).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: label, exact: true })).toContainText(text);
}

/** Read only DOM boxes. Every loaded task keeps the same 41px grid and the headers keep their widths. */
async function tableGeometry(page: Page) {
  return page.locator('[data-task-table-scroll]').evaluate(table => ({
    rows: [...table.querySelectorAll('[data-task-row]')].map(row => ({ id: row.getAttribute('data-task-row'), height: row.getBoundingClientRect().height })),
    headers: [...table.querySelectorAll('thead th')].map(cell => ({ text: cell.textContent, width: cell.getBoundingClientRect().width })),
  }));
}
function expectFixedGrid(before: Awaited<ReturnType<typeof tableGeometry>>, current: Awaited<ReturnType<typeof tableGeometry>>) {
  expect(current.rows.length).toBeGreaterThan(0);
  for (const row of current.rows) expect(row.height, `row ${row.id}`).toBe(41);
  expect(current.headers).toEqual(before.headers);
}

/** Real SVG path endpoints in viewport pixels, checked against the actually painted bar/diamond boxes. */
async function connectorGeometry(calendar: Locator, links: { id: string; from: string; to: string }[]) {
  return calendar.evaluate((scroller, edges) => edges.map(edge => {
    const svg = scroller.querySelector<SVGSVGElement>('[data-gantt-connectors]');
    const path = svg?.querySelector<SVGPathElement>(`[data-dependency-id="${edge.id}"] > path`);
    const from = scroller.querySelector(`[data-gantt-anchor="${edge.from}"] [role="img"]`);
    const to = scroller.querySelector(`[data-gantt-anchor="${edge.to}"] [role="img"]`);
    if (!path || !from || !to) throw Error(`Missing real connector/bar for ${edge.id}`);
    const matrix = path.getScreenCTM(); if (!matrix) throw Error('No SVG screen transform');
    const a = path.getPointAtLength(0).matrixTransform(matrix), b = path.getPointAtLength(path.getTotalLength()).matrixTransform(matrix);
    const f = from.getBoundingClientRect(), t = to.getBoundingClientRect();
    return { id: edge.id, state: path.parentElement?.getAttribute('data-state'),
      start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
      expectedStart: { x: f.right, y: (f.top + f.bottom) / 2 }, expectedEnd: { x: t.left, y: (t.top + t.bottom) / 2 },
      errors: [Math.abs(a.x - f.right), Math.abs(a.y - (f.top + f.bottom) / 2), Math.abs(b.x - t.left), Math.abs(b.y - (t.top + t.bottom) / 2)],
    };
  }), links);
}
async function expectConnectors(calendar: Locator, links: { id: string; from: string; to: string }[]) {
  await expect.poll(async () => (await connectorGeometry(calendar, links)).flatMap(edge => edge.errors).every(error => error <= 1.5)).toBe(true);
  const geometry = await connectorGeometry(calendar, links);
  for (const edge of geometry) for (const error of edge.errors) expect(error, JSON.stringify(edge)).toBeLessThanOrEqual(1.5);
  return geometry;
}

/** The URL-owned parameters this batch cares about; a repeated key is kept visible as `a|b`. */
function owned(page: Page) {
  const params = new URL(page.url()).searchParams;
  return Object.fromEntries(['status', 'participant', 'tag', 'includeArchived', 'sort', 'view', 'task'].flatMap(key => params.getAll(key).length ? [[key, params.getAll(key).join('|')]] : []));
}

/** Calendar days between two plain dates, computed in UTC so no zone can shift a day. */
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** Read-only Gantt geometry: axis days and months, task rows with their bars, and the scroller frame. */
function ganttGeometry(calendar: Locator) {
  return calendar.evaluate(scroller => {
    const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const daysList = scroller.querySelector('ol[aria-label="Calendar window days"]');
    const days = [...(daysList?.querySelectorAll(':scope > li') ?? [])].map(li => ({ date: li.getAttribute('title') ?? '', today: li.getAttribute('aria-current') === 'date', background: getComputedStyle(li).backgroundColor, ...rect(li) }));
    const months = [...(daysList?.previousElementSibling?.children ?? [])].map(month => ({ title: month.getAttribute('title') ?? '', ...rect(month) }));
    const rows = [...scroller.querySelectorAll('[role="group"][aria-label^="Calendar dates: "]')].map(row => ({
      label: row.getAttribute('aria-label') ?? '', ...rect(row),
      bars: [...row.querySelectorAll('[role="img"]')].map(bar => ({ name: bar.getAttribute('aria-label') ?? '', ...rect(bar) })),
    }));
    const frame = rect(scroller);
    return { days, months, rows, frame, clientWidth: (scroller as HTMLElement).clientWidth, scrollWidth: scroller.scrollWidth, viewport: document.documentElement.clientWidth, pageOverflow: document.documentElement.scrollWidth - innerWidth };
  });
}

/** Read-only React Flow state: node/edge emphasis and whether each node box is inside the diagram frame. */
function graphState(diagram: Locator) {
  return diagram.evaluate(region => {
    const frame = region.getBoundingClientRect();
    const nodes = [...region.querySelectorAll<HTMLElement>('.react-flow__node')].map(node => {
      const r = node.getBoundingClientRect();
      return { id: node.dataset.id ?? '', opacity: Number(getComputedStyle(node).opacity), inside: r.width > 0 && r.left >= frame.left - 1 && r.right <= frame.right + 1 && r.top >= frame.top - 1 && r.bottom <= frame.bottom + 1 };
    });
    const edges = [...region.querySelectorAll<SVGGElement>('.react-flow__edge')].map(edge => {
      const path = edge.querySelector('path.react-flow__edge-path'), style = path ? getComputedStyle(path) : null;
      return { id: edge.dataset.id ?? '', opacity: Number(style?.opacity ?? NaN), strokeWidth: parseFloat(style?.strokeWidth ?? 'NaN'), dash: style?.strokeDasharray ?? '' };
    });
    const viewport = region.querySelector('.react-flow__viewport'), m = viewport ? new DOMMatrixReadOnly(getComputedStyle(viewport).transform) : null;
    return { nodes, edges, viewport: m ? { zoom: m.a, x: m.e, y: m.f } : null };
  });
}
/** Polls until React Flow's own viewport has settled after a control; never moves it itself. */
async function settledViewport(diagram: Locator) {
  let previous = '', equal = 0;
  await expect.poll(async () => { const now = JSON.stringify((await graphState(diagram)).viewport); equal = now === previous ? equal + 1 : 0; previous = now; return equal >= 2; }).toBe(true);
}

async function projectTasks(f: Daily) {
  const r = await f.request.get(`${f.prefix}/tasks`, { params: { projectId: f.project.id, limit: 200, includeArchived: 'true' } });
  expect(r.status(), await r.text()).toBe(200);
  return taskListResponseSchema.parse(await r.json()).data;
}
const dates = (task: TaskDto) => ({ startDate: task.startDate, dueDate: task.dueDate, estimateMinutes: task.estimateMinutes, statusId: task.statusId, revision: task.revision });
async function saveEvidence(info: TestInfo, name: string, value: unknown) { await evidenceJson(info, name, value); }

for (const [name, size] of viewports) test.describe(`Night UX ${name}`, () => {
  test.use({ viewport: size });

  test('sidebar: a failed project list stays safe and recovers; only the current project link is active; native links navigate; a dirty quick-add draft is guarded and discarded unsent', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night nav');
    const peer = (await f.post('/projects', { name: `Night nav peer ${f.token}` }, projectResponseSchema)).data;
    const anchor = await f.createTask(`${f.token} anchor`);
    const peerPath = `/w/${f.workspace.id}/projects/${peer.id}`, listPath = `${f.prefix}/projects`;
    const heading = (title: string) => page.getByRole('heading', { level: 1, name: title, exact: true });
    const net = watch(page); const evidence: Record<string, unknown> = {};

    // 1. Failed list: the project page keeps working, the sidebar shows no stale links, nothing writes.
    // Only the routed 503s are planned failures; the recovered list must then render real links.
    let failedReads = 0, recovered = false;
    net.expect((method, path) => method === 'GET' && path === listPath);
    await page.route(`**${listPath}`, async route => {
      if (route.request().method() !== 'GET' || recovered) return route.fallback();
      failedReads++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Night QA: project list unavailable', retryable: true }, meta: { requestId: `night-qa-${f.token}` } }) });
    });
    try {
      await page.goto(f.path);
      await expect(heading(f.project.name)).toBeVisible();
      await expect(openTask(page, anchor)).toBeVisible();
      const failed = await activeProjects(page, size);
      await expect(failed.nav.getByText('Projects could not be loaded.', { exact: true })).toBeVisible({ timeout: 20_000 });
      await expect(failed.nav.getByRole('link')).toHaveCount(0);
      // Automatic retries finish first; then the explicit retry is offered.
      await expect(failed.nav.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled({ timeout: 20_000 });
      await expect(failed.root.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
      expect(failedReads).toBeGreaterThan(0); expect(pathOf(page)).toBe(f.path); expect(await overflow(page)).toBeLessThanOrEqual(0);
      evidence.failedReads = failedReads;
      recovered = true;
      await failed.nav.getByRole('button', { name: 'Try again', exact: true }).click();
    } finally { recovered = true; await page.unroute(`**${listPath}`); }

    // 2. Recovered list: only the current project is current; Projects is exact; the list is bounded.
    let side = await activeProjects(page, size);
    await expect(side.link(f.project.name)).toHaveAttribute('aria-current', 'page');
    await expect(side.link(peer.name)).toBeVisible();
    await expect(side.link(peer.name)).not.toHaveAttribute('aria-current', 'page');
    await expect(side.root.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Projects', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await expect(side.link(f.project.name)).toHaveAttribute('href', f.path);
    const list = await side.nav.getByRole('list').evaluate(el => {
      const r = el.getBoundingClientRect(), links = [...el.querySelectorAll('a')].map(a => a.getBoundingClientRect());
      return { height: r.height, right: r.right, linkRight: Math.max(...links.map(l => l.right)), innerHeight, links: links.length };
    });
    evidence.list = list;
    expect(list.height).toBeLessThanOrEqual(Math.min(0.4 * list.innerHeight, 320) + 1);
    expect(list.linkRight).toBeLessThanOrEqual(list.right + 0.5);

    // 3. Native link navigation to the peer and back; on mobile the drawer closes itself.
    await side.link(peer.name).click();
    await expect.poll(() => pathOf(page)).toBe(peerPath); await expect(heading(peer.name)).toBeVisible();
    if (size.width < 1024) await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toHaveCount(0);
    side = await activeProjects(page, size);
    await expect(side.link(peer.name)).toHaveAttribute('aria-current', 'page');
    await expect(side.link(f.project.name)).not.toHaveAttribute('aria-current', 'page');
    await side.link(f.project.name).click();
    await expect.poll(() => pathOf(page)).toBe(f.path); await expect(heading(f.project.name)).toBeVisible();

    // 4. A typed quick-add title is a protected draft: Stay keeps it, Leave discards it without a request.
    const draftTitle = `${f.token} unsent sidebar draft`;
    await page.getByRole('button', { name: 'Add task to “QA section”', exact: true }).click();
    const titleBox = page.getByRole('form', { name: 'Add a task to QA section', exact: true }).getByRole('textbox', { name: 'Task name', exact: true });
    await expect(titleBox).toBeFocused(); await titleBox.pressSequentially(draftTitle); await expect(titleBox).toHaveValue(draftTitle);
    side = await activeProjects(page, size); await side.link(peer.name).click();
    const guard = page.getByRole('dialog', { name: 'Leave this page?', exact: true });
    await expect(guard).toContainText('You have an unsaved draft on this page.'); await expect(guard).not.toContainText('The server may have saved');
    await guard.getByRole('button', { name: 'Stay', exact: true }).click(); await expect(guard).toHaveCount(0);
    expect(pathOf(page)).toBe(f.path); await expect(heading(f.project.name)).toBeVisible(); await expect(titleBox).toHaveValue(draftTitle);
    side = await activeProjects(page, size); await side.link(peer.name).click();
    await expect(guard).toBeVisible(); await guard.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await expect.poll(() => pathOf(page)).toBe(peerPath); await expect(heading(peer.name)).toBeVisible();

    expect((await projectTasks(f)).map(task => task.title)).toEqual([anchor.title]);
    expect(net.writes).toEqual([]); expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    await saveEvidence(info, `night-sidebar-${name}.json`, { ...evidence, writes: net.writes, cancelled: net.cancelled, peerPath });
  });

  test('filters: validated URL state survives drawer, Back, Board and reload with unrelated params; search is server-side but never in the URL; malformed and repeated params are ignored, not rewritten', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night filters');
    const tag = (await f.post('/tags', { name: `Night tag ${f.token}`, color: '#6366f1' }, tagResponseSchema)).data;
    const target = await f.createTask(`${f.token} alpha target`, { statusId: f.progress.id, participantMembershipIds: [f.own.id, f.other.id], tagIds: [tag.id] });
    const ownOnly = await f.createTask(`${f.token} alpha own only`, { statusId: f.progress.id });
    const done = await f.createTask(`${f.token} alpha done`, { statusId: f.done.id, participantMembershipIds: [f.other.id], tagIds: [tag.id] });
    const beta = await f.createTask(`${f.token} beta target`, { statusId: f.progress.id, participantMembershipIds: [f.other.id], tagIds: [tag.id] });
    const all = [target, ownOnly, done, beta];
    const net = watch(page), reads: URL[] = [];
    page.on('request', q => { const u = new URL(q.url()); if (q.method() === 'GET' && u.pathname === `${f.prefix}/tasks` && u.searchParams.get('projectId') === f.project.id) reads.push(u); });
    const lastRead = () => { const p = reads.at(-1)?.searchParams; return { search: p?.get('search') ?? null, statusId: p?.get('statusId') ?? null, participantMembershipId: p?.get('participantMembershipId') ?? null, tagId: p?.get('tagId') ?? null, includeArchived: p?.get('includeArchived') === 'true' }; };
    const shows = async (visible: readonly TaskDto[]) => { for (const task of all) await expect(openTask(page, task)).toHaveCount(visible.includes(task) ? 1 : 0); };
    const summary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ });
    const chips = page.getByRole('group', { name: 'Active filters', exact: true });
    const search = page.getByLabel('Search tasks', { exact: true });
    const chosen = { sort: 'due_asc', status: f.progress.id, participant: f.other.id, tag: tag.id };

    // Unrelated params (sort) are present from the start and must survive every filter edit.
    await page.goto(`${f.path}?sort=due_asc`); await shows(all);
    await search.click(); await search.pressSequentially('alpha');
    await shows([target, ownOnly, done]);
    await expect.poll(() => lastRead().search).toBe('alpha');
    expect(owned(page)).toEqual({ sort: 'due_asc' }); expect(page.url()).not.toContain('alpha');
    await summary.click();
    await choose(page, 'Task status', f.progress.name);
    await choose(page, 'Task participant', f.other.displayName);
    await choose(page, 'Task tag', tag.name);
    await summary.click(); await expect(summary).toHaveText('Filters (3)');
    await expect(chips.getByRole('button')).toHaveCount(3);
    await expect.poll(() => owned(page)).toEqual(chosen);
    await expect.poll(lastRead).toEqual({ search: 'alpha', statusId: f.progress.id, participantMembershipId: f.other.id, tagId: tag.id, includeArchived: false });
    await shows([target]); expect(page.url()).not.toContain('alpha');

    // Drawer: opening adds only task=; closing removes only task=; filters and in-memory search stay.
    const drawer = page.getByRole('dialog', { name: target.title, exact: true });
    await openTaskDrawer(page, target); await expect(drawer).toBeVisible();
    expect(owned(page)).toEqual({ ...chosen, task: target.id });
    await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
    await expect.poll(() => owned(page)).toEqual(chosen); await expect(search).toHaveValue('alpha'); await shows([target]);
    // Back from an opened drawer returns to the same filtered list, not to an older filter state.
    await openTaskDrawer(page, target); await expect(drawer).toBeVisible();
    await page.goBack(); await expect(drawer).toHaveCount(0);
    await expect.poll(() => owned(page)).toEqual(chosen); await expect(summary).toHaveText('Filters (3)'); await shows([target]);

    // Board keeps the same server filters and search.
    await page.getByRole('navigation', { name: 'Project views', exact: true }).getByRole('button', { name: 'Board', exact: true }).click();
    await expect.poll(() => owned(page)).toEqual({ ...chosen, view: 'board' });
    const lanes = page.getByRole('region', { name: 'Task status lanes', exact: true });
    await expect(lanes).toContainText(target.title); for (const task of [ownOnly, done, beta]) await expect(lanes).not.toContainText(task.title);
    await expect(search).toHaveValue('alpha');

    // Reload: URL filters return, search does not (it was never in the URL).
    await page.reload(); await expect(lanes).toBeVisible();
    await expect(search).toHaveValue(''); await expect(summary).toHaveText('Filters (3)');
    await expect.poll(lastRead).toEqual({ search: null, statusId: f.progress.id, participantMembershipId: f.other.id, tagId: tag.id, includeArchived: false });
    await expect(lanes).toContainText(target.title); await expect(lanes).toContainText(beta.title);
    for (const task of [ownOnly, done]) await expect(lanes).not.toContainText(task.title);
    await page.getByRole('navigation', { name: 'Project views', exact: true }).getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect.poll(() => owned(page)).toEqual(chosen); await shows([target, beta]);

    // Malformed status, repeated participant and a non-boolean archived flag are ignored and left as typed.
    const typed = `${f.path}?status=not-a-status&participant=${f.other.id}&participant=${f.own.id}&tag=${tag.id}&includeArchived=maybe&sort=due_asc`;
    await page.goto(typed);
    await shows([target, done, beta]);
    await expect.poll(lastRead).toEqual({ search: null, statusId: null, participantMembershipId: null, tagId: tag.id, includeArchived: false });
    await expect(summary).toHaveText('Filters (1)');
    await expect(chips.getByRole('button')).toHaveCount(1); await expect(chips.getByRole('button', { name: `Clear tag filter: ${tag.name}`, exact: true })).toBeVisible();
    const asTyped = { status: 'not-a-status', participant: `${f.other.id}|${f.own.id}`, tag: tag.id, includeArchived: 'maybe', sort: 'due_asc' };
    expect(pathOf(page)).toBe(f.path); expect(owned(page)).toEqual(asTyped);
    // A later explicit choice replaces only its own key; the ambiguous participant stays unapplied.
    await summary.click(); await choose(page, 'Task status', f.progress.name); await summary.click();
    await expect.poll(() => owned(page).status).toBe(f.progress.id);
    expect(owned(page)).toMatchObject({ tag: tag.id, sort: 'due_asc' });
    await expect.poll(lastRead).toEqual({ search: null, statusId: f.progress.id, participantMembershipId: null, tagId: tag.id, includeArchived: false });
    await shows([target, beta]);

    expect(net.writes).toEqual([]); expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    await saveEvidence(info, `night-filters-${name}.json`, { reads: reads.map(u => u.pathname + u.search), finalUrl: page.url(), cancelled: net.cancelled });
  });

  test('gantt: first load fits once; Today stays until explicit Fit; the fitted window draws aligned bars on compact rows with month and weekend axis cells, keeps undated work grouped, overflows only internally and sends no mutation', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night gantt');
    const earliest = '2026-03-02', latest = '2026-04-08';
    const early = await f.createTask(`${f.token} past early`, { startDate: earliest, dueDate: '2026-03-20' });
    const late = await f.createTask(`${f.token} past late`, { startDate: '2026-03-16', dueDate: latest });
    const pointTask = await f.createTask(`${f.token} past due only`, { dueDate: '2026-03-25' });
    const undated = await f.createTask(`${f.token} undated`);
    const before = await Promise.all([early, late, pointTask, undated].map(task => f.task(task.id)));
    const net = watch(page); let contextReads = 0;
    page.on('request', q => { if (q.method() === 'GET' && new URL(q.url()).pathname === `${f.prefix}/projects/${f.project.id}/schedule-context`) contextReads++; });

    await page.goto(`${f.path}?view=gantt`);
    const timeline = page.getByRole('region', { name: 'Project timeline', exact: true });
    // The scroller is a focusable labelled frame without a landmark role.
    const calendar = timeline.locator('[aria-label="Loaded task calendar"]');
    const windowStart = timeline.getByLabel('Window start', { exact: true }), windowSize = timeline.getByRole('combobox', { name: 'Days in window', exact: true });
    const currentBars = timeline.getByRole('img', { name: /^Current: / });
    await expect(calendar).toBeVisible();
    // First successful load fits once. Comparison controls are initially closed and do not add a baseline.
    await expect(currentBars).toHaveCount(3);
    await expect(windowSize).toHaveValue('84');
    await expect(timeline.getByRole('button', { name: 'Compare with frozen plan', exact: true })).toHaveAttribute('aria-expanded', 'false');
    const closedPeriod = timeline.locator('label').filter({ hasText: /^Plan period/ }).locator('select');
    await expect(closedPeriod).toHaveCount(1); await expect(closedPeriod).toBeHidden();

    // Today: the window starts on the workspace's today, marks it, and says the past work is outside.
    const todayButton = timeline.getByRole('button', { name: 'Today', exact: true });
    const today = (await todayButton.getAttribute('title'))?.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
    expect(today > latest, `fixture dates must be in the past of ${today}`).toBe(true);
    await todayButton.click();
    await expect(windowStart).toHaveValue(today);
    await expect(calendar.getByRole('list', { name: 'Calendar window days', exact: true }).locator('li[aria-current="date"]')).toHaveAttribute('title', today);
    await expect(currentBars).toHaveCount(0);
    await expect(timeline.getByRole('status').filter({ hasText: '3 earlier, 0 later.' })).toBeVisible();

    // Explicit Fit: the smallest supported window that covers 2026-03-02 — 2026-04-08 (38 days) is 84 days.
    await timeline.getByRole('button', { name: 'Fit loaded tasks', exact: true }).click();
    await expect(windowSize).toHaveValue('84');
    await expect(windowStart).not.toHaveValue(today);
    const start = await windowStart.inputValue(), end = addDays(start, 83);
    expect(start <= earliest && end >= latest, `window ${start} — ${end}`).toBe(true);
    await expect(timeline.getByRole('status').filter({ hasText: 'Fitted to 3 dated tasks:' })).toBeVisible();
    const bars = {
      early: 'Current: start 2026-03-02, due 2026-03-20',
      late: 'Current: start 2026-03-16, due 2026-04-08',
      point: 'Current: start Not set, due 2026-03-25; only due date',
    };
    for (const label of Object.values(bars)) await expect(timeline.getByRole('img', { name: label, exact: true })).toBeVisible();
    await expect(currentBars).toHaveCount(3);
    const noDates = timeline.getByRole('group', { name: 'No dates · 1 task', exact: true });
    await expect(noDates).toBeVisible();
    await expect(noDates.getByRole('group', { name: `Calendar dates: ${undated.title}`, exact: true })).toContainText('No dates');
    for (const task of [early, late, pointTask]) await expect(noDates.getByRole('group', { name: `Calendar dates: ${task.title}`, exact: true })).toHaveCount(0);

    const g = await ganttGeometry(calendar);
    const day = (date: string) => { const found = g.days.find(item => item.date === date); if (!found) throw Error(`Axis day ${date} is missing.`); return found; };
    const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
    const problems: string[] = [];
    if (g.days.length !== 84 || g.days[0]?.date !== start || g.days.at(-1)?.date !== end) problems.push(`axis ${g.days.length} days ${g.days[0]?.date} — ${g.days.at(-1)?.date}`);
    // Months: one segment per calendar month in the window, in order, starting at that month's first day cell.
    const monthName = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const expectedMonths = [...new Set(Array.from({ length: 84 }, (_, i) => addDays(start, i).slice(0, 7)))]
      .map(month => { const first = `${month}-01` < start ? start : `${month}-01`; return { title: monthName.format(new Date(`${first}T00:00:00Z`)), first }; });
    if (JSON.stringify(g.months.map(month => month.title)) !== JSON.stringify(expectedMonths.map(month => month.title))) problems.push(`months ${g.months.map(month => month.title).join(', ')} ≠ ${expectedMonths.map(month => month.title).join(', ')}`);
    expectedMonths.forEach(({ title, first }, i) => { const shown = g.months[i]; if (!shown || !near(shown.left, day(first).left)) problems.push(`month ${title} left ${shown?.left} ≠ day ${first} ${day(first).left}`); });
    // Weekend: Saturday/Sunday cells share one shading that no weekday cell has.
    const weekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const weekendColors = new Set(g.days.filter(d => !d.today && weekend(d.date)).map(d => d.background));
    const weekdayColors = new Set(g.days.filter(d => !d.today && !weekend(d.date)).map(d => d.background));
    if (weekendColors.size !== 1 || [...weekendColors].some(color => weekdayColors.has(color))) problems.push(`weekend ${[...weekendColors].join('/')} vs weekday ${[...weekdayColors].join('/')}`);
    // Bars: range ends align with their day cells; the due-only point sits inside its day; all inside their rows.
    const rowOf = (task: TaskDto) => g.rows.find(row => row.label === `Calendar dates: ${task.title}`);
    for (const [task, label, from, to] of [[early, bars.early, earliest, '2026-03-20'], [late, bars.late, '2026-03-16', latest]] as const) {
      const bar = rowOf(task)?.bars.find(item => item.name === label);
      if (!bar || !near(bar.left, day(from).left) || !near(bar.right, day(to).right)) problems.push(`bar ${label} ${bar?.left}–${bar?.right} ≠ ${day(from).left}–${day(to).right}`);
    }
    const point = rowOf(pointTask)?.bars.find(item => item.name === bars.point), due = day('2026-03-25');
    if (!point || (point.left + point.right) / 2 < due.left || (point.left + point.right) / 2 > due.right) problems.push('due-only point outside its day');
    for (const row of g.rows) {
      if (row.height > 72) problems.push(`row ${row.label} height ${row.height} > 72`);
      for (const bar of row.bars) if (bar.top < row.top - 0.5 || bar.bottom > row.bottom + 0.5) problems.push(`bar ${bar.name} leaves its row`);
    }
    // The wide axis scrolls inside its own frame; the document never overflows.
    if (g.pageOverflow > 0) problems.push(`page overflow ${g.pageOverflow}`);
    if (g.frame.right > g.viewport + 0.5) problems.push(`calendar frame right ${g.frame.right} > ${g.viewport}`);
    if (g.scrollWidth <= g.clientWidth) problems.push('84-day axis does not scroll inside its frame');
    expect(problems).toEqual([]);

    expect(contextReads).toBeGreaterThan(0);
    expect(net.writes).toEqual([]); expectClean(net);
    const after = await Promise.all([early, late, pointTask, undated].map(task => f.task(task.id)));
    expect(after.map(dates)).toEqual(before.map(dates));
    await saveEvidence(info, `night-gantt-${name}.json`, { today, window: { start, end }, geometry: g, contextReads, cancelled: net.cancelled });
  });

  test('graph: resolved and unresolved arrows are labelled; clicking a node focuses its incident edges and dims the rest; cards collapse behind a disclosure; automatic layout refits the viewport without any write', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night graph');
    const a = await f.createTask(`${f.token} A done`, { statusId: f.done.id });
    const b = await f.createTask(`${f.token} B todo`);
    const c = await f.createTask(`${f.token} C in progress`, { statusId: f.progress.id });
    const edge = async (from: TaskDto, to: TaskDto) => (await f.post('/dependencies', { predecessorTaskId: from.id, successorTaskId: to.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data;
    const ab = await edge(a, b), bc = await edge(b, c);
    const before = await Promise.all([a, b, c].map(task => f.task(task.id)));
    const net = watch(page); const evidence: Record<string, unknown> = {};

    await page.goto(`${f.path}?view=graph`);
    const graph = page.getByRole('region', { name: 'Project dependencies', exact: true });
    await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
    const diagram = graph.getByRole('region', { name: 'Dependency graph', exact: true });
    const node = (task: TaskDto) => diagram.locator(`.react-flow__node[data-id="${task.id}"]`);
    await expect(diagram.locator('.react-flow__node')).toHaveCount(3);
    await expect(diagram.locator('.react-flow__edge')).toHaveCount(2);

    // Accessible state: nodes say done/blocked; arrows say resolved/unresolved and name both tasks.
    await expect(node(a)).toHaveAttribute('aria-label', `${a.title}, ${f.project.name}, ${f.done.name}, done`);
    await expect(node(b)).toHaveAttribute('aria-label', `${b.title}, ${f.project.name}, ${f.todo.name}`);
    await expect(node(c)).toHaveAttribute('aria-label', new RegExp(`^${escape(`${c.title}, ${f.project.name}, ${f.progress.name}, has unfinished predecessors`)}`));
    const relation = 'The next task starts after the previous task finishes';
    await expect(diagram.locator(`.react-flow__edge[data-id="${ab.id}"]`)).toHaveAttribute('aria-label', `${relation}. Resolved: ${a.title} is done, so ${b.title} no longer waits for it`);
    await expect(diagram.locator(`.react-flow__edge[data-id="${bc.id}"]`)).toHaveAttribute('aria-label', `${relation}. Unresolved: ${b.title} is not done yet, so ${c.title} still waits for it`);
    const legend = graph.getByRole('list', { name: 'Dependency arrow legend', exact: true });
    await expect(legend).toContainText('the predecessor is not done, so the dependency is unresolved'); await expect(legend).toContainText('the predecessor is done, so the dependency is resolved');
    const listed = graph.getByRole('region', { name: 'Dependencies in this selection', exact: true }).getByRole('listitem');
    await expect(listed.filter({ hasText: `${a.title} → ${b.title}` })).toContainText('Resolved: predecessor done');
    await expect(listed.filter({ hasText: `${b.title} → ${c.title}` })).toContainText('Unresolved: predecessor not done');
    const initial = await graphState(diagram);
    const edgeOf = (state: Awaited<ReturnType<typeof graphState>>, id: string) => state.edges.find(item => item.id === id);
    // State is not carried by color alone: resolved is dashed, unresolved is solid.
    expect(edgeOf(initial, ab.id)?.dash).not.toBe('none'); expect(edgeOf(initial, bc.id)?.dash).toBe('none');
    expect(initial.nodes.every(item => item.opacity === 1)).toBe(true);

    // Focus by a real click on node content that is not a button.
    const focus = graph.getByRole('status', { name: 'Selected task dependencies', exact: true });
    await expect(focus).toContainText('Select a task to highlight its direct predecessors and successors in this diagram.');
    const emphasis = async () => { const s = await graphState(diagram); return { nodes: Object.fromEntries(s.nodes.map(item => [item.id, item.opacity])), edges: Object.fromEntries(s.edges.map(item => [item.id, item.opacity])) }; };
    const focusOn = async (task: TaskDto) => { await node(task).locator('p').first().click(); await expect(focus).toContainText(`Focused on ${task.title}. Unrelated tasks and dependencies are dimmed.`); };
    await focusOn(a);
    await expect(focus).toContainText('No direct predecessors in this diagram.'); await expect(focus).toContainText(`1 direct successor in this diagram: ${b.title}`);
    await expect.poll(emphasis).toEqual({ nodes: { [a.id]: 1, [b.id]: 1, [c.id]: 0.35 }, edges: { [ab.id]: 1, [bc.id]: 0.2 } });
    const focusedA = await graphState(diagram); expect(edgeOf(focusedA, ab.id)?.strokeWidth).toBeGreaterThan(edgeOf(initial, ab.id)?.strokeWidth ?? Infinity);
    await focusOn(c);
    await expect(focus).toContainText(`1 direct predecessor in this diagram, 1 not done: ${b.title} (not done)`); await expect(focus).toContainText('No direct successors in this diagram.');
    await expect.poll(emphasis).toEqual({ nodes: { [a.id]: 0.35, [b.id]: 1, [c.id]: 1 }, edges: { [ab.id]: 0.2, [bc.id]: 1 } });
    await focusOn(b);
    await expect(focus).toContainText(`1 direct predecessor in this diagram, 0 not done: ${a.title} (done)`); await expect(focus).toContainText(`1 direct successor in this diagram: ${c.title}`);
    await expect.poll(emphasis).toEqual({ nodes: { [a.id]: 1, [b.id]: 1, [c.id]: 1 }, edges: { [ab.id]: 1, [bc.id]: 1 } });
    await graph.getByRole('button', { name: 'Clear focus', exact: true }).click();
    await expect(focus).toContainText('Select a task to highlight its direct predecessors and successors in this diagram.');
    await expect.poll(emphasis).toEqual({ nodes: { [a.id]: 1, [b.id]: 1, [c.id]: 1 }, edges: { [ab.id]: 1, [bc.id]: 1 } });
    // Clicks select; they never move a node, so there is nothing to save.
    await expect(graph.getByRole('button', { name: 'Save my layout', exact: true })).toBeDisabled();

    // Cards: collapsed behind one disclosure while the diagram is shown; mouse opens, keyboard closes.
    const cards = graph.getByRole('list', { name: 'Graph tasks and dependencies', exact: true });
    const showCards = graph.getByRole('button', { name: 'Show task cards and keyboard position controls (3)', exact: true });
    const hideCards = graph.getByRole('button', { name: 'Hide task cards and keyboard position controls (3)', exact: true });
    await expect(showCards).toHaveAttribute('aria-expanded', 'false'); await expect(cards).toBeHidden();
    await showCards.click();
    await expect(hideCards).toHaveAttribute('aria-expanded', 'true'); await expect(cards).toBeVisible(); await expect(cards.getByRole('listitem')).toHaveCount(3);
    const controls = await hideCards.getAttribute('aria-controls');
    expect(controls).toBeTruthy(); expect(await cards.evaluate((list, id) => list.closest(`[id="${id}"]`) !== null, controls)).toBe(true);
    await expect(hideCards).toBeFocused(); await page.keyboard.press('Space');
    await expect(showCards).toHaveAttribute('aria-expanded', 'false'); await expect(cards).toBeHidden();

    // Automatic layout follows with a viewport fit: zoom in until nodes leave the frame, then arrange.
    const zoomIn = diagram.getByRole('button', { name: 'Zoom in', exact: true });
    for (let i = 0; i < 6 && await zoomIn.isEnabled(); i++) { await zoomIn.click(); await settledViewport(diagram); }
    const zoomed = await graphState(diagram); evidence.zoomed = zoomed;
    expect(zoomed.nodes.some(item => !item.inside), 'zooming in must push a node outside the frame first').toBe(true);
    await graph.getByRole('button', { name: 'Apply automatic layout', exact: true }).click();
    await expect.poll(async () => (await graphState(diagram)).nodes.every(item => item.inside), { timeout: 10_000 }).toBe(true);
    await settledViewport(diagram);
    const arranged = await graphState(diagram); evidence.arranged = arranged;
    expect(arranged.nodes.every(item => item.inside)).toBe(true);
    expect(arranged.viewport?.zoom ?? Infinity).toBeLessThan(zoomed.viewport?.zoom ?? 0);

    expect(net.writes).toEqual([]); expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    const after = await Promise.all([a, b, c].map(task => f.task(task.id)));
    expect(after.map(dates)).toEqual(before.map(dates));
    await saveEvidence(info, `night-graph-${name}.json`, { ...evidence, initial, cancelled: net.cancelled });
  });

  test('weekly: the newest saved project report shows without any POST; an explicit saved run wins; Calculate current report sends one exact idempotent command whose lost acknowledgement is retried without a duplicate; pinned totals keep missing and zero distinct', async ({ page, request, baseURL }, info) => {
    test.setTimeout(150_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night weekly');
    const known = await f.createTask(`${f.token} known plan`, { estimateMinutes: 90 });
    const missing = await f.createTask(`${f.token} missing actual`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.other.id], estimateMinutes: 30 });
    const unknownPlan = await f.createTask(`${f.token} unknown plan`);
    const zeroPlan = await f.createTask(`${f.token} zero plan`);
    const period = await futurePeriod(f);
    for (const [task, member, minutes] of [[known, f.own, 90], [missing, f.other, 30], [unknownPlan, f.own, null], [zeroPlan, f.own, 0]] as const) {
      await f.post(`/periods/${period.id}/commitments`, { workPackageId: task.workPackageId, membershipId: member.id, expectedAbsent: true, plannedMinutes: minutes, allocations: minutes ? [{ taskId: task.id, minutes }] : [] }, periodCommitmentResponseSchema);
    }
    const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
    const baseline = (await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200)).data;
    const fact = (task: TaskDto, member: Daily['own'], minutes: number) => mutate(f, 'PUT', `/tasks/${task.id}/manual-period-work/${period.id}/${member.id}`, { expectedRevision: null, minutes, state: 'active' }, manualPeriodWorkLogResponseSchema);
    await fact(known, f.own, 60); await fact(unknownPlan, f.own, 0); await fact(zeroPlan, f.own, 15);
    const runAll = (await f.post('/report-runs', { baselineId: baseline.id, membershipIds: [], knownEstimatesOnly: false }, weeklyPlanFactReportRunResponseSchema)).data;
    const runOwn = (await f.post('/report-runs', { baselineId: baseline.id, membershipIds: [f.own.id], knownEstimatesOnly: false }, weeklyPlanFactReportRunResponseSchema)).data;
    // Fixture preconditions from the server, not from the page.
    expect(Date.parse(runOwn.createdAt)).toBeGreaterThan(Date.parse(runAll.createdAt));
    expect(runAll.summary).toMatchObject({ knownPlannedMinutes: 120, actualMinutes: 75, baselineCompleteness: { knownItemCount: 3, totalItemCount: 4 }, factCoverage: { recordedItemCount: 3, totalItemCount: 4 }, totalVarianceMinutes: null });
    expect(runOwn.summary).toMatchObject({ knownPlannedMinutes: 90, actualMinutes: 75, baselineCompleteness: { knownItemCount: 2, totalItemCount: 3 }, factCoverage: { recordedItemCount: 3, totalItemCount: 3 } });
    const runsPath = `${f.prefix}/report-runs`;
    // Report rows are titled by their work package; read those titles from the server instead of assuming them.
    const rowsResponse = await f.request.get(`${runsPath}/${runAll.id}/rows`); expect(rowsResponse.status(), await rowsResponse.text()).toBe(200);
    const serverRows = weeklyPlanFactRowListResponseSchema.parse(await rowsResponse.json()).data;
    const rowTitle = new Map(serverRows.map(item => [item.workPackageId, item.title]));
    expect(serverRows).toHaveLength(4); expect(new Set(rowTitle.values()).size).toBe(4);
    expect(serverRows.filter(item => !item.factRecorded).map(item => item.workPackageId)).toEqual([missing.workPackageId]);
    const net = watch(page); const evidence: Record<string, unknown> = { runAll: runAll.id, runOwn: runOwn.id, baseline: baseline.id };

    const saved = page.getByRole('region', { name: 'Saved report', exact: true });
    const metric = (label: string) => saved.locator('dl > div').filter({ has: page.getByText(label, { exact: true }) });
    const row = (task: TaskDto) => page.getByRole('row').filter({ has: page.getByText(rowTitle.get(task.workPackageId) ?? `missing row for ${task.title}`, { exact: true }) });
    const cell = (task: TaskDto, column: 'plan' | 'actual') => row(task).getByRole('cell').nth(column === 'plan' ? 1 : 2);
    const missingSection = page.getByRole('region', { name: 'Baseline work without actual hours', exact: true });
    const selector = page.getByRole('combobox', { name: 'Saved report', exact: true });
    const runParam = () => new URL(page.url()).searchParams.get('run');

    // 1. No run in the URL: the newest saved project report is displayed, read-only, without a POST.
    await page.goto(`${f.path}/week?period=${period.id}&view=report`);
    await expect(saved).toBeVisible();
    await expect(saved).toContainText('Latest project report');
    await saved.locator('summary').filter({ hasText: 'About this saved report' }).click();
    await expect(saved.getByText('Showing the newest saved report for the project baseline. Choose a saved report to pin a different one.', { exact: true })).toBeVisible();
    await expect(metric('Known planned hours').locator('dd')).toHaveText('1h 30m'); await expect(metric('Known planned hours')).toContainText('Known: 2 of 3');
    await expect(metric('Actual hours for baseline work').locator('dd')).toHaveText('1h 15m'); await expect(metric('Actual hours for baseline work')).toContainText('Recorded: 3 of 3');
    await expect(missingSection).toContainText('Every baseline item had actual hours as of');
    // Unknown plan vs zero plan; recorded zero actual is a value, not missing.
    await expect(cell(unknownPlan, 'plan')).toHaveText('Not set'); await expect(cell(unknownPlan, 'actual')).toHaveText('0m');
    await expect(cell(zeroPlan, 'plan')).toHaveText('0m'); await expect(cell(zeroPlan, 'actual')).toHaveText('15m');
    await expect(cell(known, 'plan')).toHaveText('1h 30m'); await expect(cell(known, 'actual')).toHaveText('1h');
    await expect(row(missing)).toHaveCount(0);
    expect(runParam()).toBeNull(); expect(net.writes).toEqual([]);

    // 2. An explicit saved run wins over the newest one, also after reload.
    const initialRunsResponse = await f.request.get(runsPath, { params: { periodId: period.id } });
    expect(initialRunsResponse.status()).toBe(200);
    const initialRuns = weeklyPlanFactReportRunListResponseSchema.parse(await initialRunsResponse.json()).data;
    await chooseIndex(page, 'Saved report', initialRuns.findIndex(run => run.id === runAll.id) + 1);
    await expect.poll(runParam).toBe(runAll.id);
    await saved.locator('summary').filter({ hasText: 'About this saved report' }).click();
    await expect(saved.getByText('Showing the selected saved report.', { exact: true })).toBeVisible(); await expect(saved).not.toContainText('Latest project report');
    const showsRunAll = async () => {
      await expect(metric('Known planned hours').locator('dd')).toHaveText('2h'); await expect(metric('Known planned hours')).toContainText('Known: 3 of 4');
      await expect(metric('Actual hours for baseline work').locator('dd')).toHaveText('1h 15m'); await expect(metric('Actual hours for baseline work')).toContainText('Recorded: 3 of 4');
      await expect(metric('Baseline difference').locator('dd')).toHaveText('Insufficient data');
      await expect(missingSection).toContainText(/1 of 4 baseline items had no actual-hours entry\. Missing is not zero\./);
      await expect(missingSection.getByRole('list', { name: 'Missing actual hours by person', exact: true })).toHaveText(`${f.other.displayName}: 1`);
      await expect(cell(missing, 'plan')).toHaveText('30m'); await expect(cell(missing, 'actual')).toHaveText('Not recorded');
      await expect(cell(unknownPlan, 'actual')).toHaveText('0m');
    };
    await showsRunAll();
    await page.reload(); await expect(saved).toBeVisible(); expect(runParam()).toBe(runAll.id); await expect(selector).not.toContainText('Latest project report');
    await showsRunAll();
    expect(net.writes).toEqual([]);

    // Hours recorded after the saved runs never change them: the pinned run still shows the missing entry.
    await fact(missing, f.other, 30);
    await page.reload(); await expect(saved).toBeVisible(); await showsRunAll();

    // 3. Calculate current report: one exact command; its acknowledgement is lost after a real commit.
    const attempts: { body: string | null; key: string | undefined; status?: number; runId?: string }[] = [];
    net.expect((method, path) => method === 'POST' && path === runsPath && attempts.length === 1);
    await page.route(`**${runsPath}`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const attempt: (typeof attempts)[number] = { body: route.request().postData(), key: route.request().headers()['idempotency-key'] };
      attempts.push(attempt);
      const response = await route.fetch(); attempt.status = response.status();
      attempt.runId = weeklyPlanFactReportRunResponseSchema.safeParse(await response.json().catch(() => null)).data?.data.id;
      if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
    });
    try {
      const calculate = page.getByRole('button', { name: 'Calculate current report', exact: true });
      await calculate.click();
      const setup = page.getByRole('region', { name: 'New report settings', exact: true });
      const retry = setup.getByRole('button', { name: 'Retry original save', exact: true });
      await expect(retry).toBeVisible(); await expect(calculate).toBeDisabled();
      expect(attempts).toHaveLength(1);
      expect(JSON.parse(attempts[0]?.body ?? 'null')).toEqual({ baselineId: baseline.id, knownEstimatesOnly: false, membershipIds: [] });
      expect(attempts[0]?.key).toBeTruthy(); expect(attempts[0]?.status).toBe(201); expect(attempts[0]?.runId).toBeTruthy();
      await retry.click();
      await expect.poll(() => attempts.length).toBe(2);
      await expect.poll(runParam).toBe(attempts[0]?.runId ?? 'missing');
    } finally { await page.unroute(`**${runsPath}`); }
    const [first, second] = attempts;
    expect(second?.body).toBe(first?.body); expect(second?.key).toBe(first?.key);
    expect([200, 201]).toContain(second?.status); expect(second?.runId).toBe(first?.runId);
    evidence.attempts = attempts; evidence.plannedFailures = net.plannedFailures;

    // The new run is pinned to the hours recorded now, and the earlier runs are untouched.
    await saved.locator('summary').filter({ hasText: 'About this saved report' }).click();
    await expect(saved.getByText('Showing the selected saved report.', { exact: true })).toBeVisible();
    await expect(metric('Known planned hours').locator('dd')).toHaveText('2h');
    await expect(metric('Actual hours for baseline work').locator('dd')).toHaveText('1h 45m'); await expect(metric('Actual hours for baseline work')).toContainText('Recorded: 4 of 4');
    await expect(missingSection).toContainText('Every baseline item had actual hours as of');
    await expect(cell(missing, 'actual')).toHaveText('30m'); await expect(cell(unknownPlan, 'plan')).toHaveText('Not set'); await expect(cell(zeroPlan, 'plan')).toHaveText('0m');
    const listed = await f.request.get(runsPath, { params: { periodId: period.id } }); expect(listed.status(), await listed.text()).toBe(200);
    const runs = weeklyPlanFactReportRunListResponseSchema.parse(await listed.json()).data;
    expect(runs.map(run => run.id).sort()).toEqual([runAll.id, runOwn.id, first?.runId ?? 'missing'].sort());
    const pinned = await f.request.get(`${runsPath}/${runAll.id}`); expect(pinned.status()).toBe(200);
    expect(weeklyPlanFactReportRunResponseSchema.parse(await pinned.json()).data.summary).toMatchObject({ actualMinutes: 75, factCoverage: { recordedItemCount: 3, totalItemCount: 4 } });

    expect(net.writes).toEqual([{ method: 'POST', path: runsPath }, { method: 'POST', path: runsPath }]);
    expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    await saveEvidence(info, `night-weekly-${name}.json`, { ...evidence, runs: runs.map(run => ({ id: run.id, createdAt: run.createdAt })), cancelled: net.cancelled });
  });
  test('organizing: fixed rows survive exact root section moves, collapsed destinations reopen, an unknown committed move retries unchanged, and child navigation preserves a parent draft', async ({ page, request, baseURL }, info) => {
    test.setTimeout(150_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night organize');
    const destination = (await f.post(`/projects/${f.project.id}/sections`, { name: 'Destination', position: 1 }, sectionResponseSchema)).data;
    const root = await f.createTask(`${f.token} movable root`, { estimateMinutes: 90 });
    const child = await f.createTask(`${f.token} detail child`, { parentTaskId: root.id, workScope: 'detail', statusId: f.progress.id });
    const additional = await f.createTask(`${f.token} additional child`, { parentTaskId: root.id, workScope: 'added_scope', estimateMinutes: 30 });
    const peer = await f.createTask(`${f.token} destination peer`, { sectionId: destination.id });
    expect(child.workPackageId).toBe(root.workPackageId); expect(additional.workPackageId).not.toBe(root.workPackageId);
    const net = watch(page), snapshots: Record<string, unknown> = {};
    const taskPath = `${f.prefix}/tasks/${root.id}`;
    const moves: { body: string | null; key: string | undefined; status?: number; revision?: number }[] = [];
    let lose = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    net.expect((method, path) => method === 'PATCH' && path === taskPath && lose);
    await page.route(`**${taskPath}`, async route => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const attempt: (typeof moves)[number] = { body: route.request().postData(), key: route.request().headers()['idempotency-key'] };
      moves.push(attempt);
      const response = await route.fetch(); attempt.status = response.status();
      attempt.revision = taskResponseSchema.safeParse(await response.json()).data?.data.revision;
      if (lose && moves.length === 2) { await held; await route.abort('connectionreset'); } else await route.fulfill({ response });
    });
    const move = page.getByRole('button', { name: `Move “${root.title}” to another section`, exact: true });
    const rootRow = page.locator(`[data-task-row="${root.id}"]`);
    const group = (sectionName: string) => page.getByRole('button', { name: `Collapse section “${sectionName}”`, exact: true }).locator('xpath=ancestor::tbody');
    const openMove = async () => {
      await rootRow.hover(); await move.click();
      // The inline section editor opens its ChoicePicker immediately.
      await expect(page.getByRole('listbox', { name: 'Section', exact: true })).toBeVisible();
    };
    try {
      await page.goto(f.path); await expect(openTask(page, root)).toBeVisible();
      const expand = page.getByRole('button', { name: `Expand subtasks of “${root.title}”`, exact: true });
      if (await expand.isVisible()) await expand.click();
      await expect(openTask(page, child)).toBeVisible();
      const before = await tableGeometry(page); expectFixedGrid(before, before); snapshots.before = before;
      await openMove(); snapshots.edit = await tableGeometry(page); expectFixedGrid(before, await tableGeometry(page));
      await page.getByRole('listbox', { name: 'Section', exact: true }).getByRole('option', { name: 'QA section', exact: true }).click();
      await expect(page.getByRole('listbox', { name: 'Section', exact: true })).toHaveCount(0);
      expect(moves).toHaveLength(0); expect(net.writes).toEqual([]);
      await page.getByRole('button', { name: 'Collapse section “Destination”', exact: true }).click();
      await expect(openTask(page, peer)).toHaveCount(0);
      await openMove(); await page.getByRole('listbox', { name: 'Section', exact: true }).getByRole('option', { name: 'Destination', exact: true }).click();
      await expect(group('Destination').locator(`[data-task-row="${root.id}"]`)).toBeVisible();
      await expect(group('Destination').locator(`[data-task-row="${child.id}"]`)).toBeVisible();
      await expect(group('Destination').locator(`[data-task-row="${additional.id}"]`)).toBeVisible();
      await expect(page.getByText(`Moved “${root.title}” to Destination.`, { exact: true })).toBeVisible();
      const fresh = await f.task(root.id); expect(fresh.revision).toBe(root.revision + 1); expect(fresh.sectionId).toBe(destination.id);
      expect(JSON.parse(moves[0]?.body ?? 'null')).toEqual({ expectedRevision: root.revision, sectionId: destination.id });
      snapshots.afterFirst = await tableGeometry(page); expectFixedGrid(before, await tableGeometry(page));

      lose = true; await openMove(); await page.getByRole('listbox', { name: 'Section', exact: true }).getByRole('option', { name: 'QA section', exact: true }).click();
      await expect.poll(() => moves[1]?.status).toBe(200);
      snapshots.pending = await tableGeometry(page); expectFixedGrid(before, await tableGeometry(page));
      const committed = await f.task(root.id); expect(committed.sectionId).toBe(f.section.id); expect(committed.revision).toBe(root.revision + 2);
      expect(JSON.parse(moves[1]?.body ?? 'null')).toEqual({ expectedRevision: fresh.revision, sectionId: f.section.id });
      release();
      const retry = rootRow.getByRole('button', { name: 'Retry', exact: true }); await expect(retry).toBeVisible();
      await page.getByRole('button', { name: `Edit status for ${peer.title}`, exact: true }).click();
      await expect(page.getByRole('listbox', { name: 'Status', exact: true })).toHaveCount(0); expect(moves).toHaveLength(2);
      snapshots.unknown = await tableGeometry(page); expectFixedGrid(before, await tableGeometry(page));
      await retry.click();
      await expect(group('QA section').locator(`[data-task-row="${root.id}"]`)).toBeVisible();
      await expect(group('QA section').locator(`[data-task-row="${child.id}"]`)).toBeVisible();
      expect(moves).toHaveLength(3); expect(moves[2]?.body).toBe(moves[1]?.body); expect(moves[2]?.key).toBe(moves[1]?.key); expect(moves[1]?.key).toBeTruthy();
      expect(moves[2]?.revision).toBe(committed.revision); expect(await f.task(root.id)).toEqual(committed);
      snapshots.after = await tableGeometry(page); expectFixedGrid(before, await tableGeometry(page));

      await openTaskDrawer(page, root);
      const drawer = page.getByRole('dialog', { name: root.title, exact: true }); await expect(drawer).toBeVisible();
      const title = drawer.getByRole('textbox', { name: 'Task name', exact: true }); await title.fill(`${root.title} unsent`);
      const children = drawer.getByRole('region', { name: 'Subtasks', exact: true });
      await expect(children.getByRole('button', { name: `Open subtask “${child.title}” · ${f.progress.name} · Detail`, exact: true })).toBeVisible();
      const addedLink = children.getByRole('button', { name: `Open subtask “${additional.title}” · ${f.todo.name} · Additional work`, exact: true });
      await expect(addedLink).toBeVisible(); await addedLink.click();
      const childDrawer = page.getByRole('dialog', { name: additional.title, exact: true }); await expect(childDrawer).toBeVisible();
      await childDrawer.getByRole('button', { name: 'Open parent', exact: true }).click();
      await expect(title).toHaveValue(`${root.title} unsent`); await expect(drawer).toContainText('Your unsaved draft has been restored.');
      expect((await f.task(root.id)).title).toBe(root.title);
      expect(net.writes).toEqual(Array.from({ length: 3 }, () => ({ method: 'PATCH', path: taskPath })));
      expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
      await saveEvidence(info, `night-organizing-${name}.json`, { snapshots, moves, plannedFailures: net.plannedFailures, cancelled: net.cancelled });
    } finally { release(); await page.unroute(`**${taskPath}`); }
  });

  test('drawer originals: captured zero and original unknown survive later unprotected estimate fills; detail children share the same original and viewing sends no command', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night originals');
    let zero = await f.createTask(`${f.token} captured zero`, { estimateMinutes: 0 });
    let unknown = await f.createTask(`${f.token} unknown original`);
    const child = await f.createTask(`${f.token} same package child`, { parentTaskId: unknown.id, workScope: 'detail', statusId: f.progress.id });
    const period = await futurePeriod(f);
    for (const task of [zero, unknown]) await f.post(`/periods/${period.id}/commitments`, { workPackageId: task.workPackageId, membershipId: f.own.id, expectedAbsent: true, plannedMinutes: 0, allocations: [] }, periodCommitmentResponseSchema);
    const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
    await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200);
    const original = async (task: TaskDto) => {
      const response = await f.request.get(`${f.prefix}/planning-packages/${task.workPackageId}/original-estimate`); expect(response.status()).toBe(200);
      return originalPackageEstimateResponseSchema.parse(await response.json()).data;
    };
    const firstZero = await original(zero), firstUnknown = await original(unknown);
    expect(firstZero).toMatchObject({ state: 'captured', estimateMinutes: 0, origin: { scope: 'self', mode: 'manual' } });
    expect(firstUnknown).toMatchObject({ state: 'original_unknown', estimateMinutes: null });
    zero = await f.task(zero.id); unknown = await f.task(unknown.id);
    zero = (await mutate(f, 'PATCH', `/tasks/${zero.id}`, { expectedRevision: zero.revision, expectedWorkPackageRevision: zero.workPackageRevision, estimateMinutes: 180 }, taskResponseSchema)).data;
    unknown = (await mutate(f, 'PATCH', `/tasks/${unknown.id}`, { expectedRevision: unknown.revision, expectedWorkPackageRevision: unknown.workPackageRevision, estimateMinutes: 120 }, taskResponseSchema)).data;
    expect(await original(zero)).toEqual(firstZero); expect(await original(unknown)).toEqual(firstUnknown); expect(await original(child)).toEqual(firstUnknown);
    const net = watch(page), reads: string[] = [];
    page.on('request', q => { if (q.method() === 'GET' && new URL(q.url()).pathname.endsWith('/original-estimate')) reads.push(new URL(q.url()).pathname); });
    await page.goto(`${f.path}?task=${zero.id}`);
    const show = async (task: TaskDto, current: string, captured: boolean) => {
      const drawer = page.getByRole('dialog', { name: task.title, exact: true }); await expect(drawer).toBeVisible();
      await expect(drawer.getByRole('region', { name: 'Current shared estimate', exact: true })).toContainText(current);
      const originalRegion = drawer.getByRole('region', { name: 'Original estimate', exact: true });
      if (captured) { await expect(originalRegion.getByText('0m', { exact: true })).toBeVisible(); await expect(originalRegion).toContainText('Locked at first freeze'); }
      else { await expect(originalRegion).toContainText('Unknown'); await expect(originalRegion).toContainText('Not set at first freeze'); await expect(originalRegion).toContainText('A later estimate is not treated as the original.'); }
      await expect(originalRegion).toContainText('Personal plan freeze'); await expect(originalRegion).toContainText('Saved manually');
      return drawer;
    };
    let drawer = await show(zero, '3h', true); await drawer.locator('button[aria-label="Close"]').click();
    await openTaskDrawer(page, unknown); drawer = await show(unknown, '2h', false);
    await drawer.getByRole('region', { name: 'Subtasks', exact: true }).getByRole('button', { name: `Open subtask “${child.title}” · ${f.progress.name} · Detail`, exact: true }).click();
    await show(child, '2h', false);
    expect(reads).toContain(`${f.prefix}/planning-packages/${zero.workPackageId}/original-estimate`);
    expect(reads).toContain(`${f.prefix}/planning-packages/${unknown.workPackageId}/original-estimate`);
    expect(await original(zero)).toEqual(firstZero); expect(await original(child)).toEqual(firstUnknown);
    expect(net.writes).toEqual([]); expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    await saveEvidence(info, `night-originals-${name}.json`, { firstZero, firstUnknown, reads, cancelled: net.cancelled });
  });

});

for (const [name, size] of viewports.filter(([name]) => name !== 'medium')) test.describe(`Night shared flows ${name}`, () => {
  test.use({ viewport: size });

  test('meeting: five explicit draft plans require preview/apply; actual details require save; full-attendance preparation preserves saved exceptions and dirty drafts; lost batch acknowledgement retries exactly to 210 minutes', async ({ page, request, baseURL }, info) => {
    test.setTimeout(180_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night meeting');
    const people = [f.own, ...f.members.filter(member => member.id !== f.own.id && member.role !== 'viewer').slice(0, 4)];
    expect(people).toHaveLength(5);
    const period = await futurePeriod(f);
    const created = (await f.post(`/projects/${f.project.id}/meetings`, { title: `${f.token} shared call`, statusId: f.todo.id, sectionId: f.section.id, plannedPeriodId: period.id,
      plannedStartAt: '2027-05-04T10:00:00.000Z', timezone: 'Asia/Nicosia', plannedDurationMinutes: 60, organizerMembershipId: f.own.id, attendeeMembershipIds: people.map(person => person.id) }, meetingCreationResponseSchema)).data;
    const taskPath = `${f.prefix}/tasks/${created.task.id}`, planPath = `${taskPath}/meeting-plan`, previewPath = `${taskPath}/meeting-plan-preview`, attendancePath = `${taskPath}/attendance/confirm`;
    const net = watch(page), submitted: { path: string; body: unknown }[] = [];
    page.on('request', q => { if (q.method() === 'POST') submitted.push({ path: new URL(q.url()).pathname, body: q.postDataJSON() }); });
    const attendance = async () => {
      const response = await f.request.get(`${taskPath}/attendance`); expect(response.status()).toBe(200);
      return meetingAttendanceListResponseSchema.parse(await response.json()).data;
    };
    await page.goto(`${f.path}?task=${created.task.id}&week=${period.id}`);
    const drawer = page.getByRole('dialog', { name: created.task.title, exact: true }); await expect(drawer).toBeVisible();
    await drawer.getByRole('tab', { name: 'Personal plan', exact: true }).click();
    await drawer.getByRole('button', { name: 'Select everyone you can plan · 1h each', exact: true }).click();
    await expect(drawer.getByText('Selected: 5 of 5', { exact: true })).toBeVisible();
    for (const person of people) await expect(drawer.getByRole('checkbox', { name: person.displayName, exact: true })).toBeChecked();
    const plannedInputs = drawer.getByLabel('Meeting planned hours', { exact: true }); await expect(plannedInputs).toHaveCount(5);
    for (const input of await plannedInputs.all()) await expect(input).toHaveValue('1:00');
    expect(net.writes).toEqual([]);
    const previewResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === previewPath);
    await drawer.getByRole('button', { name: 'Preview personal plans', exact: true }).click();
    const preview = await previewResponse; expect(preview.status()).toBe(200);
    const previewData = meetingPlanPreviewResponseSchema.parse(await preview.json()).data;
    expect(previewData.rows.map(row => [row.membershipId, row.plannedMinutes]).sort()).toEqual(people.map(person => [person.id, 60]).sort());
    await expect(drawer.getByRole('heading', { name: 'Review before applying', exact: true })).toBeVisible();
    expect(submitted.filter(row => row.path === planPath)).toHaveLength(0);
    const planResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === planPath);
    await drawer.getByRole('button', { name: 'Apply personal plans', exact: true }).click();
    const appliedResponse = await planResponse; expect(appliedResponse.status()).toBe(200);
    const applied = meetingPlanResultResponseSchema.parse(await appliedResponse.json()).data;
    expect(applied.commitments).toHaveLength(5); expect(applied.commitments.map(row => row.plannedMinutes)).toEqual([60, 60, 60, 60, 60]);

    await drawer.getByRole('tab', { name: 'Attendance', exact: true }).click();
    const team = drawer.getByRole('region', { name: 'Team attendance', exact: true });
    const everyone = team.getByRole('button', { name: 'Everyone attended · prepare review', exact: true });
    await expect(everyone).toBeDisabled(); await expect(drawer.getByLabel('Actual start', { exact: true })).toHaveValue('');
    await drawer.getByRole('button', { name: 'Meeting followed the plan · fill details', exact: true }).click();
    await expect(drawer.getByLabel('Actual duration, minutes', { exact: true })).toHaveValue('60');
    await expect(everyone).toBeDisabled();
    expect(submitted.filter(row => row.path === attendancePath)).toHaveLength(0);
    const actualResponse = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `${taskPath}/meeting`);
    await drawer.getByRole('button', { name: 'Save actual details', exact: true }).click();
    const actualSaved = await actualResponse; expect(actualSaved.status()).toBe(200);
    const actual = meetingResponseSchema.parse(await actualSaved.json()).data;
    expect(actual).toMatchObject({ actualStartAt: created.meeting.plannedStartAt, actualDurationMinutes: 60 });
    await expect(everyone).toBeEnabled();

    // Two saved exceptions use the supported API, after actual details are explicitly saved in the UI.
    // Reloading is clean because no attendance draft has been typed yet.
    const rows = await attendance(); const partialPerson = people[3], absentPerson = people[4];
    if (!partialPerson || !absentPerson) throw Error('Five-person roster required');
    const partial = rows.find(row => row.membershipId === partialPerson.id), absent = rows.find(row => row.membershipId === absentPerson.id);
    if (!partial || !absent) throw Error('Two exception attendance identities required');
    const seeded = (await f.post(`/tasks/${created.task.id}/attendance/confirm`, { expectedMeetingRevision: actual.revision, periodId: period.id, rows: [
      { attendanceId: partial.id, expectedAttendanceRevision: partial.revision, expectedWorkLogRevision: null, kind: 'confirm', status: 'partial', attributionBasis: 'actual_meeting', minutes: 30, reason: null },
      { attendanceId: absent.id, expectedAttendanceRevision: absent.revision, expectedWorkLogRevision: null, kind: 'confirm', status: 'absent', attributionBasis: 'planned_absence', minutes: 0, reason: null },
    ] }, attendancePostingResponseSchema, 200)).data;
    await page.reload(); await expect(drawer).toBeVisible(); await drawer.getByRole('tab', { name: 'Attendance', exact: true }).click();
    const individual = drawer.getByRole('region', { name: 'Individual attendance', exact: true });
    await choose(page, 'Whose attendance', f.own.displayName);
    const comment = individual.getByLabel('Attendance comment (optional)', { exact: true }); await comment.fill('Keep this separate unsent draft');
    const postsBeforePreparation = submitted.filter(row => row.path === attendancePath).length;
    await everyone.click();
    await expect(team.getByRole('status')).toContainText('2 people are prepared for review. Nothing is saved yet.');
    await expect(team.getByRole('status')).toContainText('1 person with your own unsent changes was left as is');
    await expect(comment).toHaveValue('Keep this separate unsent draft');
    await expect(team.getByRole('checkbox', { name: f.own.displayName, exact: true })).not.toBeChecked();
    await expect(team.getByRole('checkbox', { name: partialPerson.displayName, exact: true })).not.toBeChecked();
    await expect(team.getByRole('checkbox', { name: absentPerson.displayName, exact: true })).not.toBeChecked();
    expect(submitted.filter(row => row.path === attendancePath)).toHaveLength(postsBeforePreparation);
    // Explicitly discard that draft and its prepared selection, then prepare all three unconfirmed people.
    await drawer.getByRole('tab', { name: 'Meeting', exact: true }).click();
    await drawer.getByRole('button', { name: 'Discard meeting draft', exact: true }).click();
    await drawer.getByRole('tab', { name: 'Attendance', exact: true }).click();
    await everyone.click(); await expect(team.getByRole('status')).toContainText('3 people are prepared for review. Nothing is saved yet.');
    await expect(team.getByRole('region', { name: 'Review team attendance', exact: true })).toContainText('Rows to save: 3. Confirmed time: 3h.');
    expect(submitted.filter(row => row.path === attendancePath)).toHaveLength(postsBeforePreparation);
    const attempts: { body: string | null; key: string | undefined; status?: number; result?: unknown }[] = [];
    net.expect((method, path) => method === 'POST' && path === attendancePath);
    await page.route(`**${attendancePath}`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const attempt: (typeof attempts)[number] = { body: route.request().postData(), key: route.request().headers()['idempotency-key'] }; attempts.push(attempt);
      const response = await route.fetch(); attempt.status = response.status(); attempt.result = attendancePostingResponseSchema.parse(await response.json()).data;
      if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
    });
    try {
      await team.getByRole('button', { name: 'Confirm team attendance', exact: true }).click();
      const retry = team.getByRole('button', { name: 'Retry original team attendance', exact: true }); await expect(retry).toBeVisible();
      expect(attempts).toHaveLength(1); expect(attempts[0]?.status).toBe(200); expect(attempts[0]?.key).toBeTruthy();
      const input = JSON.parse(attempts[0]?.body ?? 'null') as { rows: { attendanceId: string; minutes: number; status: string }[] };
      expect(input.rows).toHaveLength(3); expect(input.rows.every(row => row.status === 'present' && row.minutes === 60)).toBe(true);
      expect(input.rows.map(row => row.attendanceId).sort()).toEqual(rows.filter(row => ![partial.id, absent.id].includes(row.id)).map(row => row.id).sort());
      await expect(everyone).toBeDisabled(); await retry.click(); await expect.poll(() => attempts.length).toBe(2);
      await expect(drawer.getByText('Team attendance saved.', { exact: true })).toBeVisible();
    } finally { await page.unroute(`**${attendancePath}`); }
    expect(attempts[1]?.body).toBe(attempts[0]?.body); expect(attempts[1]?.key).toBe(attempts[0]?.key); expect(attempts[1]?.result).toEqual(attempts[0]?.result);
    const final = await attendance(); expect(final).toHaveLength(5);
    expect(final.reduce((sum, row) => sum + (row.minutes ?? 0), 0)).toBe(210);
    expect(final.map(row => row.membershipId).sort()).toEqual(people.map(person => person.id).sort());
    expect(final.every(row => row.postingState === 'active' && row.workLog?.revision === 1)).toBe(true);
    for (const row of seeded.attendances.filter(row => row.id === partial.id || row.id === absent.id)) expect(final.find(current => current.id === row.id)).toEqual(row);
    const workResponse = await f.request.get(`${f.prefix}/recorded-work`, { params: { periodId: period.id, taskId: created.task.id } }); expect(workResponse.status()).toBe(200);
    const work = recordedWorkListResponseSchema.parse(await workResponse.json()).data;
    expect(work).toHaveLength(5); expect(new Set(work.map(row => row.membershipId)).size).toBe(5); expect(new Set(work.map(row => row.id)).size).toBe(5);
    expect(work.reduce((sum, row) => sum + row.minutes, 0)).toBe(210);
    expect(net.writes).toEqual([{ method: 'POST', path: previewPath }, { method: 'POST', path: planPath }, { method: 'PATCH', path: `${taskPath}/meeting` }, { method: 'POST', path: attendancePath }, { method: 'POST', path: attendancePath }]);
    expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    await saveEvidence(info, `night-meeting-${name}.json`, { applied, actual, seeded, attempts, final, work, plannedFailures: net.plannedFailures, cancelled: net.cancelled });
  });

  test('gantt connectors: actual SVG endpoints meet actual range and rotated diamond edges within 1.5px through baseline rows, resize and real scroll; denial clears arrows', async ({ page, request, baseURL }, info) => {
    test.setTimeout(150_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Night connectors');
    const a = await f.createTask(`${f.token} range predecessor`, { startDate: '2027-05-03', dueDate: '2027-05-05', estimateMinutes: 60 });
    const b = await f.createTask(`${f.token} range successor`, { startDate: '2027-05-06', dueDate: '2027-05-08', estimateMinutes: 60 });
    const dueOnly = await f.createTask(`${f.token} due-only predecessor`, { dueDate: '2027-05-09', estimateMinutes: 60 });
    const startOnly = await f.createTask(`${f.token} start-only successor`, { startDate: '2027-05-10', estimateMinutes: 60 });
    const conflict = await f.createTask(`${f.token} conflicting successor`, { startDate: '2027-05-04', dueDate: '2027-05-07', estimateMinutes: 60 });
    const link = async (from: TaskDto, to: TaskDto) => ({ id: (await f.post('/dependencies', { predecessorTaskId: from.id, successorTaskId: to.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data.id, from: from.id, to: to.id });
    const links = [await link(a, b), await link(dueOnly, startOnly), await link(a, conflict)];
    const period = await futurePeriod(f);
    for (const task of [a, b, dueOnly, startOnly, conflict]) await f.post(`/periods/${period.id}/commitments`, { workPackageId: task.workPackageId, membershipId: f.own.id, expectedAbsent: true, plannedMinutes: 60, allocations: [{ taskId: task.id, minutes: 60 }] }, periodCommitmentResponseSchema);
    const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
    const baseline = (await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200)).data;
    const before = await Promise.all([a, b, dueOnly, startOnly, conflict].map(task => f.task(task.id)));
    const net = watch(page), frames: Record<string, unknown> = {};
    await page.goto(`${f.path}?view=gantt`);
    const timeline = page.getByRole('region', { name: 'Project timeline', exact: true });
    const calendar = timeline.locator('[aria-label="Loaded task calendar"]');
    await expect(calendar.locator('[data-gantt-connectors] [data-dependency-id]')).toHaveCount(3);
    frames.current = await expectConnectors(calendar, links);
    expect((await connectorGeometry(calendar, links)).map(row => row.state)).toEqual(['compatible', 'compatible', 'conflict']);
    await timeline.getByRole('button', { name: 'Compare with frozen plan', exact: true }).click();
    await timeline.getByRole('combobox', { name: 'Plan period', exact: true }).selectOption(period.id);
    await timeline.getByRole('combobox', { name: 'Frozen plan to compare', exact: true }).selectOption(baseline.id);
    await expect(timeline.getByRole('img', { name: /^Frozen: / })).toHaveCount(5);
    frames.baseline = await expectConnectors(calendar, links);
    await page.setViewportSize({ width: size.width === 1440 ? 1024 : 430, height: size.height });
    frames.resized = await expectConnectors(calendar, links);
    await calendar.hover(); await page.mouse.wheel(450, 0);
    await expect.poll(() => calendar.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    frames.scrolled = await expectConnectors(calendar, links);
    const layers = await calendar.evaluate(scroller => {
      const row = scroller.querySelector('[data-gantt-row]'), sticky = row?.firstElementChild;
      const svg = scroller.querySelector('[data-gantt-connectors]');
      const current = row?.querySelector('[data-gantt-anchor] [role="img"]');
      const r = sticky?.getBoundingClientRect(), f = scroller.getBoundingClientRect();
      return { stickyLeft: r?.left, frameLeft: f.left, stickyZ: sticky ? Number(getComputedStyle(sticky).zIndex) : null, arrowZ: svg ? Number(getComputedStyle(svg).zIndex) : null, barZ: current ? Number(getComputedStyle(current).zIndex) : null, pointer: svg ? getComputedStyle(svg).pointerEvents : null };
    });
    expect(Math.abs((layers.stickyLeft ?? Infinity) - layers.frameLeft)).toBeLessThanOrEqual(1.5);
    expect(layers.stickyZ).toBeGreaterThan(layers.arrowZ ?? Infinity); expect(layers.barZ).toBeGreaterThan(layers.arrowZ ?? Infinity); expect(layers.pointer).toBe('none');
    const contextPath = `${f.prefix}/projects/${f.project.id}/schedule-context`;
    net.expect((method, path) => method === 'GET' && path === contextPath);
    await page.route(`**${contextPath}**`, async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Night connector read denial', retryable: false }, meta: { requestId: f.token } }) });
    });
    try {
      const personalBaseline = baseline.snapshot.sourcePersonalBaselineIds[0];
      if (!personalBaseline) throw Error('A real personal baseline is required to trigger a changed comparison read');
      // A native comparison choice starts a fresh denied read while the old rendered arrows exist.
      await timeline.getByRole('combobox', { name: 'Frozen plan to compare', exact: true }).selectOption(personalBaseline);
      await expect.poll(() => net.plannedFailures.some(failure => failure.endsWith(' 403'))).toBe(true);
      await expect(page.locator('[data-gantt-connectors]')).toHaveCount(0);
      await expect(timeline.getByRole('img', { name: /^Current: / })).toHaveCount(0);
      await expect(timeline.getByRole('img', { name: /^Frozen: / })).toHaveCount(0);
      await expect.poll(() => net.plannedFailures.some(failure => failure.endsWith(' 403'))).toBe(true);
    } finally { await page.unroute(`**${contextPath}**`); }
    expect((await Promise.all([a, b, dueOnly, startOnly, conflict].map(task => f.task(task.id)))).map(dates)).toEqual(before.map(dates));
    expect(net.writes).toEqual([]); expectClean(net); expect(await overflow(page)).toBeLessThanOrEqual(0);
    await saveEvidence(info, `night-connectors-${name}.json`, { frames, layers, plannedFailures: net.plannedFailures, cancelled: net.cancelled });
  });
});
