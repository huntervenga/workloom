// Synthetic private compiled QA only. No user fixture, main database or port4310 access.
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { errorResponseSchema, planningCheckAssessmentResponseSchema, planningCheckSettingsResponseSchema, projectColumnsResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueListResponseSchema, taskFieldValueResponseSchema, type PlanningCheckRuleDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, openTable, savedRow, type DailyProject } from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const cell = (page: Page, taskId: string, fieldId: string) => savedRow(page, taskId).locator(`[data-inline-field-cell="${taskId}:${fieldId}"]`);
const issue = (page: Page, taskId: string, fieldId: string) => cell(page, taskId, fieldId).locator('[data-field-advisory]');
async function value(f: DailyProject, taskId: string, fieldId: string) {
  return (await apiRead(f.page, `${f.prefix}/tasks/${taskId}/field-values`, taskFieldValueListResponseSchema)).data.find(row => row.fieldId === fieldId)?.value ?? null;
}

async function apiPut<T>(page: Page, path: string, data: object, parser: { parse: (value: unknown) => T }): Promise<T> {
  const response = await page.request.put(`${APP}${path}`, { headers: { Origin: APP, 'Idempotency-Key': randomUUID() }, data });
  const body: unknown = await response.json(), error = errorResponseSchema.safeParse(body);
  expect(response.status(), error.success ? JSON.stringify({ code: error.data.error.code, message: error.data.error.message }) : 'Private response did not match the error schema.').toBe(200);
  return parser.parse(body);
}

// API configuration isolates this suite to cell presentation; editor workflow is covered separately.
test.describe('soft ordinary field planning advisories', () => {
  test.use({ viewport: { width: 1600, height: 1000 } });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Explicit private compiled49318 and one worker required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth traces/video forbidden.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  for (const theme of ['light', 'dark'] as const) test(`missing notices preserve inline and bulk autosave, zero/false and Undo · ${theme}`, async ({ page }, info) => {
    test.setTimeout(100_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const f = await freshProject(page, provider, `Planning advisory ${theme}`), projectPath = `${f.prefix}/projects/${f.projectId}`, checksPath = `${projectPath}/planning-checks`;
    const a = await createFixtureTask(f, 'Advisory item A'), b = await createFixtureTask(f, 'Advisory item B');
    const duration = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Effort allowance', type: 'duration', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data;
    const flag = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Approved', type: 'boolean', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data;
    const columns = (await apiRead(page, `${projectPath}/columns`, projectColumnsResponseSchema)).data;
    await apiWrite(page, `${projectPath}/columns`, { expectedRevision: columns.revision, columns: [duration, flag].map((field, position) => ({ fieldId: field.id, visible: true, width: 180, position })) }, projectColumnsResponseSchema, 'PATCH');
    await apiPut(page, `${f.prefix}/tasks/${a.id}/field-values/${flag.id}`, { expectedRevision: 0, expectedDefinitionRevision: flag.revision, value: { type: 'boolean', value: true } }, taskFieldValueResponseSchema);
    const initial = (await apiRead(page, `${checksPath}/settings`, planningCheckSettingsResponseSchema)).data;
    expect(initial.config).toEqual({ enabled: false, rules: [] });
    const rules: PlanningCheckRuleDto[] = [duration, flag].map(field => ({ id: randomUUID(), kind: 'presence', name: `${field.name} needs a value`, enabled: true, fieldId: field.id, color: '#ffffff', severity: 'warning', hierarchy: 'all_tasks', filters: { statusGroups: [], tagIds: [], assignee: { kind: 'all' }, dateRange: null } }));
    const settings = (await apiPut(page, `${checksPath}/settings`, { expectedRevision: initial.revision, config: { enabled: true, rules } }, planningCheckSettingsResponseSchema)).data;
    const assessment = (await apiWrite(page, `${checksPath}/query`, { expectedSettingsRevision: settings.revision }, planningCheckAssessmentResponseSchema)).data;
    expect(assessment.summary.missingRequiredTasks).toBe(2);
    await openTable(f);
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(issue(page, a.id, duration.id)).toHaveCount(1); await expect(issue(page, b.id, flag.id)).toHaveCount(1);
    await expect(issue(page, a.id, duration.id)).toHaveAttribute('role', 'img');
    await expect(issue(page, a.id, duration.id)).toHaveAttribute('aria-label', /Effort allowance/);
    const geometry = await cell(page, a.id, duration.id).boundingBox(); expect(geometry).not.toBeNull();
    const rowBefore = await savedRow(page, a.id).boundingBox(); expect(rowBefore).not.toBeNull();
    await expect(cell(page, a.id, duration.id).locator('[aria-required], [aria-invalid]')).toHaveCount(0);
    const label = `Edit Effort allowance for ${a.title}`;
    await cell(page, a.id, duration.id).getByRole('button', { name: label, exact: true }).click();
    await cell(page, a.id, duration.id).getByRole('textbox', { name: label, exact: true }).fill('0');
    await cell(page, a.id, duration.id).getByRole('textbox', { name: label, exact: true }).press('Enter');
    await expect.poll(() => value(f, a.id, duration.id)).toEqual({ type: 'duration', value: 0 });
    await expect(issue(page, a.id, duration.id)).toHaveCount(0); // Real zero is filled, not missing.
    await expect(page.locator('[data-task-panel]')).toHaveCount(0);
    await expect.poll(async () => (await savedRow(page, a.id).boundingBox())?.height).toBe(rowBefore?.height);
    await expect.poll(async () => (await cell(page, a.id, duration.id).boundingBox())?.width).toBe(geometry?.width);
    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).focus(); await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => value(f, a.id, duration.id)).toEqual({ type: 'duration', value: null });
    await expect(issue(page, a.id, duration.id)).toHaveCount(1);

    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).click();
    await savedRow(page, b.id).locator(`[data-task-select="${b.id}"]`).click({ modifiers: ['Shift'] });
    await cell(page, a.id, duration.id).getByRole('button', { name: label, exact: true }).click();
    await cell(page, a.id, duration.id).getByRole('textbox', { name: label, exact: true }).fill('0');
    await cell(page, a.id, duration.id).getByRole('textbox', { name: label, exact: true }).press('Enter');
    await expect.poll(() => Promise.all([a, b].map(task => value(f, task.id, duration.id)))).toEqual([{ type: 'duration', value: 0 }, { type: 'duration', value: 0 }]);
    await expect(issue(page, a.id, duration.id)).toHaveCount(0); await expect(issue(page, b.id, duration.id)).toHaveCount(0);
    await cell(page, a.id, flag.id).getByRole('checkbox', { name: `Edit Approved for ${a.title}`, exact: true }).click();
    await expect.poll(() => Promise.all([a, b].map(task => value(f, task.id, flag.id)))).toEqual([{ type: 'boolean', value: false }, { type: 'boolean', value: false }]);
    await expect(issue(page, a.id, flag.id)).toHaveCount(0); await expect(issue(page, b.id, flag.id)).toHaveCount(0);
    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).focus(); await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => Promise.all([a, b].map(task => value(f, task.id, flag.id)))).toEqual([{ type: 'boolean', value: true }, { type: 'boolean', value: null }]);
    await expect(issue(page, a.id, flag.id)).toHaveCount(0); await expect(issue(page, b.id, flag.id)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(savedRow(page, a.id)).toHaveAttribute('aria-selected', 'false');
    await page.reload();
    await expect(issue(page, a.id, duration.id)).toHaveCount(0); await expect(issue(page, b.id, flag.id)).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`planning-field-advisories-${theme}.png`) });
    expect(errors).toEqual([]);
  });
});
