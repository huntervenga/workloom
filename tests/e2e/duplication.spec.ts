// Private compiled QA only: real current owner via fake Auth; no main runtime or existing user records.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { genericAggregateSettingsResponseSchema, planningCheckSettingsResponseSchema, projectResponseSchema, sectionResponseSchema, taskResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueListResponseSchema, taskFieldValueResponseSchema, type PlanningCheckRuleDto } from '@workloom/contracts';
import { duplicationResultResponseSchema, type DuplicationResultDto } from '../../packages/contracts/src/duplication.js';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, allTasks, apiRead, apiWrite, createFixtureTask, freshProject, requireValue, savedRow, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function put<T>(f: DailyProject, path: string, data: object, parser: { parse(value: unknown): T }) {
 const response = await f.page.request.put(`${APP}${path}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data }); expect(response.status()).toBe(200); return parser.parse(await response.json());
}
async function fixture(page: Page) {
 const f = await freshProject(page, provider, 'Ordinary reusable delivery', true), projectPath = `${f.prefix}/projects/${f.projectId}`, person = requireValue(f.teammates[0]);
 const project = (await apiRead(page, projectPath, projectResponseSchema)).data;
 const section = (await apiWrite(page, `${projectPath}/sections`, { name: 'Source delivery' }, sectionResponseSchema)).data;
 const fields = [];
 for (const name of ['Selected budget', 'Recorded amount']) fields.push((await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name, type: 'duration', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data);
 const budget = requireValue(fields[0]), actual = requireValue(fields[1]);
 const root = await createFixtureTask(f, 'Original completed delivery', { sectionId: section.id, statusId: f.doneId, description: 'A useful reusable description', responsibleMembershipId: person.id, participantMembershipIds: [f.owner.id, person.id], startDate: '2026-10-20', dueDate: '2026-10-23', priority: 'high' });
 const child = await createFixtureTask(f, 'Reusable detail', { sectionId: section.id, parentTaskId: root.id, statusId: f.doneId });
 for (const [task, field, minutes] of [[root, budget, 60], [root, actual, 30], [child, budget, 15]] as const) await put(f, `${f.prefix}/tasks/${task.id}/field-values/${field.id}`, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'duration', value: minutes } }, taskFieldValueResponseSchema);
 const aggregates = (await apiRead(page, `${projectPath}/field-aggregate-settings`, genericAggregateSettingsResponseSchema)).data;
 await put(f, `${projectPath}/field-aggregate-settings`, { expectedRevision: aggregates.revision, measures: [], headerWidgets: [{ group: { kind: 'section', sectionId: section.id }, widgets: [{ key: 'budget', label: 'Selected budget sum', kind: 'measure', measure: { key: 'budget_sum', operation: 'sum', fieldId: budget.id } }, { key: 'availability', kind: 'capacity', membershipId: person.id, range: { kind: 'project_dates' }, override: { minutes: 1800, note: 'Literal selected person' } }] }] }, genericAggregateSettingsResponseSchema);
 const settings = (await apiRead(page, `${projectPath}/planning-checks/settings`, planningCheckSettingsResponseSchema)).data;
 const rule: PlanningCheckRuleDto = { id: randomUUID(), name: 'Reusable planning target', kind: 'balance', enabled: true, hierarchy: 'all_tasks', filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null }, group: { kind: 'section', sectionId: section.id }, sumFieldId: budget.id, cohort: { kind: 'all_tasks' }, missingPlan: 'known_only', target: { kind: 'fixed', value: 2400, unit: 'minutes' }, under: { enabled: true, thresholdBps: 9000, fullIntensityAtBps: 5000, nearColor: '#fde68a', farColor: '#dc2626' }, over: { enabled: true, thresholdBps: 10000, fullIntensityAtBps: 15000, nearColor: '#fecaca', farColor: '#b91c1c' } };
 await put(f, `${projectPath}/planning-checks/settings`, { expectedRevision: settings.revision, config: { ...settings.config, enabled: true, rules: [rule] } }, planningCheckSettingsResponseSchema);
 const confirmedRoot = (await apiRead(page, `${f.prefix}/tasks/${root.id}`, taskResponseSchema)).data, confirmedChild = (await apiRead(page, `${f.prefix}/tasks/${child.id}`, taskResponseSchema)).data;
 return { f, projectPath, project, person, section, budget, actual, root: confirmedRoot, child: confirmedChild, rule };
}
async function sectionDialog(page: Page, name: string) {
 await page.getByRole('button', { name: 'Section actions for Source delivery', exact: true }).click(); await page.getByRole('menuitem', { name: 'Duplicate section', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Duplicate section', exact: true }); await expect(dialog).toBeVisible(); await dialog.getByRole('textbox', { name: 'Section name', exact: true }).fill(name); return dialog;
}
test.describe('ordinary task and reusable section duplication', () => {
 test.describe.configure({ mode: 'serial' }); test.use({ viewport: { width: 1600, height: 1100 } });
 test.beforeAll(async ({ baseURL }, info) => {
  if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Explicit private compiled49318 and one worker required.');
  if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth traces/video forbidden.');
  requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
 });
 test.afterAll(async () => { await provider?.close(); });
 for (const theme of ['light', 'dark'] as const) test(`${theme}: copies only chosen ordinary values, retries the identical task command and clones literal section settings with or without tasks`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { f, projectPath, project, person, section, budget, actual, root, child, rule } = await fixture(page);
  const sourceValues = await Promise.all([root, child].map(async task => (await apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)).data));
  await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table`); await expect(page.getByRole('heading', { level: 1, name: project.name, exact: true })).toBeVisible(); await expect(savedRow(page, root.id)).toBeVisible();
  if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await savedRow(page, root.id).hover(); await savedRow(page, root.id).getByRole('button', { name: `Task actions: ${root.title}`, exact: true }).click(); await page.getByRole('menuitem', { name: 'Duplicate task', exact: true }).click();
  const taskDialog = page.getByRole('dialog', { name: 'Duplicate task', exact: true }); await expect(taskDialog.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(`${root.title} (copy)`);
  for (const field of [budget, actual]) await expect(taskDialog.getByRole('checkbox', { name: field.name, exact: true })).not.toBeChecked();
  await expect(taskDialog.getByRole('checkbox', { name: 'Subtasks', exact: true })).toBeChecked(); await taskDialog.getByRole('checkbox', { name: 'Subtasks', exact: true }).uncheck(); await taskDialog.getByRole('textbox', { name: 'Task name', exact: true }).fill('Fresh task without values');
  await expect(taskDialog).toContainText('1 task will be created'); await expect(taskDialog).toContainText('0 custom values will be copied');
  const attempts: { key: string | undefined; body: string }[] = []; let firstResult: DuplicationResultDto | null = null;
  const duplicatePath = `${f.prefix}/tasks/${root.id}/duplicate`;
  await page.route(`**${duplicatePath}`, async route => {
   attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() ?? '' });
   const response = await route.fetch(); expect(response.status()).toBe(201); firstResult = duplicationResultResponseSchema.parse(await response.json()).data;
   if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response });
  });
  await taskDialog.getByRole('button', { name: 'Duplicate task', exact: true }).click(); await taskDialog.getByRole('button', { name: 'Retry the same copy', exact: true }).click(); await expect(taskDialog).toHaveCount(0);
  expect(attempts).toHaveLength(2); expect(attempts[0]?.key).toBeTruthy(); expect(attempts[1]).toEqual(attempts[0]); await page.unroute(`**${duplicatePath}`);
  // Read actual canonical rows after reload; an unknown response never creates a second copy.
  await page.reload(); let tasks = await allTasks(f); expect(tasks).toHaveLength(3); const copied = requireValue(tasks.find(task => task.title === 'Fresh task without values'));
  expect(firstResult).toMatchObject({ rootTaskId: copied.id, taskIds: [copied.id] }); expect(copied.statusId).toBe(f.todoId); expect(copied.parentTaskId).toBeNull(); expect(copied.description).toBe(root.description); expect(copied.responsibleMembershipId).toBe(person.id); expect(copied.startDate).toBe(root.startDate); expect(copied.dueDate).toBe(root.dueDate); expect(copied.priority).toBe('high'); expect(copied.workPackageId).not.toBe(root.workPackageId);
  expect((await apiRead(page, `${f.prefix}/tasks/${copied.id}/field-values`, taskFieldValueListResponseSchema)).data).toEqual([]); await expect(savedRow(page, copied.id)).toBeVisible();
  // Inserting after the root shifts its following child once in the project-global manual order.
  expect(copied.position).toBe(root.position + 1); expect(tasks.find(task => task.id === root.id)).toEqual(root);
  const shiftedChild = requireValue(tasks.find(task => task.id === child.id));
  expect(shiftedChild).toEqual({ ...child, position: child.position + 1, revision: child.revision + 1, updatedAt: copied.createdAt });
  expect(Date.parse(shiftedChild.updatedAt)).toBeGreaterThan(Date.parse(child.updatedAt));
  const empty = await sectionDialog(page, 'Reusable settings only'); await empty.getByRole('checkbox', { name: 'Copy tasks', exact: true }).uncheck(); await expect(empty.getByRole('checkbox', { name: 'Copy section summaries and planning checks', exact: true })).toBeChecked();
  await expect(empty).toContainText('0 tasks will be created'); await expect(empty).toContainText('2 summaries'); await expect(empty).toContainText('1 planning check'); await expect(empty).toContainText(person.displayName); await expect(empty).toContainText('People, periods and manual availability overrides keep their current selections.');
  const emptyAnswer = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${f.prefix}/sections/${section.id}/duplicate`); await empty.getByRole('button', { name: 'Duplicate section', exact: true }).click();
  const emptyResponse = await emptyAnswer; expect(emptyResponse.status()).toBe(201); const emptyResult = duplicationResultResponseSchema.parse(await emptyResponse.json()).data; expect(emptyResult.taskIds).toEqual([]); const emptySection = requireValue(emptyResult.section ?? undefined); await expect(empty).toHaveCount(0);
  await page.reload(); expect(await allTasks(f)).toHaveLength(3); await expect(page.getByRole('button', { name: 'Section actions for Reusable settings only', exact: true })).toBeVisible();
  const full = await sectionDialog(page, 'Delivery with tasks'); await expect(full.getByRole('checkbox', { name: 'Copy tasks', exact: true })).toBeChecked(); await expect(full.getByRole('checkbox', { name: 'Subtasks', exact: true })).toBeChecked();
  await expect(full.getByRole('checkbox', { name: budget.name, exact: true })).not.toBeChecked(); await expect(full.getByRole('checkbox', { name: actual.name, exact: true })).not.toBeChecked(); await full.getByRole('checkbox', { name: budget.name, exact: true }).check();
  await expect(full).toContainText('3 tasks will be created'); await expect(full).toContainText('2 custom values will be copied');
  const fullAnswer = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${f.prefix}/sections/${section.id}/duplicate`); await full.getByRole('button', { name: 'Duplicate section', exact: true }).click();
  const fullResponse = await fullAnswer; expect(fullResponse.status()).toBe(201); const fullResult = duplicationResultResponseSchema.parse(await fullResponse.json()).data; await expect(full).toHaveCount(0); expect(fullResult.taskIds).toHaveLength(3); const fullSection = requireValue(fullResult.section ?? undefined);
  await page.reload(); tasks = await allTasks(f); expect(tasks).toHaveLength(6); const fresh = tasks.filter(task => fullResult.taskIds.includes(task.id)); expect(fresh).toHaveLength(3); expect(fresh.every(task => task.statusId === f.todoId && task.sectionId === fullSection.id)).toBe(true);
  const freshRoot = requireValue(fresh.find(task => task.title === root.title)), freshChild = requireValue(fresh.find(task => task.title === child.title)); expect(freshChild.parentTaskId).toBe(freshRoot.id); expect(freshRoot.workPackageId).not.toBe(root.workPackageId);
  const values = (await apiRead(page, `${f.prefix}/tasks/${freshRoot.id}/field-values`, taskFieldValueListResponseSchema)).data; expect(values.map(value => value.fieldId)).toEqual([budget.id]); expect(values[0]?.value).toEqual({ type: 'duration', value: 60 });
  const aggregates = (await apiRead(page, `${projectPath}/field-aggregate-settings`, genericAggregateSettingsResponseSchema)).data;
  const checks = (await apiRead(page, `${projectPath}/planning-checks/settings`, planningCheckSettingsResponseSchema)).data;
  for (const target of [emptySection, fullSection]) {
   const widgets = requireValue(aggregates.headerWidgets?.find(item => item.group.kind === 'section' && item.group.sectionId === target.id)); expect(widgets.widgets).toHaveLength(2);
   expect(widgets.widgets.find(widget => widget.kind === 'capacity')).toMatchObject({ membershipId: person.id, range: { kind: 'project_dates' }, override: { minutes: 1800, note: 'Literal selected person' } });
   expect(widgets.widgets.find(widget => widget.kind === 'measure')).toMatchObject({ measure: { operation: 'sum', fieldId: budget.id } });
   const clonedRule = requireValue(checks.config.rules.find(candidate => candidate.kind === 'balance' && candidate.group.kind === 'section' && candidate.group.sectionId === target.id)); expect(clonedRule.id).not.toBe(rule.id); expect(clonedRule).toMatchObject({ sumFieldId: budget.id, target: rule.target });
  }
  expect(tasks.find(task => task.id === root.id)).toEqual(root); expect(tasks.find(task => task.id === child.id)).toEqual(shiftedChild);
  const retainedSourceValues = await Promise.all([root, child].map(async task => (await apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)).data));
  expect(retainedSourceValues).toEqual(sourceValues);
  await expect(page.getByRole('button', { name: 'Section actions for Delivery with tasks', exact: true })).toBeVisible(); await page.screenshot({ path: info.outputPath(`duplication-${theme}.png`), fullPage: true }); expect(errors).toEqual([]);
 });
});
