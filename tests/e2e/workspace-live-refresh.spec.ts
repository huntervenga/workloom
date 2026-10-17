// Source-authored native acceptance; execution/results belong to the coordinator's compiled gate.
// All persisted fixtures are new projects in the historical synthetic workspace, through supported APIs.
// Two isolated contexts use actual HttpOnly development sessions. No client identity header is trusted.
// Five-second polling is never accelerated. Transport-injected failures are explicitly identified below.
// Root-approved scope change: BOTH head polling and ordinary catch-up suspend while any draft,
// pending/unknown command, editor, dialog, picker or IME interaction protects the feature owner.
// Acquisition cancels pre-protection head work, including its late denial. Release reauthorizes with
// a fresh head before safe catch-up. Immediate authorization-loss detection while protected is not claimed.
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  freezePreviewResponseSchema, meResponseSchema, periodCommitmentResponseSchema, planBaselineResponseSchema,
  taskCommentResponseSchema, taskCommentsResponseSchema, taskListResponseSchema, taskResponseSchema,
  weeklyPlanFactReportRunResponseSchema, workspaceChangeHeadResponseSchema,
  type TaskDto, type WorkspaceChangeHeadDto,
} from '@workloom/contracts';
import { dailyFixture, gate } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { futurePeriod, type Daily } from './support/next-ux.js';

