// Private compiled QA only. Five synthetic people belong to this test's fresh owned workspace.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import postgres from 'postgres';
import { Temporal } from 'temporal-polyfill';
import { genericReportDefinitionResponseSchema, genericReportResultResponseSchema, leaveOverviewResponseSchema, leaveProfileResponseSchema, leaveRequestResponseSchema, leaveSettingsResponseSchema, membershipListResponseSchema, projectResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, workspaceReportResultResponseSchema, type GenericReportConfig, type MembershipDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, choose, createFixtureTask, freshProject, requireValue, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function put<T>(f: DailyProject, path: string, data: object, parser: { parse(value: unknown): T }) {
 const response = await f.page.request.put(`${APP}${path}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data });
 expect(response.status()).toBe(200); return parser.parse(await response.json());
}
/** Extra two non-login fixtures. Explicit connection and fresh workspace census prevent touching existing data. */
async function fivePeople(f: DailyProject): Promise<MembershipDto[]> {
 const url = requirePrivateMembershipDatabase(), sql = postgres(url.href, { max: 1, connect_timeout: 5, idle_timeout: 3, onnotice: () => undefined });
 try {
  await sql.begin(async tx => {
   const [connection] = await tx<{ database: string; username: string; host: string; port: number }[]>`select current_database() as database, current_user as username, host(inet_server_addr()) as host, inet_server_port()::int as port`;
   if (!connection || connection.database !== decodeURIComponent(url.pathname.slice(1)) || connection.username !== 'workloom_qa' || connection.host !== '127.0.0.1' || connection.port !== 60651) throw Error('Private capacity fixture connection identity mismatch.');
   const [scope] = await tx<{ age: string; memberships: number; projects: number; tasks: number }[]>`
    select extract(epoch from (now() - w.created_at))::text as age,
      (select count(*)::int from memberships where workspace_id=w.id) as memberships,
      (select count(*)::int from projects where workspace_id=w.id) as projects,
      (select count(*)::int from tasks where workspace_id=w.id) as tasks
    from workspaces w join memberships m on m.workspace_id=w.id join users u on u.id=m.user_id
    where w.id=${f.workspaceId} and m.user_id=${f.actorId} and m.role='owner' and m.state='active' and u.kind='real'
      and exists(select 1 from projects p where p.id=${f.projectId} and p.workspace_id=w.id) for update of w`;
   if (!scope || !Number.isFinite(Number(scope.age)) || Number(scope.age) < 0 || Number(scope.age) > 300 || scope.memberships !== 3 || scope.projects !== 1 || scope.tasks !== 0) throw Error('Expected only this test fresh owner, two fixture teammates and empty project.');
   for (const displayName of ['Capacity teammate C', 'Capacity teammate D']) {
    const userId = randomUUID(), membershipId = randomUUID();
    await tx`insert into users (id, display_name, kind) values (${userId}, ${displayName}, 'fixture')`;
    await tx`insert into memberships (id, workspace_id, user_id, role) values (${membershipId}, ${f.workspaceId}, ${userId}, 'member')`;
   }
   await tx`update workspaces set permission_epoch=permission_epoch+1, updated_at=now() where id=${f.workspaceId}`;
  });
 } finally { await sql.end({ timeout: 5 }); }
 const people = (await apiRead(f.page, `${f.prefix}/memberships`, membershipListResponseSchema)).data;
 expect(people).toHaveLength(5); return people;
}
async function fixture(page: Page, theme: string) {
 const f = await freshProject(page, provider, `People capacity ${theme}`, true), people = await fivePeople(f);
 const owner = f.owner, a = requireValue(f.teammates[0]), unknown = requireValue(f.teammates[1]), c = requireValue(people.find(person => person.displayName === 'Capacity teammate C')), d = requireValue(people.find(person => person.displayName === 'Capacity teammate D'));
 const path = `${f.prefix}/time-off`, initial = (await apiRead(page, `${path}/overview`, leaveOverviewResponseSchema)).data;
 let monday = Temporal.PlainDate.from(initial.today).add({ days: 7 }); while (monday.dayOfWeek !== 1) monday = monday.add({ days: 1 });
 const from = monday.toString(), to = monday.add({ days: 6 }).toString(), year = monday.year;
 await apiWrite(page, `${path}/template`, { expectedRevision: 0, effectiveYear: year, includeCompanyHolidays: false }, leaveSettingsResponseSchema);
 for (const person of [owner, a, c, d]) await put(f, `${path}/members/${person.id}/profile`, { expectedRevision: 0, timezone: 'UTC', employmentStart: `${year}-01-01`, employmentEnd: null, accountingStart: `${year}-01-01`, openingBalances: [], schedulePeriods: [{ effectiveFrom: `${year}-01-01`, weeklyMinutes: [480, 480, 480, 480, 480, 0, 0] }], reason: 'Synthetic capacity fixture' }, leaveProfileResponseSchema);
 const overview = (await apiRead(page, `${path}/overview`, leaveOverviewResponseSchema)).data, unpaid = requireValue(overview.settings?.policyVersions.flatMap(version => version.types).find(type => type.pausesAccrual && !type.consumesBalance));
 const leave = (await apiWrite(page, `${path}/requests`, { membershipId: owner.id, typeId: unpaid.id, startDate: from, endDate: from, note: 'Private reason must not enter reporting', reason: '' }, leaveRequestResponseSchema)).data;
 await apiWrite(page, `${path}/requests/${leave.id}/decision`, { expectedRevision: leave.revision, decision: 'approve', approveNegative: false, reason: '' }, leaveRequestResponseSchema);
 const projectPath = `${f.prefix}/projects/${f.projectId}`, project = (await apiRead(page, projectPath, projectResponseSchema)).data;
 await apiWrite(page, projectPath, { expectedRevision: project.revision, dateRange: { from, to } }, projectResponseSchema, 'PATCH');
 const fields = [];
 for (const name of ['Budget hours', 'Recorded hours']) fields.push((await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name, type: 'duration', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data);
 const plan = requireValue(fields[0]), fact = requireValue(fields[1]);
 const category = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Work category', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Delivery', color: '#db2777' }, { name: 'Bugfix', color: '#0d9488' }] }, taskFieldDefinitionResponseSchema)).data;
 for (const [title, person, estimate, actual, categoryName, dueDate] of [
  ['Owner delivery', owner, 120, 60, 'Delivery', from], ['Owner earlier bugfix', owner, 60, 30, 'Bugfix', monday.subtract({ days: 14 }).toString()],
  ['Zero is recorded', a, 60, 0, 'Bugfix', from], ['Unknown is not zero', unknown, 120, null, 'Delivery', from],
  ['Teammate delivery', c, 60, 120, 'Delivery', from], ['Uncategorized work', d, 60, 60, null, from],
 ] as const) {
  const task = await createFixtureTask(f, title, { responsibleMembershipId: person.id, statusId: f.doneId, dueDate });
  for (const [definition, value] of [[plan, { type: 'duration', value: estimate }], ...(actual === null ? [] : [[fact, { type: 'duration', value: actual }]]), ...(categoryName === null ? [] : [[category, { type: 'single_select', value: requireValue(category.options.find(option => option.name === categoryName)).id }]])] as const) {
   await put(f, `${f.prefix}/tasks/${task.id}/field-values/${definition.id}`, { expectedRevision: 0, expectedDefinitionRevision: definition.revision, value }, taskFieldValueResponseSchema);
  }
 }
 const config: GenericReportConfig = { projectId: f.projectId, hierarchy: 'all_tasks', measures: [{ key: 'plan', operation: 'sum', fieldId: plan.id }, { key: 'fact', operation: 'sum', fieldId: fact.id }], comparison: { planFieldId: plan.id, factFieldId: fact.id, completion: 'all_tasks' }, groupBy: { kind: 'category', fieldId: category.id }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } };
 const report = (await apiWrite(page, `${f.prefix}/generic-reports`, { name: 'People capacity and work types', config }, genericReportDefinitionResponseSchema)).data;
 return { f, people, owner, a, unknown, c, d, report, from, to, monday, category, fact };
}
test.describe('independent available-hours period and full-scope person work-type cards', () => {
 test.describe.configure({ mode: 'serial' }); test.use({ viewport: { width: 1600, height: 1100 } });
 test.beforeAll(async ({ baseURL }, info) => {
  if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Explicit private compiled49318 and one worker required.');
  if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth traces/video forbidden.');
  requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
 });
 test.afterAll(async () => { await provider?.close(); });
 for (const theme of ['light', 'dark'] as const) test(`${theme}: project dates fill known capacity, personal donuts retain category colors and missing/zero states without changing task scope`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { f, owner, a, unknown, c, d, report, from, to, monday } = await fixture(page, theme);
  const result = (await apiWrite(page, `${f.prefix}/generic-reports/${report.id}/query`, { expectedRevision: report.revision, snapshotId: null, offset: 0, limit: 1 }, genericReportResultResponseSchema)).data;
  expect(result.rows).toHaveLength(1); expect(result.totalTasks).toBe(6); expect(result.measures.find(measure => measure.key === 'plan')?.value?.decimal).toBe('480'); expect(result.measures.find(measure => measure.key === 'fact')?.value?.decimal).toBe('270');
  const writes: string[] = []; page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith(f.prefix) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method()) && !/\/(?:query|field-aggregates|availability)$/.test(path)) writes.push(`${request.method()} ${path}`); });
  // Force only one detail row; every chart must still use the server's complete aggregate groups.
  await page.route(`**${f.prefix}/projects/${f.projectId}/field-aggregates`, async route => { const input = route.request().postDataJSON() as object; await route.continue({ postData: JSON.stringify({ ...input, offset: 0, limit: 1 }) }); });
  await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}/reports?report=${report.id}`);
  if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  const capacityPeriod = page.getByRole('region', { name: 'Available hours period', exact: true }), dashboard = page.getByRole('region', { name: 'Project dashboard', exact: true });
  const available = dashboard.getByRole('article', { name: 'Available capacity', exact: true }), plan = dashboard.getByRole('article', { name: 'Plan · Budget hours', exact: true }), actual = dashboard.getByRole('article', { name: 'Actual · Recorded hours', exact: true });
  const scopeDisclosure = capacityPeriod.getByLabel('Available hours period · Task scope', { exact: true }), periodExplanation = capacityPeriod.locator('[data-report-capacity-period]');
  await scopeDisclosure.click(); await expect(periodExplanation).toHaveText(`Available: ${from} – ${to} · Project dates`); await expect(periodExplanation).toBeVisible();
  await expect(capacityPeriod.getByText('Task totals: all project tasks matching the current filters; no task-date filter.', { exact: true })).toBeVisible(); await scopeDisclosure.click(); await expect(periodExplanation).not.toBeVisible();
  await expect(available).toContainText('152h'); await expect(available).toContainText('Known schedules only · 4 of 5 people'); await expect(plan).toContainText('8h'); await expect(actual).toContainText('4h 30m');
  const people = dashboard.getByRole('region', { name: 'Plan and actual by primary assignee', exact: true });
  await expect(people.locator(`tr[data-report-person="${owner.id}"]`)).toHaveAttribute('aria-label', `${owner.displayName} · Available: 32h · Plan: 3h · Actual: 1h 30m`);
  await expect(people.locator(`tr[data-report-person="${unknown.id}"]`)).toContainText('Schedule unknown'); await expect(people.locator(`tr[data-report-person="${unknown.id}"] [data-series="capacity"]`)).toHaveCount(0);
  const cards = dashboard.getByRole('region', { name: 'Work types by person', exact: true }), personCard = (id: string) => cards.locator(`[data-work-type-person="${id}"]`);
  await expect(cards.locator('[data-work-type-person]')).toHaveCount(5);
  await expect(personCard(owner.id)).toContainText('1h 30m'); await expect(personCard(owner.id)).toContainText('≈66.67%'); await expect(personCard(owner.id)).toContainText('≈33.33%');
  const ownerRing = personCard(owner.id).locator('[data-work-type-ring]'); await expect(ownerRing).toHaveCSS('background-image', /conic-gradient/); await expect(ownerRing).toHaveCSS('background-image', /rgb\(219, 39, 119\)/); await expect(ownerRing).toHaveCSS('background-image', /rgb\(13, 148, 136\)/);
  await expect(personCard(a.id)).toContainText('Recorded total is zero.'); await expect(personCard(a.id).locator('[data-work-type-ring]')).toHaveCSS('background-image', 'none');
  await expect(personCard(unknown.id)).toContainText('No recorded values.'); await expect(personCard(unknown.id).locator('[data-work-type-ring]')).toHaveCSS('background-image', 'none');
  await expect(personCard(c.id)).toContainText('2h'); await expect(personCard(d.id)).toContainText('Uncategorized'); await expect(personCard(d.id)).toContainText('100%');
  await cards.getByRole('textbox', { name: 'Search people', exact: true }).fill(c.displayName); await expect(cards.locator('[data-work-type-person]')).toHaveCount(1); await expect(personCard(c.id)).toBeVisible();
  await cards.getByRole('textbox', { name: 'Search people', exact: true }).fill(''); await choose(page, cards, 'Sort people', 'Actual time'); await expect(cards.locator('[data-work-type-person]').first()).toHaveAttribute('data-work-type-person', c.id);
  await choose(page, dashboard, 'Work type breakdown', 'Choose a category field'); await expect(cards).toContainText('Choose a category field and configure an Actual SUM measure'); await choose(page, dashboard, 'Work type breakdown', 'Work category'); await expect(cards.locator('[data-work-type-person]')).toHaveCount(5); await expect(ownerRing).toHaveCSS('background-image', /rgb\(219, 39, 119\)/);
  await expect(cards.getByRole('button', { name: 'Previous people', exact: true })).toBeDisabled(); await expect(cards.getByRole('button', { name: 'Next people', exact: true })).toBeDisabled();
  await page.getByText('Initial plan snapshots', { exact: true }).click(); await expect(page.getByRole('combobox', { name: 'Initial snapshot', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Capture initial snapshot', exact: true })).toBeDisabled();
  await choose(page, capacityPeriod, 'Available hours period', 'None'); await scopeDisclosure.click(); await expect(periodExplanation).toHaveText('Available hours are off for this view.'); await expect(periodExplanation).toBeVisible(); await scopeDisclosure.click(); await expect(periodExplanation).not.toBeVisible(); await expect(available.getByText('—', { exact: true })).toBeVisible(); await expect(actual).toContainText('4h 30m');
  await choose(page, capacityPeriod, 'Available hours period', 'Custom range'); await capacityPeriod.getByLabel('From (inclusive)', { exact: true }).fill(from); await capacityPeriod.getByLabel('To (inclusive)', { exact: true }).fill(monday.add({ days: 1 }).toString()); await capacityPeriod.getByRole('button', { name: 'Apply period', exact: true }).click();
  await expect(available).toContainText('56h'); await expect(actual).toContainText('4h 30m'); await expect(plan).toContainText('8h'); await expect(personCard(owner.id)).toContainText('1h 30m');
  await choose(page, capacityPeriod, 'Available hours period', 'Project dates'); await expect(available).toContainText('152h');
  await expect(page.getByRole('navigation', { name: 'Project views', exact: true })).toBeVisible(); await expect(page.getByText('Private reason must not enter reporting', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath(`capacity-people-${theme}.png`), fullPage: true });
  await page.unroute(`**${f.prefix}/projects/${f.projectId}/field-aggregates`);
  await page.goto(`${APP}/app/w/${f.workspaceId}/reports`); await page.getByLabel('From', { exact: true }).fill(from); await page.getByLabel('To', { exact: true }).fill(to);
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${f.prefix}/workspace-reports/query` && (response.request().postDataJSON() as { range?: { from: string } }).range?.from === from);
  await page.getByRole('button', { name: 'Apply', exact: true }).click(); const workspaceResponse = await responsePromise; expect(workspaceResponse.status()).toBe(200); const workspace = workspaceReportResultResponseSchema.parse(await workspaceResponse.json()).data;
  expect(workspace.summary.taskCount).toBe(5); expect(workspace.summary.fact.value?.numerator).toBe('240'); expect(workspace.capacity.totals.availableMinutes).toBe(9120);
  await expect(page.getByRole('article', { name: 'Available capacity', exact: true })).toContainText('152h'); await expect(page.getByRole('article', { name: 'Actual', exact: true })).toContainText('4h');
  expect((await apiRead(page, `${f.prefix}/generic-reports/${report.id}`, genericReportDefinitionResponseSchema)).data).toEqual(report);
  expect((await apiRead(page, `${f.prefix}/projects/${f.projectId}`, projectResponseSchema)).data.dateRange).toEqual({ from, to }); expect(writes).toEqual([]); expect(errors).toEqual([]);
 });
});
