// Daily entry recovery prepared in source. Execute only in the coordinator's compiled window
// (tests/e2e/daily-entry-recovery.config.ts, explicit WORKLOOM_QA_BASE_URL); no result is claimed from source.
//
// Intended contract (labels agreed with the concurrent source owners; current English catalogs otherwise):
// A. Week task catalog: a real 503 on this project's task catalog (GET /tasks?projectId=…&includeArchived=true) never
//    hides the selected week/person, the saved personal plan or "Record actual hours". The open fact dialog keeps typed
//    hours/comment editable while its native Task select and Save stay disabled, with a dialog-local role=alert
//    "Could not load tasks. Your entry is kept." and an explicit "Retry loading tasks". The page behind the modal is
//    inert, so while it is open the selection is read from the dialog's "Time entry context" and the URL only.
//    The retry shows "Loading tasks…" while the real answer is held; only after it arrives can a task be chosen and the
//    explicit Save sends one real PUT. "Retry loading more tasks" (next page) is covered by source tests only.
// B. Filtered-out quick create: only after a confirmed create while filters are active, one role=status notice
//    "Task “<title>” created. Your filters are still applied." with an explicit "Open details". No automatic drawer,
//    focus move, navigation or injected filtered row; pending/unknown outcomes never show it. Clicking "Retry original"
//    may move focus; while the real replay answer is held the person refocuses and reselects the next buffer, and the
//    confirmation keeps exactly that element, value, focus, selection and scroll. Open details closes the quick row;
//    after closing the drawer an explicit "Add task to …" click remounts the retained, still unsent next buffer.
import { randomUUID } from 'node:crypto';
import { expect, test, type ElementHandle, type Page, type Route, type TestInfo } from '@playwright/test';
import {
  errorResponseSchema, manualPeriodWorkLogListResponseSchema, manualPeriodWorkLogResponseSchema, periodCommitmentListResponseSchema,
  periodCommitmentResponseSchema, taskListResponseSchema,
} from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { revealTaskFilters } from './support/disclosures.js';
import { evidenceJson } from './support/evidence.js';
import { futurePeriod, sizes, type Daily } from './support/next-ux.js';

const RETRY_TASKS = 'Retry loading tasks';
const LOADING_TASKS = 'Loading tasks…';
const FILTERED_NOTICE = (title: string) => `Task “${title}” created. Your filters are still applied.`;

function recordTraffic(page: Page, prefix: string) {
  const writes: { method: string; path: string }[] = [], errors: string[] = [], failedReads: { path: string; status: number }[] = [];
  page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: new URL(q.url()).pathname }); });
  page.on('response', r => { if (r.request().method() === 'GET' && new URL(r.url()).pathname.startsWith(prefix) && r.status() >= 400) failedReads.push({ path: new URL(r.url()).pathname + new URL(r.url()).search, status: r.status() }); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors, failedReads };
}
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });
/** One rendered frame after an action, so a request a handler would start has been issued. Not a timer. */
const settleFrame = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const param = (page: Page, key: string) => new URL(page.url()).searchParams.getAll(key);

/** Real click on a select-only combobox, then the exact option; its listbox is portalled to the body. */
async function choose(page: Page, label: string, option: string) {
  const trigger = page.getByRole('combobox', { name: label, exact: true }), list = page.getByRole('listbox', { name: label, exact: true });
  await expect(trigger).toBeEnabled(); if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
  await expect(list).toBeVisible(); await list.getByRole('option', { name: option, exact: true }).click(); await expect(list).toHaveCount(0);
}
async function collapseFilters(page: Page) { const summary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ }); if (await summary.locator('..').evaluate(element => element.hasAttribute('open'))) await summary.click(); }

async function projectTasks(f: Daily) {
  const r = await f.request.get(`${f.prefix}/tasks`, { params: { projectId: f.project.id, limit: 200, includeArchived: 'true' } });
  expect(r.status(), await r.text()).toBe(200); return taskListResponseSchema.parse(await r.json()).data;
}
async function periodLogs(f: Daily, periodId: string) {
  const r = await f.request.get(`${f.prefix}/worklogs`, { params: { periodId, limit: 100 } });
  expect(r.status(), await r.text()).toBe(200); return manualPeriodWorkLogListResponseSchema.parse(await r.json()).data;
}
async function periodCommitments(f: Daily, periodId: string) {
  const r = await f.request.get(`${f.prefix}/periods/${periodId}/commitments`, { params: { limit: 100 } });
  expect(r.status(), await r.text()).toBe(200); return periodCommitmentListResponseSchema.parse(await r.json()).data;
}

