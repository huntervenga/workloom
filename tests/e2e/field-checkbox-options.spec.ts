// Disposable compiled QA only. This spec never targets the user's database or port4310.
import { expect, test, type Page } from '@playwright/test';
import { taskFieldDefinitionResponseSchema, taskFieldDefinitionListResponseSchema, taskFieldValueListResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, openTable, savedRow, requireValue, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const cell = (page: Page, taskId: string, fieldId: string) => savedRow(page, taskId).locator(`[data-inline-field-cell="${taskId}:${fieldId}"]`);
async function values(f: DailyProject, taskId: string, fieldId: string) {
  return (await apiRead(f.page, `${f.prefix}/tasks/${taskId}/field-values`, taskFieldValueListResponseSchema)).data.find(row => row.fieldId === fieldId)?.value ?? null;
}
async function definitions(f: DailyProject) {
  return (await apiRead(f.page, `${f.prefix}/fields?projectId=${f.projectId}`, taskFieldDefinitionListResponseSchema)).data;
}
async function editOptions(f: DailyProject) {
  await f.page.getByRole('button', { name: 'Column options for ReportType', exact: true }).click();
  await f.page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
  const dialog = f.page.getByRole('dialog', { name: 'Project columns', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Column name', exact: true })).toHaveValue('ReportType');
  await expect(dialog.getByRole('region', { name: 'Options', exact: true })).toBeVisible();
  return dialog;
}

test.describe('Boolean checkboxes and discoverable option colors', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Private compiled49318 with one worker is required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth traces/video forbidden.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  for (const theme of ['light', 'dark'] as const) test(`native checkbox autosave, bulk Undo and stored option colors · ${theme}`, async ({ page }, info) => {
    test.setTimeout(100_000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const f = await freshProject(page, provider, `Field checkbox ${theme}`);
    const a = await createFixtureTask(f, 'Checkbox task A'), b = await createFixtureTask(f, 'Checkbox task B');
    const flag = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'Approved', type: 'boolean', historyEnabled: true, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data;
    const category = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: 'ReportType', type: 'single_select', historyEnabled: true, locked: false, options: [{ name: 'Bugfix', color: null }, { name: 'Development', color: '#3b82f6' }] }, taskFieldDefinitionResponseSchema)).data;
    const option = requireValue(category.options.find(option => option.name === 'Bugfix'));
    await openTable(f);
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const flagA = cell(page, a.id, flag.id).getByRole('checkbox', { name: `Edit Approved for ${a.title}`, exact: true });
    await flagA.scrollIntoViewIfNeeded();
    await expect(flagA).toHaveJSProperty('indeterminate', true);
    expect(await values(f, a.id, flag.id)).toBeNull(); // No value row: viewing/focusing never creates false.
    await flagA.click();
    await expect.poll(() => values(f, a.id, flag.id)).toEqual({ type: 'boolean', value: true });
    await expect(flagA).toBeChecked(); await expect(flagA).toBeEnabled(); await expect(flagA).toBeFocused();
    await flagA.press('ControlOrMeta+z');
    await expect.poll(() => values(f, a.id, flag.id)).toEqual({ type: 'boolean', value: null });
    await expect(flagA).toHaveJSProperty('indeterminate', true);
    await flagA.click();
    await expect.poll(() => values(f, a.id, flag.id)).toEqual({ type: 'boolean', value: true });
    await expect(flagA).toBeChecked(); await expect(flagA).toBeEnabled();
    await flagA.press('Space');
    await expect.poll(() => values(f, a.id, flag.id)).toEqual({ type: 'boolean', value: false });
    await expect(flagA).not.toBeChecked(); await expect(flagA).toHaveJSProperty('indeterminate', false);
    await cell(page, a.id, flag.id).getByRole('button', { name: 'Clear: Approved', exact: true }).click();
    await expect.poll(() => values(f, a.id, flag.id)).toEqual({ type: 'boolean', value: null });
    await expect(flagA).toHaveJSProperty('indeterminate', true);
    await expect(page.locator('[data-task-panel]')).toHaveCount(0);

    await savedRow(page, a.id).locator(`[data-task-open-area="${a.id}"]`).click();
    const pane = page.getByRole('dialog', { name: a.title, exact: true });
    const paneFlag = pane.locator(`[data-inline-field-cell="${a.id}:${flag.id}"]`).getByRole('checkbox');
    await expect(paneFlag).toHaveJSProperty('indeterminate', true); await paneFlag.click();
    await expect.poll(() => values(f, a.id, flag.id)).toEqual({ type: 'boolean', value: true });
    await expect(flagA).toBeChecked(); await expect(paneFlag).toBeEnabled();
    await pane.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(pane).toHaveCount(0);

    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).click();
    await savedRow(page, b.id).locator(`[data-task-select="${b.id}"]`).click({ modifiers: ['Shift'] });
    await flagA.click();
    await expect.poll(async () => Promise.all([a, b].map(task => values(f, task.id, flag.id)))).toEqual([{ type: 'boolean', value: false }, { type: 'boolean', value: false }]);
    await expect(page.getByRole('dialog', { name: /selected/i })).toHaveCount(0);
    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).focus(); await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => Promise.all([a, b].map(task => values(f, task.id, flag.id)))).toEqual([{ type: 'boolean', value: true }, { type: 'boolean', value: null }]);
    await page.keyboard.press('Escape');
    await expect(savedRow(page, a.id)).toHaveAttribute('aria-selected', 'false');

    let dialog = await editOptions(f);
    await dialog.getByRole('button', { name: 'Change color for “Bugfix”', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Purple', exact: true }).click();
    await expect.poll(async () => requireValue((await definitions(f)).find(field => field.id === category.id)).options.find(item => item.id === option.id)?.color).toBe('#8b5cf6');
    await expect(dialog.getByRole('radio', { name: 'Purple', exact: true })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Rename option “Bugfix”', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Option name', exact: true }).fill('Bug fixes');
    await dialog.getByRole('button', { name: 'Save option', exact: true }).click();
    await expect.poll(async () => requireValue((await definitions(f)).find(field => field.id === category.id)).options.find(item => item.id === option.id)).toMatchObject({ id: option.id, name: 'Bug fixes', color: '#8b5cf6' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await page.reload();
    await expect(flagA).toBeChecked();
    dialog = await editOptions(f);
    await dialog.getByRole('button', { name: 'Change color for “Bug fixes”', exact: true }).click();
    await expect(dialog.getByRole('radio', { name: 'Purple', exact: true })).toBeChecked();
    expect(requireValue((await definitions(f)).find(field => field.id === category.id)).options.map(item => item.id)).toEqual(category.options.map(item => item.id));
    await page.screenshot({ path: info.outputPath(`field-checkbox-options-${theme}.png`) });
    expect(errors).toEqual([]);
  });
});
