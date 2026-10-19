// Root-owned disposable compiled QA. Never run on4310/4311 or main PostgreSQL.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { taskFieldDefinitionResponseSchema, taskFieldDefinitionListResponseSchema, taskFieldValueListResponseSchema, sectionResponseSchema, taskResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, openTable, savedRow, type DailyProject } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
const cell = (page: Page, taskId: string, fieldId: string) => savedRow(page, taskId).locator(`[data-inline-field-cell="${taskId}:${fieldId}"]`);
const taskPane = (page: Page, title: string) => page.getByRole('dialog', { name: title, exact: true });
const frame = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const responseAt = (method: string, path: string) => (response: { url(): string; request(): { method(): string } }) => response.request().method() === method && new URL(response.url()).pathname === path;
async function ordinaryField(f: DailyProject, name: string, type = 'duration', options: { name: string; color: string | null }[] = []) {
  return (await apiWrite(f.page, `${f.prefix}/fields`, { projectId: f.projectId, name, type, historyEnabled: true, locked: false, options }, taskFieldDefinitionResponseSchema)).data;
}
async function box(locator: Locator) { const value = await locator.boundingBox(); if (!value) throw Error('Native target has no box.'); return value; }
async function inkLeft(locator: Locator) {
  return locator.evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().left; });
}
async function theme(page: Page, value: 'light' | 'dark') {
  if (await page.locator('html').getAttribute('data-theme') !== value) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', value);
}