const sizes = [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const;
type Size = (typeof sizes)[number][1];
const eventual = { timeout: 12_000 };
const row = (page: Page, task: TaskDto) => page.locator(`[data-task-row="${task.id}"]`);
const inline = (page: Page) => page.getByRole('form', { name: /^Edit .+ in the task table$/ });
const titleInput = (page: Page) => inline(page).getByRole('textbox', { name: 'Task name', exact: true });
const headPath = (f: Daily) => `${f.prefix}/change-head`;
const taskListPath = (f: Daily) => `${f.prefix}/tasks`;
const path = (url: string) => new URL(url).pathname;

/** Record browser-only traffic, retaining request bodies/keys for commands and successful real heads. */
function observe(page: Page, f: Daily) {
  const requests: { method: string; path: string; body: string | null; key: string | undefined }[] = [];
  const heads: WorkspaceChangeHeadDto[] = [], responses: { path: string; status: number }[] = [];
  const errors: string[] = [], failures: string[] = [], cancelled: string[] = [], allowed: string[] = [];
  page.on('request', request => requests.push({ method: request.method(), path: path(request.url()), body: request.postData(), key: request.headers()['idempotency-key'] }));
  page.on('response', response => {
    const responsePath = path(response.url());
    if (!responsePath.startsWith('/api/') && !/\.(?:js|css)$/.test(responsePath)) return;
    responses.push({ path: responsePath, status: response.status() });
    if (response.status() >= 400 && !allowed.includes(responsePath)) failures.push(`${responsePath} ${response.status()}`);
    if (responsePath === headPath(f) && response.ok()) {
      void response.json().then(json => { heads.push(workspaceChangeHeadResponseSchema.parse(json).data); }).catch((error: unknown) => errors.push(String(error)));
    }
  });
  page.on('requestfailed', request => {
    const requestPath = path(request.url()), message = request.failure()?.errorText ?? '';
    if (message === 'net::ERR_ABORTED' && request.method() === 'GET') cancelled.push(requestPath);
    else if (requestPath.startsWith('/api/') && !allowed.includes(requestPath)) failures.push(`${requestPath} ${message}`);
  });
  page.on('pageerror', error => errors.push(error.message));
  return { requests, heads, responses, errors, failures, cancelled, allowed,
    writes: () => requests.filter(request => !['GET', 'HEAD', 'OPTIONS'].includes(request.method)),
    reads: (readPath: string) => requests.filter(request => request.method === 'GET' && request.path === readPath).length };
}
type Client = { context: BrowserContext; page: Page; net: ReturnType<typeof observe>; actorId: string; membershipId: string };
async function client(browser: Browser, baseURL: string | undefined, f: Daily, member: Daily['own'], viewport: Size): Promise<Client> {
  if (!baseURL) throw Error('Already-running compiled baseURL required.');
  const context = await browser.newContext({ baseURL, viewport });
  try {
    const switched = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: member.userId } });
    expect(switched.status(), await switched.text()).toBe(200);
    expect(meResponseSchema.parse(await switched.json()).data.actor.id).toBe(member.userId);
    const session = (await context.cookies()).find(cookie => cookie.name === 'workloom_dev_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    const identity = await context.request.get('/api/v1/me');
    expect(identity.status()).toBe(200); expect(meResponseSchema.parse(await identity.json()).data.actor.id).toBe(member.userId);
    const head = await context.request.get(headPath(f));
    expect(head.status(), await head.text()).toBe(200); expect(head.headers()['cache-control']).toBe('no-store');
    expect(workspaceChangeHeadResponseSchema.parse(await head.json()).data).toMatchObject({ workspaceId: f.workspace.id, actorUserId: member.userId, membershipId: member.id, role: member.role });
    const page = await context.newPage(); page.setDefaultTimeout(12_000);
    return { context, page, net: observe(page, f), actorId: member.userId, membershipId: member.id };
  } catch (error) { await context.close(); throw error; }
}
async function pair(browser: Browser, baseURL: string | undefined, f: Daily, viewport: Size) {
  const a = await client(browser, baseURL, f, f.own, viewport);
  try {
    const b = await client(browser, baseURL, f, f.other, viewport);
    expect(a.actorId).not.toBe(b.actorId); expect(a.membershipId).not.toBe(b.membershipId);
    return { a, b, close: async () => { await b.context.close(); await a.context.close(); } };
  } catch (error) { await a.context.close(); throw error; }
}
/** Two actual head responses allow the initial catch-up to settle without arbitrary sleeps. */
async function prime(c: Client, f: Daily, target = f.path) {
  await c.page.goto(target); await expect.poll(() => c.net.heads.length, eventual).toBeGreaterThanOrEqual(2);
  for (const head of c.net.heads) expect(head).toMatchObject({ actorUserId: c.actorId, membershipId: c.membershipId, workspaceId: f.workspace.id });
}
async function currentHead(c: Client, f: Daily) {
  const response = await c.context.request.get(headPath(f)); expect(response.status()).toBe(200);
  return workspaceChangeHeadResponseSchema.parse(await response.json()).data;
}
async function observed(c: Client, head: WorkspaceChangeHeadDto, after = 0) {
  await expect.poll(() => c.net.heads.slice(after).some(value => BigInt(value.changeSeq) >= BigInt(head.changeSeq)), eventual).toBe(true);
}
/** A's visible, unprotected client supplies two actual five-second cycles; no short test timer is used. */
async function protectedCycles(a: Client, b: Client, f: Daily, headReads: number) {
  const index = a.net.heads.length;
  await expect.poll(() => a.net.heads.length, eventual).toBeGreaterThanOrEqual(index + 2);
  expect(b.net.reads(headPath(f)), 'protected owner starts no new head requests; earlier cancelled work is recorded separately').toBe(headReads);
}
/** Explicit supported command by A, with the exact fresh revision and a retained write receipt. */
async function update(c: Client, f: Daily, task: TaskDto, patch: Partial<Pick<TaskDto, 'title' | 'statusId' | 'dueDate' | 'description'>>) {
  const key = randomUUID(), body = { expectedRevision: task.revision, ...patch }, requestPath = `${f.prefix}/tasks/${task.id}`;
  const response = await c.context.request.patch(requestPath, { headers: { origin: f.origin, 'idempotency-key': key }, data: body });
  expect(response.status(), await response.text()).toBe(200);
  const saved = taskResponseSchema.parse(await response.json()).data;
  expect(saved).toMatchObject({ id: task.id, revision: task.revision + 1, ...patch });
  return { saved, receipt: { method: 'PATCH', path: requestPath, key, body, status: response.status(), result: saved } };
}
/** Read-only DOM evidence: real viewport/row/header geometry, scroll, URL, and document identity. */
async function frame(page: Page) {
  return page.locator('[data-task-table-scroll]').evaluate(table => {
    const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { url: location.href, timeOrigin: performance.timeOrigin, windowX: scrollX, windowY: scrollY, scrollLeft: table.scrollLeft, scrollTop: table.scrollTop, table: rect(table),
      rows: [...table.querySelectorAll('[data-task-row]')].map(node => ({ id: node.getAttribute('data-task-row'), ...rect(node) })),
      headers: [...table.querySelectorAll('thead th')].map(node => ({ label: node.textContent, ...rect(node) })) };
  });
}
function sameFrame(before: Awaited<ReturnType<typeof frame>>, after: Awaited<ReturnType<typeof frame>>) {
  expect(after).toEqual(before);
  for (const item of after.rows) expect(item.height).toBe(41);
}
async function selection(input: Locator) {
  return input.evaluate(node => { const el = node as HTMLInputElement; return { value: el.value, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection, focused: document.activeElement === el }; });
}
async function selectPart(input: Locator) {
  await input.press('Home'); await input.press('ArrowRight'); await input.press('Shift+ArrowRight'); await input.press('Shift+ArrowRight');
}
async function openDrawer(page: Page, task: TaskDto) {
  await row(page, task).hover(); await page.getByRole('button', { name: `Open task “${task.title}”`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: task.title, exact: true }); await expect(drawer).toBeVisible(); return drawer;
}
function clean(c: Client) { expect(c.net.failures).toEqual([]); expect(c.net.errors).toEqual([]); }
function readonly(c: Client) { expect(c.net.writes()).toEqual([]); clean(c); }
const failureBody = (code: string) => JSON.stringify({ error: { code, message: 'Native transport-injected live refresh gate', retryable: code === 'SERVICE_UNAVAILABLE' }, meta: { requestId: 'qa-workspace-live-refresh' } });

