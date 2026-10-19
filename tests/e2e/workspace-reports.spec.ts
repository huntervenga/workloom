// Private compiled QA only: fake Auth and an isolated PostgreSQL. Never the user's workspace.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { genericReportDefinitionResponseSchema, leaveOverviewResponseSchema, leaveProfileResponseSchema, leaveRequestResponseSchema, leaveSettingsResponseSchema, projectResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueResponseSchema, taskProjectPlacementResponseSchema, workspaceReportResultResponseSchema, type GenericReportConfig, type TaskFieldDefinitionDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, requireValue, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function choose(page: Page, label: string, option: string) { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('listbox', { name: label, exact: true }).getByRole('option', { name: option, exact: true }).click(); }
async function field(f: DailyProject, projectId: string, name: string) { return (await apiWrite(f.page, `${f.prefix}/fields`, { projectId, name, type: 'duration', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data; }
function config(projectId: string, plan: TaskFieldDefinitionDto, fact: TaskFieldDefinitionDto): GenericReportConfig { return { projectId, hierarchy: 'all_tasks', measures: [{ key: 'plan', operation: 'sum', fieldId: plan.id }, { key: 'fact', operation: 'sum', fieldId: fact.id }], comparison: { planFieldId: plan.id, factFieldId: fact.id, completion: 'done_only' }, groupBy: { kind: 'assignee' }, filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } }; }
async function put<T>(f: DailyProject, path: string, data: object, schema: { parse(value: unknown): T }) { const response = await f.page.request.put(`${APP}${path}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data }); expect(response.status()).toBe(200); return schema.parse(await response.json()); }
async function setup(page: Page, label: string) {
  const f = await freshProject(page, provider, label), plan = await field(f, f.projectId, 'Effort budget'), fact = await field(f, f.projectId, 'Recorded effort');
  const task = await createFixtureTask(f, 'Canonical delivery across projects', { responsibleMembershipId: f.owner.id, dueDate: '2026-10-13', statusId: f.doneId });
  for (const [definition, minutes] of [[plan, 600], [fact, 900]] as const) await put(f, `${f.prefix}/tasks/${task.id}/field-values/${definition.id}`, { expectedRevision: 0, expectedDefinitionRevision: definition.revision, value: { type: 'duration', value: minutes } }, taskFieldValueResponseSchema);
  const first = (await apiWrite(page, `${f.prefix}/generic-reports`, { name: 'Delivery comparison', config: config(f.projectId, plan, fact) }, genericReportDefinitionResponseSchema)).data;
  const other = (await apiWrite(page, `${f.prefix}/projects`, { name: 'Shared project view' }, projectResponseSchema)).data;
  const otherPlan = await field(f, other.id, 'Another estimate'), otherFact = await field(f, other.id, 'Another actual');
  const second = (await apiWrite(page, `${f.prefix}/generic-reports`, { name: 'Linked comparison', config: config(other.id, otherPlan, otherFact) }, genericReportDefinitionResponseSchema)).data;
  await apiWrite(page, `${f.prefix}/tasks/${task.id}/placements`, { projectId: other.id, expectedTaskRevision: task.revision }, taskProjectPlacementResponseSchema);
  const path = `${f.prefix}/time-off`;
  await apiWrite(page, `${path}/template`, { expectedRevision: 0, effectiveYear: 2026, includeCompanyHolidays: false }, leaveSettingsResponseSchema);
  await put(f, `${path}/members/${f.owner.id}/profile`, { expectedRevision: 0, timezone: 'UTC', employmentStart: '2026-01-01', employmentEnd: null, accountingStart: '2026-01-01', openingBalances: [], schedulePeriods: [{ effectiveFrom: '2026-01-01', weeklyMinutes: [480, 480, 480, 480, 480, 0, 0] }], reason: 'Private workspace capacity fixture' }, leaveProfileResponseSchema);
  const overview = (await apiRead(page, `${path}/overview`, leaveOverviewResponseSchema)).data;
  const unpaid = requireValue(overview.settings?.policyVersions.flatMap(version => version.types).find(type => type.pausesAccrual && !type.consumesBalance));
  const leave = (await apiWrite(page, `${path}/requests`, { membershipId: f.owner.id, typeId: unpaid.id, startDate: '2026-10-14', endDate: '2026-10-14', note: 'Do not expose this private reason in reports', reason: 'Historical private QA fixture' }, leaveRequestResponseSchema)).data;
  await apiWrite(page, `${path}/requests/${leave.id}/decision`, { expectedRevision: leave.revision, decision: 'approve', approveNegative: false, reason: 'Historical private QA approval' }, leaveRequestResponseSchema);
  return { f, first, second, task };
}
test.describe('workspace manager dashboard', () => {
  test.describe.configure({ mode: 'serial' }); test.use({ viewport: { width: 1440, height: 1000 } });
  test.beforeAll(async ({ baseURL }, info) => { if (process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('PRIVATE_WORKSPACE_REPORT_QA_REQUIRED'); if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('NO_AUTH_RECORDING'); requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP }); });
  test.afterAll(async () => { await provider?.close(); });
  for (const theme of ['light', 'dark'] as const) test(`${theme}: capacity/plan/actual, canonical dedup and person trend survive navigation and reload`, async ({ page }, info) => {
    const { f, task } = await setup(page, `Workspace ${theme}`);
    await page.goto(`${APP}/app/w/${f.workspaceId}/reports`);
    const navigation = page.getByRole('navigation', { name: 'Workspace', exact: true });
    await expect(navigation.getByRole('link', { name: 'Reports', exact: true })).toHaveAttribute('aria-current', 'page');
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await page.getByLabel('From', { exact: true }).fill('2026-10-12'); await page.getByLabel('To', { exact: true }).fill('2026-10-18');
    const answer = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${f.prefix}/workspace-reports/query` && (response.request().postDataJSON() as { range?: { from: string } }).range?.from === '2026-10-12');
    await page.getByRole('button', { name: 'Apply', exact: true }).click(); const response = await answer; expect(response.status()).toBe(200); const result = workspaceReportResultResponseSchema.parse(await response.json()).data;
    expect(result.summary.taskCount).toBe(1); expect(result.rows.map(row => row.taskId)).toEqual([task.id]); expect(result.sources).toHaveLength(2);
    expect(result.summary.plan.value?.numerator).toBe('600'); expect(result.summary.fact.value?.numerator).toBe('900'); expect(result.capacity.totals.availableMinutes).toBe(1920);
    await expect(page.getByRole('article', { name: 'Available capacity', exact: true })).toContainText('32h'); await expect(page.getByRole('article', { name: 'Plan', exact: true })).toContainText('10h'); await expect(page.getByRole('article', { name: 'Actual', exact: true })).toContainText('15h');
    await expect(page.getByRole('region', { name: 'Weekly trend', exact: true })).toBeVisible(); await expect(page.getByRole('region', { name: 'Actual by category', exact: true })).toBeVisible();
    await expect(page.getByText('Do not expose this private reason in reports', { exact: true })).toHaveCount(0);
    const personName = page.getByRole('region', { name: 'People', exact: true }).getByRole('button', { name: f.owner.displayName, exact: true });
    const personGeometry = await personName.evaluate(button => { const style = getComputedStyle(button), range = document.createRange(); range.selectNodeContents(button); return { height: button.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight), textLines: [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length, width: button.clientWidth, textWidth: button.scrollWidth }; });
    expect(personGeometry.textLines).toBe(1); expect(personGeometry.height).toBeLessThanOrEqual(personGeometry.lineHeight + 1); expect(personGeometry.width).toBeGreaterThanOrEqual(140); expect(personGeometry.textWidth).toBeLessThanOrEqual(personGeometry.width);
    await expect(personName).toHaveAttribute('title', f.owner.displayName);
    await info.attach('workspace-person-name-geometry', { body: JSON.stringify(personGeometry), contentType: 'application/json' });

    await page.getByRole('button', { name: f.owner.displayName, exact: true }).click(); await choose(page, 'Chart interval', 'Monthly'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Monthly trend', exact: true })).toBeVisible(); const selectedUrl = page.url(); expect(new URL(selectedUrl).searchParams.has('dashboard')).toBe(true);
    await page.reload(); await expect(page.getByRole('region', { name: 'Monthly trend', exact: true })).toBeVisible(); await expect(page.getByRole('combobox', { name: 'People', exact: true })).toContainText(f.owner.displayName); await expect(page.getByLabel('From', { exact: true })).toHaveValue('2026-10-12');
    await page.goBack(); await expect(page.getByRole('region', { name: 'Weekly trend', exact: true })).toBeVisible(); await page.goForward(); await expect(page.getByRole('region', { name: 'Monthly trend', exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0)); await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath(`workspace-dashboard-${theme}.png`) });
    const nonReadWrites: string[] = []; page.on('request', request => { const path = new URL(request.url()).pathname; if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method()) && !path.endsWith('/query')) nonReadWrites.push(path); });
    await page.getByRole('button', { name: 'Refresh dashboard', exact: true }).click(); await expect(page.getByRole('article', { name: 'Actual', exact: true })).toContainText('15h'); expect(nonReadWrites).toEqual([]);
  });
});