test.describe('ordinary inline values, compact pane and table chrome', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw Error('Private compiled49318 with one worker is required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw Error('Auth traces/video forbidden.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  test('single and selected ordinary values edit in place, autosave and clear selection on Escape', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Ordinary inline parity');
    const a = await createFixtureTask(f, 'Delivery task A'); const b = await createFixtureTask(f, 'Delivery task B');
    const hours = await ordinaryField(f, 'Hours Estimation');
    const category = await ordinaryField(f, 'Work category', 'single_select', [{ name: 'Bugfix', color: '#ef4444' }, { name: 'Feature', color: '#3b82f6' }]);
    await openTable(f);
    const control = cell(page, a.id, hours.id).getByRole('button', { name: `Edit Hours Estimation for ${a.title}`, exact: true });
    await control.scrollIntoViewIfNeeded(); const before = await box(savedRow(page, a.id));
    await control.click(); const input = cell(page, a.id, hours.id).getByRole('textbox'); await expect(input).toBeFocused();
    const editingBox = await box(savedRow(page, a.id));
    expect(Math.abs(editingBox.width - before.width)).toBeLessThanOrEqual(1); expect(Math.abs(editingBox.height - before.height)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-task-panel]')).toHaveCount(0); await input.fill('2.5');
    const singleSaved = page.waitForResponse(responseAt('PUT', `${f.prefix}/tasks/${a.id}/field-values/${hours.id}`)); await input.press('Enter'); expect((await singleSaved).status()).toBe(200);
    await expect(cell(page, a.id, hours.id)).toContainText('2h 30m');
    const after = await box(savedRow(page, a.id)); expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1); expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
    const selectA = savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`); await selectA.click();
    await savedRow(page, b.id).locator(`[data-task-select="${b.id}"]`).click({ modifiers: ['Shift'] });
    await expect(savedRow(page, a.id)).toHaveAttribute('aria-selected', 'true'); await expect(savedRow(page, b.id)).toHaveAttribute('aria-selected', 'true');
    await cell(page, a.id, hours.id).getByRole('button', { name: `Edit Hours Estimation for ${a.title}`, exact: true }).click();
    const multi = cell(page, a.id, hours.id).getByRole('textbox'); await multi.fill('3'); await multi.press('Enter');
    await expect.poll(async () => {
      const values = await Promise.all([a, b].map(task => apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)));
      return values.map(result => result.data.find(value => value.fieldId === hours.id)?.value);
    }).toEqual([{ type: 'duration', value: 180 }, { type: 'duration', value: 180 }]);
    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).focus(); await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => {
      const values = await Promise.all([a, b].map(task => apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)));
      return values.map(result => result.data.find(value => value.fieldId === hours.id)?.value);
    }).toEqual([{ type: 'duration', value: 150 }, { type: 'duration', value: null }]);
    const headerWidths = await page.locator('[data-task-table-scroll] thead th').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    const beforeChoice = await box(savedRow(page, a.id));
    await cell(page, a.id, category.id).getByRole('combobox', { name: `Edit Work category for ${a.title}`, exact: true }).click();
    await expect(page.getByRole('dialog', { name: /selected/i })).toHaveCount(0); await expect(page.getByRole('option', { name: 'Bugfix', exact: true })).toBeVisible();
    const openChoiceWidths = await page.locator('[data-task-table-scroll] thead th').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    expect(openChoiceWidths).toHaveLength(headerWidths.length);
    for (let index = 0; index < headerWidths.length; index++) expect(Math.abs((openChoiceWidths[index] ?? Infinity) - (headerWidths[index] ?? -Infinity))).toBeLessThanOrEqual(1);
    const duringChoice = await box(savedRow(page, a.id)); expect(Math.abs(duringChoice.width - beforeChoice.width)).toBeLessThanOrEqual(1); expect(Math.abs(duringChoice.height - beforeChoice.height)).toBeLessThanOrEqual(1);
    await page.getByRole('option', { name: 'Bugfix', exact: true }).click();
    await expect.poll(async () => {
      const values = await Promise.all([a, b].map(task => apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)));
      return values.map(result => result.data.find(value => value.fieldId === category.id)?.value.value);
    }).toEqual([category.options[0]?.id, category.options[0]?.id]);
    const committedWidths = await page.locator('[data-task-table-scroll] thead th').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    expect(committedWidths).toHaveLength(headerWidths.length);
    for (let index = 0; index < headerWidths.length; index++) expect(Math.abs((committedWidths[index] ?? Infinity) - (headerWidths[index] ?? -Infinity))).toBeLessThanOrEqual(1);
    const afterChoice = await box(savedRow(page, a.id)); expect(Math.abs(afterChoice.width - beforeChoice.width)).toBeLessThanOrEqual(1); expect(Math.abs(afterChoice.height - beforeChoice.height)).toBeLessThanOrEqual(1);
    await savedRow(page, a.id).locator(`[data-task-select="${a.id}"]`).focus(); await page.keyboard.press('Escape');
    await expect(savedRow(page, a.id)).toHaveAttribute('aria-selected', 'false'); await expect(savedRow(page, b.id)).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('[data-task-panel]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('ordinary-inline-parity.png') });
  });

  for (const selectedTheme of ['light', 'dark'] as const) test(`${selectedTheme}: labels stay horizontally fixed; add rows align and header plus creates/persists an ordinary field`, async ({ page }, info) => {
    const f = await freshProject(page, provider, `Table chrome ${selectedTheme}`);
    const section = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Engineering delivery' }, sectionResponseSchema)).data;
    const a = await createFixtureTask(f, 'Aligned task title', { sectionId: section.id });
    for (let index = 0; index < 4; index++) await ordinaryField(f, `Wide field ${index}`, 'text');
    await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table`);
    await expect(savedRow(page, a.id)).toBeVisible(); await theme(page, selectedTheme);
    const scroller = page.locator('[data-task-table-scroll]');
    const title = savedRow(page, a.id).getByRole('button', { name: a.title, exact: true });
    const add = page.getByRole('button', { name: `Add task to “${section.name}”`, exact: true }).locator('span');
    const heading = page.getByRole('button', { name: `Collapse section “${section.name}”`, exact: true }).locator('span[title]');
    expect(Math.abs(await inkLeft(title) - await inkLeft(add))).toBeLessThanOrEqual(1.5);
    const bottom = page.locator('[data-add-section-row] > span'); const sectionX = await inkLeft(heading), addSectionX = await inkLeft(bottom);
    expect(Math.abs(sectionX - addSectionX)).toBeLessThanOrEqual(1.5);
    await scroller.hover(); await page.mouse.wheel(3000, 0); await expect.poll(() => scroller.evaluate(node => node.scrollLeft)).toBeGreaterThan(300); await frame(page);
    expect(Math.abs(await inkLeft(heading) - sectionX)).toBeLessThanOrEqual(1); expect(Math.abs(await inkLeft(bottom) - addSectionX)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Add or show columns', exact: true }).click();
    const menu = page.getByRole('menu'); const priority = menu.getByRole('menuitemcheckbox', { name: 'Priority', exact: true });
    expect(await priority.getAttribute('aria-checked')).toBe('false'); await priority.click();
    await expect(page.getByRole('columnheader', { name: 'Priority', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Add or show columns', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create field', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create field', exact: true }); await create.getByLabel('Field name', { exact: true }).fill('Fact');
    await create.getByRole('button', { name: 'Field type', exact: true }).click(); await page.getByRole('menuitem', { name: 'Duration', exact: true }).click();
    const created = page.waitForResponse(responseAt('POST', `${f.prefix}/fields`)); await create.getByRole('button', { name: 'Create field', exact: true }).click();
    expect((await created).status()).toBe(201); await expect(create).toHaveCount(0); await expect(page.getByRole('columnheader', { name: 'Fact', exact: true })).toBeVisible();
    const definitions = (await apiRead(page, `${f.prefix}/fields?projectId=${f.projectId}`, taskFieldDefinitionListResponseSchema)).data;
    expect(definitions.find(field => field.name === 'Fact')).toMatchObject({ type: 'duration', historyEnabled: true, archivedAt: null });
    await page.locator('[data-add-section-row]').click(); const sectionInput = page.getByRole('form', { name: 'Add section', exact: true }).getByRole('textbox', { name: 'Section name', exact: true }); await expect(sectionInput).toBeFocused(); await sectionInput.fill('Review queue'); await sectionInput.press('Enter');
    await expect(page.getByRole('button', { name: 'Collapse section “Review queue”', exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByRole('columnheader', { name: 'Fact', exact: true })).toBeAttached(); await expect(page.getByRole('columnheader', { name: 'Priority', exact: true })).toBeAttached();
    await page.screenshot({ path: info.outputPath(`table-chrome-${selectedTheme}.png`) });
  });

  test('compact pane exposes the same fields before description and leaves the table/header interactive', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Compact ordinary pane', true);
    const a = await createFixtureTask(f, 'Inspect compact pane', { description: 'A visible description belongs immediately after ordinary task parameters.' });
    const b = await createFixtureTask(f, 'Other editable row'); const hours = await ordinaryField(f, 'Hours Estimation');
    await openTable(f); await savedRow(page, a.id).locator(`[data-task-open-area="${a.id}"]`).click();
    const pane = taskPane(page, a.title); await expect(pane).toBeVisible();
    await expect(pane.getByLabel('Task name', { exact: true })).toHaveValue(a.title);
    await expect(pane.getByRole('button', { name: 'Edit dates', exact: true })).toBeVisible();
    await expect(pane.getByRole('combobox', { name: 'Add participant', exact: true })).toBeVisible();
    await expect(pane.getByText('Team estimate', { exact: true })).toHaveCount(0); await expect(pane.getByText('More fields', { exact: true })).toHaveCount(0);
    const value = pane.locator(`[data-inline-field-cell="${a.id}:${hours.id}"]`); await expect(value).toHaveAttribute('data-presentation', 'pane');
    await value.getByRole('button', { name: `Edit Hours Estimation for ${a.title}`, exact: true }).click();
    const input = value.getByRole('textbox'); await input.fill('1:30'); await input.press('Enter');
    await expect(value).toContainText('1h 30m');
    const description = pane.getByRole('textbox', { name: 'Description', exact: true }); await expect(description).toBeVisible();
    expect((await box(value)).y).toBeLessThan((await box(description)).y);
    await pane.getByRole('button', { name: 'Edit dates', exact: true }).click();
    const calendar = page.getByRole('dialog', { name: 'Edit dates', exact: true });
    await calendar.getByRole('textbox', { name: 'Due date', exact: true }).fill('2035-04-10');
    await calendar.getByRole('button', { name: /Start date/, exact: false }).click();
    await calendar.getByRole('textbox', { name: 'Start date', exact: true }).fill('2035-04-08');
    await calendar.getByRole('textbox', { name: 'Start date', exact: true }).press('Enter');
    await expect(calendar).toHaveCount(0);
    await expect.poll(async () => { const task=(await apiRead(page, `${f.prefix}/tasks/${a.id}`, taskResponseSchema)).data;return [task.startDate, task.dueDate]; }).toEqual(['2035-04-08','2035-04-10']);
    await pane.getByRole('button', { name: 'Edit dates', exact: true }).click();
    const cancelledCalendar=page.getByRole('dialog',{name:'Edit dates',exact:true});
    await cancelledCalendar.getByRole('textbox',{name:'Due date',exact:true}).fill('2035-04-20');await cancelledCalendar.getByRole('textbox',{name:'Due date',exact:true}).press('Escape');
    await expect(cancelledCalendar).toHaveCount(0);await expect(pane).toBeVisible();expect((await apiRead(page,`${f.prefix}/tasks/${a.id}`,taskResponseSchema)).data.dueDate).toBe('2035-04-10');
    const teammate=f.teammates[0];if(!teammate)throw Error('Private teammate required.');
    await pane.getByRole('combobox',{name:'Add participant',exact:true}).click();
    await page.getByRole('combobox',{name:'Search: Add participant',exact:true}).fill(teammate.displayName);
    await page.getByRole('option',{name:teammate.displayName,exact:true}).click();
    await expect.poll(async()=> (await apiRead(page,`${f.prefix}/tasks/${a.id}`,taskResponseSchema)).data.participants.some(item=>item.active&&item.membershipId===teammate.id)).toBe(true);
    await pane.getByRole('button',{name:`Remove ${teammate.displayName}`,exact:true}).click();
    await expect.poll(async()=> (await apiRead(page,`${f.prefix}/tasks/${a.id}`,taskResponseSchema)).data.participants.some(item=>item.active&&item.membershipId===teammate.id)).toBe(false);
    // A pane must not block the other row or the project view controls.
    await savedRow(page, b.id).locator(`[data-task-select="${b.id}"]`).click(); await expect(savedRow(page, b.id)).toHaveAttribute('aria-selected', 'true');
    await expect(pane).toBeVisible();
    const banner = page.getByRole('banner'); const bannerBox = await box(banner); const paneBox = await box(pane);
    expect(paneBox.y).toBeGreaterThanOrEqual(bannerBox.y + bannerBox.height - 1);
    const headerControl = banner.getByRole('button', { name: 'Dark theme', exact: true });
    await expect(headerControl).toBeVisible(); await headerControl.click({ trial: true });
    await page.screenshot({ path: info.outputPath('compact-pane-inline.png') });
  });
  test('keyboard Undo restores ordinary values and status; deletion toast restores an archived task', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Undo ordinary mutations');
    const a = await createFixtureTask(f, 'Undo task'); const hours = await ordinaryField(f, 'Hours Estimation');
    await openTable(f);
    const fieldTrigger=cell(page,a.id,hours.id).getByRole('button',{name:`Edit Hours Estimation for ${a.title}`,exact:true});await fieldTrigger.click();
    const input=cell(page,a.id,hours.id).getByRole('textbox');await input.fill('1.5');
    const originalFieldWrite=page.waitForResponse(responseAt('PUT',`${f.prefix}/tasks/${a.id}/field-values/${hours.id}`));
    await input.press('Enter');expect((await originalFieldWrite).status()).toBe(200);await expect(fieldTrigger).toBeEnabled();await expect(cell(page,a.id,hours.id)).toContainText('1h 30m');
    await savedRow(page,a.id).locator(`[data-task-select="${a.id}"]`).focus();await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async()=> (await apiRead(page,`${f.prefix}/tasks/${a.id}/field-values`,taskFieldValueListResponseSchema)).data.find(value=>value.fieldId===hours.id)?.value).toEqual({type:'duration',value:null});
    const completedStatus=f.statuses.find(status=>status.id===f.doneId);if(!completedStatus)throw Error('Private completed-status fixture is missing.');
    const statusTrigger=savedRow(page,a.id).getByRole('button',{name:`Edit status for ${a.title}`,exact:true});await statusTrigger.click();
    const originalStatusWrite=page.waitForResponse(responseAt('PATCH',`${f.prefix}/tasks/${a.id}`));await page.getByRole('option',{name:completedStatus.name,exact:true}).click();expect((await originalStatusWrite).status()).toBe(200);await expect(statusTrigger).toBeEnabled();
    await expect.poll(async()=> (await apiRead(page,`${f.prefix}/tasks/${a.id}`,taskResponseSchema)).data.statusId).toBe(f.doneId);
    await savedRow(page,a.id).locator(`[data-task-select="${a.id}"]`).focus();await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async()=> (await apiRead(page,`${f.prefix}/tasks/${a.id}`,taskResponseSchema)).data.statusId).toBe(f.todoId);
    await savedRow(page,a.id).locator(`[data-task-open-area="${a.id}"]`).click();await taskPane(page,a.title).getByRole('button',{name:'Archive',exact:true}).click();
    await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeVisible();await page.getByRole('button',{name:'Undo',exact:true}).click();
    await expect.poll(async()=> (await apiRead(page,`${f.prefix}/tasks/${a.id}`,taskResponseSchema)).data.archivedAt).toBeNull();
    await expect(savedRow(page,a.id)).toBeAttached();await page.screenshot({path:info.outputPath('undo-restored.png')});
  });

});