for (const [name, viewport] of sizes) test.describe(`Workspace live refresh ${name}`, () => {
  test('first head closes the initial list race; idle title/status/date catch up without reload or B commands; discussion waits for dialog release', async ({ browser, request, baseURL }, info) => {
    test.setTimeout(100_000);
    const f = await dailyFixture(request, baseURL, 'Live refresh idle'), task = await f.createTask(`${f.token} before head`);
    const clients = await pair(browser, baseURL, f, viewport), { a, b } = clients;
    const firstHead = gate(); let held = false;
    const receipts: unknown[] = [];
    await b.page.route(`**${headPath(f)}`, async route => { if (!held) { held = true; await firstHead.wait; } await route.continue(); });
    try {
      await prime(a, f);
      await b.page.goto(`${f.path}?sort=position&includeArchived=false`);
      await expect(row(b.page, task)).toContainText(task.title); await expect.poll(() => held).toBe(true);
      const before = await frame(b.page);
      const edited = await update(a, f, task, { title: `${f.token} colleague title`, statusId: f.progress.id, dueDate: '2027-05-19' }); receipts.push(edited.receipt);
      expect(b.net.heads).toEqual([]); await expect(row(b.page, task)).toContainText(task.title);
      const target = await currentHead(a, f); firstHead.release(); await observed(b, target);
      await expect(row(b.page, task).locator(`[data-task-cell="${task.id}:title"]`)).toHaveText(edited.saved.title, eventual);
      await expect(row(b.page, task).locator(`[data-task-cell="${task.id}:statusId"]`)).toContainText(f.progress.name);
      await expect(row(b.page, task).locator('time[datetime="2027-05-19"]')).toHaveCount(1);
      sameFrame(before, await frame(b.page)); readonly(b);

      const drawer = await openDrawer(b.page, edited.saved);
      await drawer.getByRole('tab', { name: /^Discussion/ }).click();
      await expect(drawer.getByRole('region', { name: 'Discussion', exact: true })).toBeVisible();
      const commentBody = `${f.token} literal colleague comment`, commentPath = `${f.prefix}/tasks/${task.id}/comments`, key = randomUUID();
      const posted = await a.context.request.post(commentPath, { headers: { origin: f.origin, 'idempotency-key': key }, data: { body: commentBody } });
      expect(posted.status(), await posted.text()).toBe(201); const comment = taskCommentResponseSchema.parse(await posted.json()).data;
      expect(comment).toMatchObject({ body: commentBody, authorUserId: a.actorId, authorMembershipId: a.membershipId });
      receipts.push({ method: 'POST', path: commentPath, key, body: { body: commentBody }, status: posted.status(), result: comment });
      const commentReads = b.net.reads(commentPath), headIndex = b.net.heads.length, headReads = b.net.reads(headPath(f));
      const commentHead = await currentHead(a, f); await protectedCycles(a, b, f, headReads);
      await expect(drawer.getByText(commentBody, { exact: true })).toHaveCount(0);
      expect(b.net.reads(commentPath)).toBe(commentReads); // Open pristine dialogs suspend head and content reads.
      const listReads = b.net.reads(taskListPath(f));
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
      await expect.poll(() => b.net.reads(headPath(f)), eventual).toBeGreaterThan(headReads);
      await observed(b, commentHead, headIndex);
      // A live list read proves safe catch-up after fresh release authorization; inactive discussion rereads on mount.
      await expect.poll(() => b.net.reads(taskListPath(f)), eventual).toBeGreaterThan(listReads);
      const reopened = await openDrawer(b.page, edited.saved); await reopened.getByRole('tab', { name: /^Discussion/ }).click();
      await expect(reopened.getByText(commentBody, { exact: true })).toBeVisible();
      const stored = await a.context.request.get(`${commentPath}?limit=50`); expect(stored.status()).toBe(200);
      expect(taskCommentsResponseSchema.parse(await stored.json()).data).toEqual([comment]);
      readonly(b); clean(a);
      await b.page.screenshot({ path: info.outputPath(`idle-discussion-${name}.png`) });
      await evidenceJson(info, `idle-${name}.json`, { actors: [a.actorId, b.actorId], before, after: await frame(b.page), receipts, b: b.net });
    } finally { firstHead.release(); await evidenceJson(info, `idle-traffic-${name}.json`, { receipts, a: a.net, b: b.net }); await clients.close(); }
  });

  test('focused pristine and dirty inline titles suspend head and content reads, retaining value, selection, focus and scroll; release freshly authorizes and catches up', async ({ browser, request, baseURL }, info) => {
    test.setTimeout(100_000);
    const f = await dailyFixture(request, baseURL, 'Live refresh focus'), task = await f.createTask(`${f.token} focused`), other = await f.createTask(`${f.token} peer row`);
    const clients = await pair(browser, baseURL, f, viewport), { a, b } = clients, stages: unknown[] = [];
    try {
      await prime(a, f); await prime(b, f); let source = other;
      for (const dirty of [false, true]) {
        await row(b.page, task).locator(`[data-task-cell="${task.id}:title"]`).click(); const input = titleInput(b.page);
        await expect(input).toBeFocused(); if (dirty) await input.fill(`${task.title} unsent`); await selectPart(input);
        const before = await frame(b.page), selected = await selection(input), reads = b.net.reads(taskListPath(f)), index = b.net.heads.length, headReads = b.net.reads(headPath(f));
        const edited = await update(a, f, source, { title: `${f.token} peer ${dirty ? 'dirty' : 'pristine'}` }); source = edited.saved;
        const target = await currentHead(a, f); await protectedCycles(a, b, f, headReads);
        await expect(input).toBeFocused(); expect(await selection(input)).toEqual(selected); sameFrame(before, await frame(b.page));
        expect(b.net.reads(taskListPath(f))).toBe(reads); await expect(row(b.page, other)).not.toContainText(source.title); readonly(b);
        if (dirty) await input.fill(task.title); // Explicitly restore the base so Escape leaves no retained draft.
        await input.press('Escape'); await expect(inline(b.page)).toHaveCount(0);
        await expect.poll(() => b.net.reads(headPath(f)), eventual).toBeGreaterThan(headReads); await observed(b, target, index);
        await expect(row(b.page, other)).toContainText(source.title, eventual);
        sameFrame(before, await frame(b.page)); await expect(row(b.page, task).locator(`[data-task-cell="${task.id}:title"]`)).toBeFocused();
        stages.push({ dirty, receipt: edited.receipt, selected, before, after: await frame(b.page), heads: b.net.heads.slice(index) });
      }
      expect(await f.task(task.id)).toEqual(task); readonly(b); clean(a);
      await evidenceJson(info, `focus-${name}.json`, { stages, b: b.net });
    } finally { await evidenceJson(info, `focus-traffic-${name}.json`, { stages, a: a.net, b: b.net }); await clients.close(); }
  });

  test('a cancelled pre-editor head delivering late403 cannot evict a dirty unknown command; protected polling pauses and only explicit exact retry resolves it once', async ({ browser, request, baseURL }, info) => {
    test.setTimeout(100_000);
    const f = await dailyFixture(request, baseURL, 'Live refresh unknown'), task = await f.createTask(`${f.token} unknown title`), other = await f.createTask(`${f.token} peer unchanged`);
    const clients = await pair(browser, baseURL, f, viewport), { a, b } = clients;
    const taskPath = `${f.prefix}/tasks/${task.id}`, attempts: { body: string | null; key: string | undefined; status: number; result: TaskDto }[] = [];
    b.net.allowed.push(taskPath, headPath(f));
    const lateHead = gate(); let capturing = false, captured = false, delivered = false; let capturedHead: WorkspaceChangeHeadDto | null = null;
    await b.page.route(`**${taskPath}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); expect(response.status(), await response.text()).toBe(200);
      attempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'], status: response.status(), result: taskResponseSchema.parse(await response.json()).data });
      if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
    });
    try {
      await prime(a, f); await prime(b, f);
      await b.page.route(`**${headPath(f)}`, async route => {
        if (capturing) return route.continue();
        capturing = true;
        const real = await route.fetch(); expect(real.status(), await real.text()).toBe(200);
        capturedHead = workspaceChangeHeadResponseSchema.parse(await real.json()).data; captured = true;
        await lateHead.wait;
        // The real authorized read was already complete; only its delayed transport answer becomes 403.
        // Protection must abort/obsolete this request before the injected response can evict the owner.
        try { await route.fulfill({ status: 403, contentType: 'application/json', body: failureBody('FORBIDDEN') }); }
        finally { delivered = true; }
      });
      await expect.poll(() => captured, eventual).toBe(true);
      await row(b.page, task).locator(`[data-task-cell="${task.id}:title"]`).click(); const input = titleInput(b.page), next = `${f.token} saved but unknown`;
      await input.fill(next); await input.press('ControlOrMeta+Enter');
      const retry = inline(b.page).getByRole('button', { name: 'Retry', exact: true }); await expect(retry).toBeVisible(); await expect(input).toBeFocused();
      expect(attempts).toHaveLength(1); expect(attempts[0]?.key).toBeTruthy(); expect(JSON.parse(attempts[0]?.body ?? 'null')).toEqual({ expectedRevision: task.revision, title: next });
      const storedBeforeRetry = await f.task(task.id); expect(storedBeforeRetry).toMatchObject({ title: next, revision: task.revision + 1 });
      const before = await frame(b.page), selected = await selection(input), reads = b.net.reads(taskListPath(f)), index = b.net.heads.length, headReads = b.net.reads(headPath(f));
      const peer = await update(a, f, other, { title: `${f.token} colleague during unknown` });
      const target = await currentHead(a, f); lateHead.release();
      await expect.poll(() => delivered, eventual).toBe(true);
      await expect.poll(() => b.net.cancelled.includes(headPath(f)), eventual).toBe(true);
      await protectedCycles(a, b, f, headReads);
      expect(attempts).toHaveLength(1); expect(b.net.writes()).toHaveLength(1); expect(b.net.reads(taskListPath(f))).toBe(reads);
      await expect(input).toHaveValue(next); await expect(input).toBeFocused(); expect(await selection(input)).toEqual(selected); sameFrame(before, await frame(b.page));
      await expect(row(b.page, other)).not.toContainText(peer.saved.title); await expect(retry).toBeVisible();
      await retry.click(); await expect(inline(b.page)).toHaveCount(0); await expect(row(b.page, task)).toContainText(next);
      await expect.poll(() => b.net.reads(headPath(f)), eventual).toBeGreaterThan(headReads); await observed(b, target, index);
      await expect(row(b.page, other)).toContainText(peer.saved.title, eventual);
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await f.task(task.id)).toEqual(storedBeforeRetry);
      const listed = await a.context.request.get(taskListPath(f), { params: { projectId: f.project.id, limit: 200 } }); expect(listed.status()).toBe(200);
      expect(taskListResponseSchema.parse(await listed.json()).data.map(value => value.id).sort()).toEqual([task.id, other.id].sort());
      expect(b.net.writes().map(value => [value.method, value.path])).toEqual([['PATCH', taskPath], ['PATCH', taskPath]]); clean(a); clean(b);
      await evidenceJson(info, `unknown-${name}.json`, { attempts, lateDenialTransportInjected: true, capturedHead, delivered, peer: peer.receipt, storedBeforeRetry, before, after: await frame(b.page), b: b.net });
    } finally { lateHead.release(); await evidenceJson(info, `unknown-traffic-${name}.json`, { attempts, lateDenialTransportInjected: true, capturedHead, delivered, a: a.net, b: b.net }); await clients.close(); }
  });

  test('transport-injected head503 preserves loaded content; failed catch-up stays pending and a later equal real head repairs it', async ({ browser, request, baseURL }, info) => {
    test.setTimeout(110_000);
    const f = await dailyFixture(request, baseURL, 'Live refresh transient'), task = await f.createTask(`${f.token} before transient`);
    const clients = await pair(browser, baseURL, f, viewport), { a, b } = clients;
    let failHead = true, failContent = true; const failures: { kind: string; at: number }[] = [];
    try {
      await prime(a, f); await prime(b, f); const before = await frame(b.page), index = b.net.heads.length;
      b.net.allowed.push(headPath(f), taskListPath(f));
      await b.page.route(`**${headPath(f)}`, async route => {
        if (failHead) { failHead = false; failures.push({ kind: 'head503', at: Date.now() }); return route.fulfill({ status: 503, contentType: 'application/json', body: failureBody('SERVICE_UNAVAILABLE') }); }
        await route.continue();
      });
      await b.page.route(`**${taskListPath(f)}?**`, async route => {
        if (failContent && new URL(route.request().url()).searchParams.get('projectId') === f.project.id) { failures.push({ kind: 'tasks503', at: Date.now() }); return route.fulfill({ status: 503, contentType: 'application/json', body: failureBody('SERVICE_UNAVAILABLE') }); }
        await route.continue();
      });
      const edited = await update(a, f, task, { title: `${f.token} after transient` }), target = await currentHead(a, f);
      await expect.poll(() => failures.some(value => value.kind === 'head503'), eventual).toBe(true);
      await expect(row(b.page, task)).toContainText(task.title); sameFrame(before, await frame(b.page)); readonly(b);
      await observed(b, target, index);
      // Normal content GETs have two bounded retries. Keep all three responses unavailable so the catch-up really fails.
      await expect.poll(() => failures.filter(value => value.kind === 'tasks503').length, eventual).toBeGreaterThanOrEqual(3);
      expect(b.net.responses.filter(value => value.path === taskListPath(f) && value.status === 503).length).toBeGreaterThanOrEqual(3);
      const failedHead = b.net.heads.at(-1); expect(failedHead?.changeSeq).toBe(target.changeSeq);
      const retryIndex = b.net.heads.length; failContent = false;
      await expect.poll(() => b.net.heads.length, eventual).toBeGreaterThan(retryIndex);
      expect(b.net.heads[retryIndex]).toEqual(failedHead);
      await expect(row(b.page, task)).toContainText(edited.saved.title, eventual);
      sameFrame(before, await frame(b.page)); readonly(b); clean(a);
      await evidenceJson(info, `transient-${name}.json`, { injected: true, failures, receipt: edited.receipt, before, after: await frame(b.page), failedHead, b: b.net });
    } finally { failContent = false; failHead = false; await evidenceJson(info, `transient-traffic-${name}.json`, { failures, a: a.net, b: b.net }); await clients.close(); }
  });

  test('transport-injected idle head403 hides primed descendants and stays suspended after transport recovery until visible explicit root retry reauthorizes', async ({ browser, request, baseURL }, info) => {
    test.setTimeout(100_000);
    const f = await dailyFixture(request, baseURL, 'Live refresh denied'), task = await f.createTask(`${f.token} primed private content`);
    const clients = await pair(browser, baseURL, f, viewport), { a, b } = clients;
    try {
      await prime(a, f); await prime(b, f);
      await expect(row(b.page, task)).toContainText(task.title); await expect(inline(b.page)).toHaveCount(0);
      const before = await frame(b.page); let headDenials = 0, rootDenials = 0;
      b.net.allowed.push(headPath(f), f.prefix);
      await b.page.route(`**${headPath(f)}`, route => { headDenials++; return route.fulfill({ status: 403, contentType: 'application/json', body: failureBody('FORBIDDEN') }); });
      await b.page.route(`**${f.prefix}`, route => { rootDenials++; return route.fulfill({ status: 403, contentType: 'application/json', body: failureBody('FORBIDDEN') }); });
      await expect.poll(() => headDenials, eventual).toBe(1);
      await expect(row(b.page, task)).toHaveCount(0); await expect(titleInput(b.page)).toHaveCount(0);
      const unavailable = b.page.getByRole('heading', { level: 1, name: 'Workspace unavailable', exact: true });
      await expect(b.page.locator('[data-task-table-scroll]')).toHaveCount(0); await expect(unavailable).toBeVisible();
      await expect.poll(() => rootDenials, eventual).toBeGreaterThan(0);
      // A remains authorized and provides two actual five-second cycles while B's denial stays suspended.
      const headReads = b.net.reads(headPath(f)); await protectedCycles(a, b, f, headReads);
      expect(headDenials).toBe(1); expect(await f.task(task.id)).toEqual(task); readonly(b); clean(a);
      expect(b.page.url()).toBe(before.url); expect(await b.page.evaluate(() => performance.timeOrigin)).toBe(before.timeOrigin);
      await b.page.screenshot({ path: info.outputPath(`transport-denial-${name}.png`) });

      // Restoring the real server alone grants no recovery. A further two actual head cycles provide
      // native evidence that automatic retry remains suspended; focus/reconnect event cases stay source-covered.
      await b.page.unroute(`**${headPath(f)}`); await b.page.unroute(`**${f.prefix}`);
      const rootReads = b.net.reads(f.prefix), deniedHeads = b.net.heads.length;
      await protectedCycles(a, b, f, headReads);
      expect(b.net.reads(f.prefix)).toBe(rootReads); expect(b.net.heads).toHaveLength(deniedHeads);
      await expect(unavailable).toBeVisible(); await expect(row(b.page, task)).toHaveCount(0); readonly(b);

      const responseIndex = b.net.responses.length, target = await currentHead(a, f);
      // This is the actual visible workspace recovery control; no route navigation, reload or cache injection.
      const retry = b.page.getByRole('button', { name: 'Try again', exact: true }); await expect(retry).toBeVisible(); await retry.click();
      await expect.poll(() => b.net.responses.slice(responseIndex).some(value => value.path === f.prefix && value.status === 200), eventual).toBe(true);
      await expect.poll(() => b.net.reads(headPath(f)), eventual).toBeGreaterThan(headReads);
      await observed(b, target, deniedHeads); await expect(row(b.page, task)).toContainText(task.title, eventual);
      await expect(unavailable).toHaveCount(0); sameFrame(before, await frame(b.page));
      expect(await f.task(task.id)).toEqual(task); readonly(b); clean(a);
      await b.page.screenshot({ path: info.outputPath(`explicit-denial-recovery-${name}.png`) });
      await evidenceJson(info, `denial-${name}.json`, { transportInjected: true, actualMembershipRevocation: false, headDenials, rootDenials,
        restoredTransportDidNotResume: true, explicitAction: 'Try again', rootReadsBeforeRecovery: rootReads,
        recoveryResponses: b.net.responses.slice(responseIndex), before, after: await frame(b.page), b: b.net });
    } finally { await evidenceJson(info, `denial-traffic-${name}.json`, { transportInjected: true, actualMembershipRevocation: false, a: a.net, b: b.net }); await clients.close(); }
  });
});

test('Workspace live refresh desktop: a pinned immutable report payload stays selected and is not reread while live run lists catch up', async ({ browser, request, baseURL }, info) => {
  test.setTimeout(100_000);
  const f = await dailyFixture(request, baseURL, 'Live refresh pinned'), task = await f.createTask(`${f.token} frozen title`, { estimateMinutes: 60 });
  const period = await futurePeriod(f);
  await f.post(`/periods/${period.id}/commitments`, { workPackageId: task.workPackageId, membershipId: f.own.id, expectedAbsent: true, plannedMinutes: 60, allocations: [{ taskId: task.id, minutes: 60 }] }, periodCommitmentResponseSchema);
  const preview = (await f.post(`/periods/${period.id}/freeze-preview`, { scope: 'project' }, freezePreviewResponseSchema, 200)).data;
  const baseline = (await f.post(`/periods/${period.id}/freeze`, { scope: 'project', previewHash: preview.previewHash }, planBaselineResponseSchema, 200)).data;
  const run = (await f.post('/report-runs', { baselineId: baseline.id, membershipIds: [], knownEstimatesOnly: false }, weeklyPlanFactReportRunResponseSchema)).data;
  const clients = await pair(browser, baseURL, f, sizes[0][1]), { a, b } = clients;
  try {
    await prime(a, f); await prime(b, f, `${f.path}/week?period=${period.id}&view=report&run=${run.id}&worker=${f.own.id}`);
    const saved = b.page.getByRole('region', { name: 'Saved report', exact: true }); await expect(saved).toBeVisible();
    const text = await saved.innerText(), box = await saved.boundingBox(), url = b.page.url(), timeOrigin = await b.page.evaluate(() => performance.timeOrigin);
    const immutablePath = `${f.prefix}/report-runs/${run.id}`, reads = b.net.reads(immutablePath), rowReads = b.net.reads(`${immutablePath}/rows`), listReads = b.net.reads(`${f.prefix}/report-runs`), index = b.net.heads.length;
    expect(reads).toBeGreaterThan(0); expect(rowReads).toBeGreaterThan(0);
    const edited = await update(a, f, await f.task(task.id), { dueDate: '2027-05-20' }); await observed(b, await currentHead(a, f), index);
    await expect.poll(() => b.net.reads(`${f.prefix}/report-runs`), eventual).toBeGreaterThan(listReads);
    expect(await saved.innerText()).toBe(text); expect(await saved.boundingBox()).toEqual(box);
    expect(b.net.reads(immutablePath)).toBe(reads); expect(b.net.reads(`${immutablePath}/rows`)).toBe(rowReads);
    expect(b.page.url()).toBe(url); expect(await b.page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    const unchanged = await a.context.request.get(immutablePath); expect(unchanged.status()).toBe(200);
    expect(weeklyPlanFactReportRunResponseSchema.parse(await unchanged.json()).data).toEqual(run); readonly(b); clean(a);
    await evidenceJson(info, 'pinned-desktop.json', { run, receipt: edited.receipt, url, text, box, reads, rowReads, b: b.net });
  } finally { await evidenceJson(info, 'pinned-traffic-desktop.json', { run, a: a.net, b: b.net }); await clients.close(); }
});
