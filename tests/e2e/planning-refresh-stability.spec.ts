// Private compiled49318 / fakeAuth49319 / owned60651 only. Never main runtime or user records.
import { randomUUID } from 'node:crypto';
import { expect, test, type APIResponse, type Page, type Request, type Route } from '@playwright/test';
import postgres from 'postgres';
import { genericAggregateSettingsResponseSchema, planningCheckSettingsResponseSchema, projectColumnsResponseSchema, projectResponseSchema, sectionResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, taskFieldValueListResponseSchema, workspaceChangeHeadResponseSchema, type PlanningCheckRuleDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, savedRow, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function put<T>(page: Page, path: string, data: object, parser: { parse(value: unknown): T }) {
 const response = await page.request.put(`${APP}${path}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data });
 expect(response.status()).toBe(200); return parser.parse(await response.json());
}
const animationFrames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const wakeHead = (page: Page) => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.dispatchEvent(new Event('focus')); });
function isConfirmedCancelledFulfillment(error: unknown, request: Request, aborted: WeakSet<Request>): boolean {
 return error instanceof Error && error.message === 'route.fulfill: Route is already handled!' && aborted.has(request) && request.failure()?.errorText === 'net::ERR_ABORTED';
}
async function fulfillHeldResponse(route: Route, response: APIResponse, aborted: WeakSet<Request>, phase: string) {
 try { await route.fulfill({ response }); } catch (error) {
  if (!isConfirmedCancelledFulfillment(error, route.request(), aborted)) throw error;
  console.info(JSON.stringify({ diagnostic: 'held-response', phase, path: new URL(route.request().url()).pathname, outcome: 'exact-request-aborted' }));
 }
}
async function updateMinutes(f: DailyProject, taskId: string, fieldId: string, definitionRevision: number, minutes: number) {
 const values = (await apiRead(f.page, `${f.prefix}/tasks/${taskId}/field-values`, taskFieldValueListResponseSchema)).data;
 await put(f.page, `${f.prefix}/tasks/${taskId}/field-values/${fieldId}`, { expectedRevision: values.find(value => value.fieldId === fieldId)?.revision ?? 0, expectedDefinitionRevision: definitionRevision, value: { type: 'duration', value: minutes } }, taskFieldValueResponseSchema);
}
/** No role is changed: a real new epoch must still invalidate old presentation authority. */
async function bumpPrivateEpoch(f: DailyProject) {
 const url = requirePrivateMembershipDatabase(), sql = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 3, onnotice: () => undefined });
 try { await sql.begin(async tx => {
  const [connection] = await tx<{ database: string; username: string; host: string; port: number }[]>`select current_database() as database, current_user as username, host(inet_server_addr()) as host, inet_server_port()::int as port`;
  if (!connection || connection.database !== decodeURIComponent(url.pathname.slice(1)) || connection.username !== 'workloom_qa' || connection.host !== '127.0.0.1' || connection.port !== 60651) throw Error('Private epoch fixture connection mismatch.');
  const [scope] = await tx<{ age: string; memberships: number; projects: number; tasks: number }[]>`
   select extract(epoch from (now()-w.created_at))::text as age,
    (select count(*)::int from memberships where workspace_id=w.id) as memberships,
    (select count(*)::int from projects where workspace_id=w.id) as projects,
    (select count(*)::int from tasks where workspace_id=w.id) as tasks
   from workspaces w join memberships m on m.workspace_id=w.id join users u on u.id=m.user_id
   where w.id=${f.workspaceId} and m.user_id=${f.actorId} and m.role='owner' and m.state='active' and u.kind='real'
    and exists(select 1 from projects p where p.workspace_id=w.id and p.id=${f.projectId}) for update of w`;
  if (!scope || !Number.isFinite(Number(scope.age)) || Number(scope.age)<0 || Number(scope.age)>300 || scope.memberships!==1 || scope.projects!==1 || scope.tasks!==2) throw Error('Epoch fixture requires only this test fresh owner/project/two tasks.');
  await tx`update workspaces set permission_epoch=permission_epoch+1,updated_at=now() where id=${f.workspaceId}`;
 }); } finally { await sql.end({ timeout: 5 }); }
}
test.describe('same-scope planning and table metric background refresh', () => {
 test.use({ viewport: { width: 1600, height: 1000 } });
 test.beforeAll(async ({ baseURL }, info) => {
  if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Explicit private compiled49318 and one worker required.');
  if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth traces/video forbidden.');
  requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
 });
 test.afterAll(async () => { await provider?.close(); });
 for (const theme of ['light', 'dark'] as const) test(`${theme}: confirmed warnings, section summaries and footer values do not disappear while replacement reads are held`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const f = await freshProject(page, provider, 'Refresh stability'), activeRequests = new Set<Request>(), abortedRequests = new WeakSet<Request>(), projectPath = `${f.prefix}/projects/${f.projectId}`, checksPath = `${projectPath}/planning-checks`;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith(f.prefix)) activeRequests.add(request); });
  page.on('requestfinished', request => activeRequests.delete(request)); page.on('requestfailed', request => { activeRequests.delete(request); if (request.failure()?.errorText === 'net::ERR_ABORTED') abortedRequests.add(request); });
  const project = (await apiRead(page, projectPath, projectResponseSchema)).data;
  const section = (await apiWrite(page, `${projectPath}/sections`, { name: 'Delivery work' }, sectionResponseSchema)).data;
  const field = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Effort allowance', type: 'duration', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data;
  const a = await createFixtureTask(f, 'Editable delivery', { sectionId: section.id }), b = await createFixtureTask(f, 'Still needs an estimate', { sectionId: section.id });
  await put(page, `${f.prefix}/tasks/${a.id}/field-values/${field.id}`, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'duration', value: 60 } }, taskFieldValueResponseSchema);
  const columns = (await apiRead(page, `${projectPath}/columns`, projectColumnsResponseSchema)).data;
  await apiWrite(page, `${projectPath}/columns`, { expectedRevision: columns.revision, columns: [{ fieldId: field.id, visible: true, width: 180, position: 0 }] }, projectColumnsResponseSchema, 'PATCH');
  const settings = (await apiRead(page, `${checksPath}/settings`, planningCheckSettingsResponseSchema)).data;
  const filters = { statusGroups: [], tagIds: [], assignee: { kind: 'all' as const }, dateRange: null };
  const rules: PlanningCheckRuleDto[] = [
   { id: randomUUID(), name: 'Estimate required', kind: 'presence', enabled: true, fieldId: field.id, severity: 'critical', color: '#dc2626', hierarchy: 'all_tasks', filters },
   { id: randomUUID(), name: 'Delivery load', kind: 'balance', enabled: true, hierarchy: 'all_tasks', filters, group: { kind: 'section', sectionId: section.id }, sumFieldId: field.id, cohort: { kind: 'all_tasks' }, missingPlan: 'known_only', target: { kind: 'fixed', value: 2400, unit: 'minutes' }, under: { enabled: true, thresholdBps: 9000, fullIntensityAtBps: 5000, nearColor: '#fde68a', farColor: '#dc2626' }, over: { enabled: true, thresholdBps: 10000, fullIntensityAtBps: 15000, nearColor: '#fecaca', farColor: '#b91c1c' } },
  ];
  const checks = (await put(page, `${checksPath}/settings`, { expectedRevision: settings.revision, config: { enabled: true, rules } }, planningCheckSettingsResponseSchema)).data;
  const aggregate = (await apiRead(page, `${projectPath}/field-aggregate-settings`, genericAggregateSettingsResponseSchema)).data;
  await put(page, `${projectPath}/field-aggregate-settings`, { expectedRevision: aggregate.revision, measures: [{ key: 'effort', fieldId: field.id, operation: 'sum' }], headerWidgets: [{ group: { kind: 'section', sectionId: section.id }, widgets: [{ key: 'delivery_effort', kind: 'measure', measure: { key: 'effort', fieldId: field.id, operation: 'sum' } }] }] }, genericAggregateSettingsResponseSchema);
  await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table`);
  await expect(page.getByRole('heading', { level: 1, name: project.name, exact: true })).toBeVisible(); await expect(savedRow(page, b.id)).toBeVisible();
  if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const badge = savedRow(page, b.id).locator(`[data-inline-field-cell="${b.id}:${field.id}"] [data-field-advisory]`);
  const group = page.locator('[data-task-group-label]').filter({ has: page.getByRole('button', { name: 'Collapse section “Delivery work”', exact: true }) });
  const footer = page.locator('tfoot').getByRole('button', { name: 'Calculation for Effort allowance', exact: true });
  const footerValues = page.locator('[data-task-project-aggregates]'), widget = group.locator('[data-section-widgets]'), load = group.locator('[data-planning-group]').getByRole('button', { name: /Delivery load/ });
  await expect(badge).toHaveCount(1); await expect(widget).toContainText('1h'); await expect(load).toContainText('Underplanned'); await expect(footer).toContainText('1h');
  const initialRow = await savedRow(page, b.id).boundingBox(); expect(initialRow).not.toBeNull();
  const held = new Set<string>(); let releaseReads: () => void = () => undefined;
  const barrier = new Promise<void>(resolve => { releaseReads = resolve; });
  const paths = new Set([`${checksPath}/query`, `${projectPath}/field-aggregates`, `${projectPath}/header-widgets/query`]);
  await page.route('**/api/v1/workspaces/**', async route => {
   const path = new URL(route.request().url()).pathname;
   if (!paths.has(path) || route.request().method() !== 'POST') { await route.continue(); return; }
   const response = await route.fetch(); held.add(path); await barrier; await fulfillHeldResponse(route, response, abortedRequests, 'analytical');
  });
  try {
   const label = `Edit Effort allowance for ${a.title}`, cell = savedRow(page, a.id).locator(`[data-inline-field-cell="${a.id}:${field.id}"]`);
   await cell.getByRole('button', { name: label, exact: true }).click(); await cell.getByRole('textbox', { name: label, exact: true }).fill('2:00'); await cell.getByRole('textbox', { name: label, exact: true }).press('Enter');
   await expect.poll(() => held.size, { message: 'Actual background assessment, header and aggregate requests are all held' }).toBe(3);
   await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
   await expect(badge).toHaveCount(1); await expect(widget).toContainText('1h'); await expect(load).toContainText('Underplanned'); await expect(footer).toContainText('1h');
   const pendingRow = await savedRow(page, b.id).boundingBox(); expect(pendingRow).not.toBeNull(); expect(pendingRow?.height).toBe(initialRow?.height); expect(pendingRow?.y).toBe(initialRow?.y); expect(pendingRow?.width).toBe(initialRow?.width);
   await expect(page.locator('[data-task-panel]')).toHaveCount(0); await page.screenshot({ path: info.outputPath(`refresh-held-${theme}.png`) });
  } finally { releaseReads(); }
  await expect(widget).toContainText('2h'); await expect(footer).toContainText('2h'); await expect(load).toContainText('2h / 40h'); await expect(badge).toHaveCount(1);
  await page.unrouteAll({ behavior: 'wait' });
  // Complete a genuine changed-head catch-up before testing a later same-authority lease.
  const settleHead = async () => {
   const current = (await apiRead(page, `${f.prefix}/change-head`, workspaceChangeHeadResponseSchema)).data;
   const observed = page.waitForResponse(async response => {
    if (response.request().method() !== 'GET' || new URL(response.url()).pathname !== `${f.prefix}/change-head` || response.status() !== 200) return false;
    const head = workspaceChangeHeadResponseSchema.parse(await response.json()).data; return head.changeSeq === current.changeSeq && head.permissionEpoch === current.permissionEpoch && head.actorUserId === f.actorId && head.workspaceId === f.workspaceId;
   });
   await wakeHead(page); await observed; await animationFrames(page); await expect.poll(() => activeRequests.size).toBe(0); await animationFrames(page); await expect.poll(() => activeRequests.size).toBe(0);
  };
  await settleHead();
  const metadata = new Set([f.prefix, projectPath]);
  const holdMetadata = async () => {
   const requested = new Set<string>(); let release: () => void = () => undefined;
   const wait = new Promise<void>(resolve => { release = resolve; });
   await page.route('**/api/v1/workspaces/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const authority = route.request().method() === 'GET' && metadata.has(path), analytical = route.request().method() === 'POST' && paths.has(path);
    if (!authority && !analytical) { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); if (authority) requested.add(path); await wait;
    await fulfillHeldResponse(route, response, abortedRequests, 'authority-and-analytical');
   });
   return { requested, release };
  };
  const meta = await holdMetadata(), beforeRemote = await savedRow(page, b.id).boundingBox();
  try {
   await updateMinutes(f, a.id, field.id, field.revision, 180); await wakeHead(page);
   await expect.poll(() => meta.requested.size, { message: 'Changed head started real workspace and project metadata reads' }).toBe(2); await animationFrames(page);
   await expect(badge).toHaveCount(1); await expect(widget).toContainText('2h'); await expect(footerValues).toContainText('2h'); await expect(load).toContainText('Underplanned');
   const pending = await savedRow(page, b.id).boundingBox(); expect(pending).toEqual(beforeRemote);
   // Leased text remains visible while the existing strict analytics write controls stay unavailable.
   await expect(footer).toHaveCount(0); await expect(group.getByRole('button', { name: 'Configure summary for Delivery work', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Checks', exact: true })).toHaveCount(0);
   await expect(load).toBeDisabled(); await expect(group.getByRole('button', { name: 'Estimate required · 1', exact: true })).toBeDisabled();
   await expect(savedRow(page, a.id).getByRole('textbox')).toHaveCount(0); await page.screenshot({ path: info.outputPath(`refresh-metadata-held-${theme}.png`) });
  } finally { meta.release(); }
  await expect(widget).toContainText('3h'); await expect(footer).toContainText('3h'); await page.unrouteAll({ behavior: 'wait' }); await settleHead();
  // A genuinely different permission epoch must never borrow the old analytical presentation.
  const epochMeta = await holdMetadata();
  try {
   await bumpPrivateEpoch(f); await wakeHead(page); await expect.poll(() => epochMeta.requested.size).toBe(2); await animationFrames(page);
   await expect(badge).toHaveCount(0); await expect(group.locator('[data-section-widgets]')).toHaveCount(0); await expect(group.locator('[data-planning-group] button', { hasText: 'Underplanned' })).toHaveCount(0);
  } finally { epochMeta.release(); }
  await page.unrouteAll({ behavior: 'wait' }); await expect(widget).toContainText('3h'); await expect(badge).toHaveCount(1); await settleHead();
  // Failed current metadata invalidates even a same-authority presentation; normal retries stay unchanged.
  let metadataErrors = 0, firstFailureDelivered = false, releaseRetry: () => void = () => undefined;
  const retryBarrier = new Promise<void>(resolve => { releaseRetry = resolve; });
  await page.route(`**${projectPath}`, async route => {
   if (route.request().method() !== 'GET') { await route.continue(); return; }
   const attempt = ++metadataErrors;
   if (attempt >= 2) await retryBarrier;
   if (route.request().failure()) return;
   await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Private current metadata failure' }, meta: { requestId: 'private-metadata-read' } }) });
   if (attempt === 1) firstFailureDelivered = true;
  });
  try {
   await updateMinutes(f, a.id, field.id, field.revision, 240); await wakeHead(page);
   // First503 is delivered, but the second attempt cannot finish: final error status cannot make this pass.
   await expect.poll(() => firstFailureDelivered && metadataErrors >= 2).toBe(true); await animationFrames(page);
   await expect(badge).toHaveCount(0); await expect(group.locator('[data-section-widgets]')).toHaveCount(0);
   await page.screenshot({ path: info.outputPath(`refresh-first-failure-retry-held-${theme}.png`) });
  } finally { releaseRetry(); }
  await expect.poll(() => metadataErrors).toBeGreaterThanOrEqual(3);
  await expect(badge).toHaveCount(0); await expect(group.locator('[data-section-widgets]')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'wait' }); await page.reload(); await expect(widget).toContainText('4h'); await expect(footer).toContainText('4h'); await expect(badge).toHaveCount(1);
  // A genuinely disabled scope must clear the old confirmed assessment on the next real load.
  await put(page, `${checksPath}/settings`, { expectedRevision: checks.revision, config: { enabled: false, rules } }, planningCheckSettingsResponseSchema);
  await page.reload(); await expect(page.getByRole('button', { name: 'Checks', exact: true })).toBeVisible(); await expect(badge).toHaveCount(0); await expect(load).toHaveCount(0);
  await expect(widget).toContainText('4h'); await expect(footer).toContainText('4h'); expect(errors).toEqual([]);
 });
});