for (const [name, viewport] of sizes) test.describe(`Daily entry recovery ${name}`, () => {
  test.use({ viewport });

  test('Week task catalog 503: week/person, saved plan and typed actual hours stay usable; explicit retry holds the real answer, then one explicit Save stores 75 minutes once', async ({ page, request, baseURL }, info) => {
    test.setTimeout(150_000);
    const f = await dailyFixture(request, baseURL, 'Week catalog recovery');
    const work = await f.createTask(`${f.token} ordinary work`, { estimateMinutes: 180 });
    const period = await futurePeriod(f);
    const commitment = (await f.post(`/periods/${period.id}/commitments`, { workPackageId: work.workPackageId, membershipId: f.other.id, expectedAbsent: true, plannedMinutes: 90, allocations: [{ taskId: work.id, minutes: 90 }] }, periodCommitmentResponseSchema)).data;
    const workBefore = await f.task(work.id); expect(await periodLogs(f, period.id)).toEqual([]);
    const comment = `${f.token} catalog recovery comment`, factPath = `${f.prefix}/tasks/${work.id}/manual-period-work/${period.id}/${f.other.id}`;
    const { writes, errors, failedReads } = recordTraffic(page, f.prefix);
    // Only this project's Week task catalog: 503 while failing; on the explicit retry the real answer is fetched, then held.
    let phase: 'fail' | 'hold' | 'real' = 'fail';
    const served503: string[] = [], heldReads: { url: string; status: number }[] = [], reached = gate(), held = gate();
    const isCatalog = (url: URL) => url.pathname === `${f.prefix}/tasks` && url.searchParams.get('projectId') === f.project.id && url.searchParams.get('includeArchived') === 'true';
    const catalog = async (route: Route) => {
      if (route.request().method() !== 'GET') return route.continue();
      if (phase === 'fail') {
        const body = errorResponseSchema.parse({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.', retryable: true }, meta: { requestId: `qa-${randomUUID()}` } });
        served503.push(route.request().url()); return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (phase === 'hold' && heldReads.length === 0) {
        const actual = await route.fetch(); heldReads.push({ url: route.request().url(), status: actual.status() }); expect(actual.status()).toBe(200);
        reached.release(); await held.wait; return route.fulfill({ response: actual });
      }
      return route.continue();
    };
    await page.route(isCatalog, catalog);
    const puts: { key: string | undefined; body: string | null }[] = [];
    page.on('request', q => { if (q.method() === 'PUT' && new URL(q.url()).pathname === factPath) puts.push({ key: q.headers()['idempotency-key'], body: q.postData() }); });
    const measured: Record<string, unknown>[] = [];
    try {
      await page.goto(`${f.path}/week?period=${period.id}&worker=${f.other.id}`);
      const periodLabel = `${period.name} · ${period.localStart}`;
      const periodPicker = page.getByRole('combobox', { name: 'Period', exact: true }), personPicker = page.getByRole('combobox', { name: 'Time entry for', exact: true });
      await expect(periodPicker).toContainText(periodLabel); await expect(personPicker).toContainText(f.other.displayName);
      expect([param(page, 'period'), param(page, 'worker')]).toEqual([[period.id], [f.other.id]]);
      await expect(page.getByRole('button', { name: 'Plan and hours', exact: true })).toHaveAttribute('aria-current', 'page');
      const plans = page.getByRole('region', { name: 'Personal plans', exact: true }), actuals = page.getByRole('region', { name: 'Weekly actual hours', exact: true });
      const baseline = page.getByRole('region', { name: 'My baseline', exact: true });
      await expect(plans).toContainText(f.other.displayName); await expect(plans).not.toContainText('No personal plans for this week yet.');
      await expect(actuals).toContainText('No actual hours recorded for this week yet.'); await expect(baseline).toBeVisible();
      const baselineText = (await baseline.textContent())?.trim() ?? '';

      const record = actuals.getByRole('button', { name: 'Record actual hours', exact: true }); await expect(record).toBeEnabled(); await record.click();
      const dialog = page.getByRole('dialog', { name: 'Record weekly actual hours', exact: true }); await expect(dialog).toBeVisible();
      const context = dialog.getByRole('region', { name: 'Time entry context', exact: true });
      // The page behind the modal is aria-hidden/inert: selection checks use the dialog's context and the URL only.
      const contextHolds = async () => {
        await expect(context).toBeVisible(); await expect(context).toContainText(period.name); await expect(context).toContainText(f.other.displayName);
        expect([param(page, 'period'), param(page, 'worker')]).toEqual([[period.id], [f.other.id]]);
      };
      await contextHolds();
      const catalogAlert = dialog.getByRole('alert').filter({ hasText: /Could not load tasks/i });
      const taskSelect = dialog.getByLabel('Task', { exact: true }), hours = dialog.getByLabel('Actual hours this week', { exact: true });
      const reason = dialog.getByLabel('Comment (optional)', { exact: true }), save = dialog.getByRole('button', { name: 'Save actual hours', exact: true });
      expect(await taskSelect.evaluate(el => el.tagName)).toBe('SELECT');
      await hours.fill('1.25'); await reason.fill(comment);
      // The catalog has failed (after the product's own bounded query retries); only an explicit retry is offered.
      const retry = dialog.getByRole('button', { name: RETRY_TASKS, exact: true }); await expect(retry).toBeVisible({ timeout: 20_000 });
      expect(served503.length).toBeGreaterThan(0);
      await expect(taskSelect).toBeDisabled(); await expect(save).toBeDisabled();
      await expect(hours).toBeEditable(); await expect(hours).toHaveValue('1.25'); await expect(reason).toBeEditable(); await expect(reason).toHaveValue(comment);
      await expect(catalogAlert).toHaveCount(1); await expect(catalogAlert).toHaveText('Could not load tasks. Your entry is kept.');
      await contextHolds();
      measured.push({ stage: 'catalog failed', served503: served503.length, overflow: await overflow(page) }); await shot(page, info, `week-catalog-failed-${name}`);
      await settleFrame(page); expect(writes).toEqual([]);

      const failedCount = served503.length; phase = 'hold'; await retry.click(); await reached.wait;
      // Real 200 fetched and held: loading, never an empty catalog, and the typed context is intact.
      await expect(dialog.getByText(LOADING_TASKS, { exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: RETRY_TASKS, exact: true })).toHaveCount(0);
      await expect(taskSelect).toBeDisabled(); await expect(save).toBeDisabled();
      await expect(hours).toHaveValue('1.25'); await expect(reason).toHaveValue(comment); await contextHolds(); await expect(catalogAlert).toHaveCount(0);
      await expect(taskSelect.getByRole('option', { name: work.title, exact: true })).toHaveCount(0);
      expect(served503).toHaveLength(failedCount); measured.push({ stage: 'retry held', heldReads }); await shot(page, info, `week-catalog-loading-${name}`);
      expect(writes).toEqual([]);

      phase = 'real'; held.release();
      await expect(taskSelect).toBeEnabled(); await expect(dialog.getByText(LOADING_TASKS, { exact: true })).toHaveCount(0);
      await taskSelect.selectOption({ label: work.title }); await expect(taskSelect).toHaveValue(work.id);
      await expect(hours).toHaveValue('1.25'); await expect(reason).toHaveValue(comment); await expect(save).toBeEnabled();
      await contextHolds(); await expect(catalogAlert).toHaveCount(0);
      await settleFrame(page); expect(writes).toEqual([]);

      const saved = page.waitForResponse(r => apiCall(r, 'PUT', factPath)); await save.click(); const response = await saved;
      expect(response.status(), await response.text()).toBe(200); const log = manualPeriodWorkLogResponseSchema.parse(await response.json()).data;
      await expect(dialog).toHaveCount(0); await expect(page.getByRole('status').filter({ hasText: 'Weekly actual hours saved.' })).toHaveCount(1);
      await settleFrame(page);
      expect(puts).toHaveLength(1); expect(puts[0]?.key).toBeTruthy();
      expect(JSON.parse(puts[0]?.body ?? '{}')).toEqual({ expectedRevision: null, minutes: 75, state: 'active', reason: comment });
      expect(log).toMatchObject({ taskId: work.id, membershipId: f.other.id, periodId: period.id, minutes: 75, state: 'active', reason: comment, revision: 1 });
      const stored = await periodLogs(f, period.id); expect(stored).toEqual([log]);
      const entries = actuals.getByRole('list', { name: 'Actual-hour entries', exact: true }).getByRole('listitem');
      await expect(entries).toHaveCount(1); await expect(entries.first()).toContainText(work.title); await expect(entries.first()).toContainText(f.other.displayName);
      await expect(plans).toContainText(f.other.displayName); await expect(baseline).toHaveText(baselineText);
      await expect(periodPicker).toContainText(periodLabel); await expect(personPicker).toContainText(f.other.displayName);
      expect([param(page, 'period'), param(page, 'worker')]).toEqual([[period.id], [f.other.id]]);
      expect(await periodCommitments(f, period.id)).toEqual([commitment]); expect(await f.task(work.id)).toEqual(workBefore);
      expect(served503).toHaveLength(failedCount); expect(heldReads).toEqual([expect.objectContaining({ status: 200 })]);
      // Every failed read is one of the intended catalog 503s; all other Week reads succeeded.
      expect(failedReads.filter(read => read.status !== 503 || !served503.some(url => url.endsWith(read.path)))).toEqual([]);
      expect(writes).toEqual([{ method: 'PUT', path: factPath }]); expect(errors).toEqual([]); expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, info, `week-catalog-saved-${name}`);
    } finally {
      held.release();
      await evidenceJson(info, `week-catalog-recovery-${name}.json`, { viewport, projectId: f.project.id, periodId: period.id, workerId: f.other.id, taskId: work.id, commitmentId: commitment.id, served503, heldReads, puts, measured, writes, failedReads, errors });
      if (!page.isClosed()) await page.unroute(isCatalog, catalog);
    }
  });

  test('filtered-out quick create: pending and unknown show no success; the exact retry replays once, then only the confirmed notice offers Open details while the next buffer keeps element, value, selection and scroll', async ({ page, request, baseURL }, info) => {
    test.setTimeout(150_000);
    const f = await dailyFixture(request, baseURL, 'Filtered quick create');
    const anchor = await f.createTask(`${f.token} visible anchor`, { statusId: f.progress.id, responsibleMembershipId: f.own.id, participantMembershipIds: [f.own.id] });
    const createPath = `${f.prefix}/tasks`, attempts: { key: string | undefined; body: string | null }[] = [], served: number[] = [];
    const { writes, errors, failedReads } = recordTraffic(page, f.prefix);
    const reads: URL[] = []; page.on('request', q => { const url = new URL(q.url()); if (q.method() === 'GET' && url.pathname === createPath && url.searchParams.get('projectId') === f.project.id) reads.push(url); });
    const committed = gate(), held = gate(), replayReached = gate(), replayHeld = gate(); let armed = false;
    const create = async (route: Route) => {
      if (!armed || route.request().method() !== 'POST') return route.continue();
      attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      // The real server answers every attempt; the first answer is lost after being held, the replay's real answer is held then delivered.
      const actual = await route.fetch(); served.push(actual.status());
      if (attempts.length === 1) { committed.release(); await held.wait; await route.abort('failed'); return; }
      if (attempts.length === 2) { replayReached.release(); await replayHeld.wait; }
      await route.fulfill({ response: actual });
    };
    await page.route(`**${createPath}`, create);
    const first = `${f.token} filtered out first`, nextBuffer = `${f.token} unsent next buffer`, notice = FILTERED_NOTICE(first);
    const filters = () => ({ status: param(page, 'status'), participant: param(page, 'participant'), task: param(page, 'task') });
    const rows = () => page.getByRole('table').locator('[data-task-row]');
    const measured: Record<string, unknown>[] = [];
    let handle: ElementHandle<HTMLElement | SVGElement> | null = null;
    try {
      await page.goto(f.path); const timeOrigin = await page.evaluate(() => performance.timeOrigin);
      await revealTaskFilters(page); await choose(page, 'Task status', f.progress.name); await choose(page, 'Task participant', f.own.displayName); await collapseFilters(page);
      await expect.poll(filters).toEqual({ status: [f.progress.id], participant: [f.own.id], task: [] });
      await expect.poll(() => reads.some(url => url.searchParams.get('statusId') === f.progress.id && url.searchParams.get('participantMembershipId') === f.own.id)).toBe(true);
      await expect(page.getByRole('button', { name: anchor.title, exact: true })).toBeVisible(); await expect(rows()).toHaveCount(1);

      await page.getByRole('button', { name: 'Add task to “QA section”', exact: true }).click();
      const form = page.getByRole('form', { name: 'Add a task to QA section', exact: true }), titleBox = form.getByRole('textbox', { name: 'Task name', exact: true });
      await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue('');
      armed = true; await page.keyboard.type(first); await page.keyboard.press('Enter'); await committed.wait;
      // Committed on the server, answer held: the next blank buffer is already focused.
      await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue(''); await expect(titleBox).toBeEditable();
      await page.keyboard.type(nextBuffer); for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft');
      handle = await titleBox.elementHandle(); if (!handle) throw Error('Quick title input required.');
      const buffer = (input: ElementHandle<HTMLElement | SVGElement>) => page.evaluate(el => {
        const box = el as HTMLInputElement, scroller = document.querySelector<HTMLElement>('[data-task-table-scroll]');
        return { connected: box.isConnected, value: box.value, start: box.selectionStart, end: box.selectionEnd, focused: document.activeElement === box,
          windowX: scrollX, windowY: scrollY, tableTop: scroller?.scrollTop ?? null, tableLeft: scroller?.scrollLeft ?? null };
      }, input);
      const sameElement = async () => { const input = handle; return input !== null && titleBox.evaluate((el, prev) => el === prev, input); };
      const base = await buffer(handle); measured.push({ stage: 'first create held, next buffer selected', buffer: base });
      expect(base).toMatchObject({ connected: true, value: nextBuffer, start: nextBuffer.length - 4, end: nextBuffer.length, focused: true });
      expect(attempts).toHaveLength(1);
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0); await expect(page.getByText('Your filters are still applied.', { exact: false })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open details', exact: true })).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(rows()).toHaveCount(1); await expect(page.getByRole('table').getByText(first, { exact: true })).toHaveCount(0);
      await shot(page, info, `filtered-create-pending-${name}`);

      held.release();
      const retry = form.getByRole('button', { name: 'Retry original', exact: true }); await expect(retry).toBeVisible();
      await settleFrame(page); const unknown = await buffer(handle); measured.push({ stage: 'first answer lost, outcome unknown', buffer: unknown });
      expect(unknown).toEqual(base); expect(await sameElement()).toBe(true);
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Open details', exact: true })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0); await expect(rows()).toHaveCount(1);
      const afterUnknown = await projectTasks(f);
      expect(afterUnknown.filter(task => task.title === first)).toHaveLength(1); expect(afterUnknown.filter(task => task.title === nextBuffer)).toHaveLength(0);
      expect(attempts).toHaveLength(1); expect(served).toEqual([201]); expect(filters()).toEqual({ status: [f.progress.id], participant: [f.own.id], task: [] });
      await shot(page, info, `filtered-create-unknown-${name}`);

      // Explicit exact retry. Its own click intentionally moves focus to the button; there is no focus restoration.
      const replayed = page.waitForResponse(r => apiCall(r, 'POST', createPath)); await retry.click(); await replayReached.wait;
      // Real replay committed and its answer held: the person returns to the same next buffer and selects a new range
      // (no typing, no Enter), so the frame owned by the person right before the ACK is known exactly.
      await titleBox.click(); await expect(titleBox).toBeFocused();
      await page.keyboard.press('End'); for (let i = 0; i < 6; i++) await page.keyboard.press('Shift+ArrowLeft');
      await settleFrame(page); const userFrame = await buffer(handle); measured.push({ stage: 'replay held, next buffer reselected', buffer: userFrame });
      expect(await sameElement()).toBe(true);
      expect(userFrame).toMatchObject({ connected: true, value: nextBuffer, start: nextBuffer.length - 6, end: nextBuffer.length, focused: true });
      await expect(page.getByText(notice, { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Open details', exact: true })).toHaveCount(0);
      expect(attempts).toHaveLength(2); expect(served).toEqual([201, 201]);
      replayHeld.release();
      const confirmed = await taskResult(await replayed, 201);
      const status = page.getByRole('status').filter({ has: page.getByText(notice, { exact: true }) });
      await expect(status).toHaveCount(1); await expect(status).toBeVisible();
      const openDetails = page.getByRole('button', { name: 'Open details', exact: true }); await expect(openDetails).toHaveCount(1); await expect(openDetails).toBeVisible();
      await settleFrame(page); const after = await buffer(handle); measured.push({ stage: 'replay confirmed', buffer: after });
      // The ACK keeps the person's current element, value, focus, selection and scroll exactly.
      expect(await sameElement()).toBe(true); expect(after).toEqual(userFrame);
      // No automatic focus move: confirmation never focuses the notice, its action or a dialog.
      expect(await page.evaluate(() => { const active = document.activeElement; return active !== null && (active.closest('[role="status"]') !== null || active.closest('[role="dialog"]') !== null || active.textContent?.trim() === 'Open details'); })).toBe(false);
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(served).toEqual([201, 201]);
      const sent = JSON.parse(attempts[0]?.body ?? '{}') as Record<string, unknown>;
      expect(sent).toMatchObject({ projectId: f.project.id, sectionId: f.section.id, title: first, statusId: f.todo.id });
      expect(sent.responsibleMembershipId ?? null).toBeNull(); expect(sent.participantMembershipIds ?? []).toEqual([]);
      expect(filters()).toEqual({ status: [f.progress.id], participant: [f.own.id], task: [] });
      await expect(page.getByRole('dialog')).toHaveCount(0); await expect(rows()).toHaveCount(1); await expect(page.getByRole('table').getByText(first, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: anchor.title, exact: true })).toBeVisible();
      const stored = await projectTasks(f), created = stored.filter(task => task.title === first);
      expect(created).toHaveLength(1); expect(stored.filter(task => task.title === nextBuffer)).toHaveLength(0); expect(stored).toHaveLength(2);
      expect(created[0]?.id).toBe(confirmed.id);
      expect(created[0]).toMatchObject({ revision: 1, statusId: f.todo.id, responsibleMembershipId: null, sectionId: f.section.id, parentTaskId: null });
      expect(created[0]?.participants).toEqual([]);
      expect(await f.task(anchor.id)).toEqual(anchor); expect(await overflow(page)).toBeLessThanOrEqual(0);
      await shot(page, info, `filtered-create-confirmed-${name}`);

      await openDetails.click();
      const drawer = page.getByRole('dialog', { name: first, exact: true }); await expect(drawer).toBeVisible();
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(first);
      await expect.poll(filters).toEqual({ status: [f.progress.id], participant: [f.own.id], task: [confirmed.id] });
      await settleFrame(page); expect(attempts).toHaveLength(2); await shot(page, info, `filtered-create-details-${name}`);
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
      await expect.poll(filters).toEqual({ status: [f.progress.id], participant: [f.own.id], task: [] });
      await expect(rows()).toHaveCount(1); await expect(page.getByRole('table').getByText(first, { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: anchor.title, exact: true })).toBeVisible();
      // Open details deliberately closed the quick row; the unsent next buffer is retained and returns on an explicit reopen.
      // Element identity, focus and selection are not carried across that deliberate details/close/reopen.
      await page.getByRole('button', { name: 'Add task to “QA section”', exact: true }).click();
      const reopened = page.getByRole('form', { name: 'Add a task to QA section', exact: true }).getByRole('textbox', { name: 'Task name', exact: true });
      await expect(reopened).toHaveValue(nextBuffer); await expect(reopened).toBeFocused(); await expect(reopened).toBeEditable();
      await settleFrame(page); expect(attempts).toHaveLength(2); expect(served).toEqual([201, 201]);
      await shot(page, info, `filtered-create-reopened-${name}`);
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      expect(writes).toEqual([{ method: 'POST', path: createPath }, { method: 'POST', path: createPath }]);
      expect(failedReads).toEqual([]); expect(errors).toEqual([]); expect(await overflow(page)).toBeLessThanOrEqual(0);
      const final = await projectTasks(f);
      expect(final.filter(task => task.title === first)).toHaveLength(1); expect(final.filter(task => task.title === nextBuffer)).toHaveLength(0); expect(final).toHaveLength(2);
    } finally {
      held.release(); replayHeld.release(); await handle?.dispose();
      await evidenceJson(info, `filtered-quick-create-${name}.json`, { viewport, projectId: f.project.id, anchorId: anchor.id, first, nextBuffer, attempts, served, measured, reads: reads.map(url => url.search), writes, failedReads, errors });
      if (!page.isClosed()) await page.unroute(`**${createPath}`, create);
    }
  });
});
