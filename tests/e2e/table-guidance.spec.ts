import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { projectSchema, taskListResponseSchema, taskSchema, type TaskDto } from '@workloom/contracts';
import { z } from 'zod';
import { evidenceJson } from './support/evidence.js';

const manifestPath = '.local/qa/task-title-cycle20261016-title-v1.json';
const projectId = 'b3a88290-1c7a-40f2-967b-017953c243ca';
const storedFixture = z.object({
  stage: z.literal('complete'), version: z.literal(1), origin: z.string().url(),
  workspaceId: z.literal('5eed0000-0000-4000-8000-000000000201'),
  project: projectSchema, chain: z.array(taskSchema).length(9),
  short: taskSchema, realistic: taskSchema, unbroken: taskSchema,
});
const assigneeHelp = 'Each task appears under its assignee; meetings use their organizer. Weekly hours still belong to the selected person.';
const dueHelp = 'Groups keep their order. Tasks sort by their own due date within each group or sibling list; subtasks stay under their parent. Undated tasks come last.';
const sizes = [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]] as const;
const canonical = (tasks: TaskDto[]) => [...tasks].sort((a, b) => a.id.localeCompare(b.id));

async function context(page: Page) {
  return {
    url: page.url(), group: await page.getByRole('combobox', { name: 'Group by', exact: true }).inputValue(),
    sort: await page.getByRole('combobox', { name: 'Sort', exact: true }).inputValue(),
    week: await page.getByRole('combobox', { name: 'Week for hours', exact: true }).inputValue(),
    person: await page.getByRole('combobox', { name: 'Whose hours to show', exact: true }).inputValue(),
    search: await page.getByLabel('Search tasks', { exact: true }).inputValue(),
    filters: await page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ }).innerText(),
  };
}

for (const [name, viewport] of sizes) test.describe(`Table guidance ${name}`, () => {
  test.use({ viewport });
  test('native disclosure preserves context and an independent unsent draft; loaded budget remains visible without writes', async ({ page, request, baseURL }, info) => {
    // This gate refuses a missing/stale manifest; it has no fixture creation or fallback seeding seam.
    const fixture = storedFixture.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    expect(fixture.project.id).toBe(projectId);
    expect(fixture.origin).toBe(new URL(baseURL ?? '').origin);
    const prefix = `/api/v1/workspaces/${fixture.workspaceId}`;
    const query = new URLSearchParams({ projectId, limit: '100' });
    const readHeads = async () => {
      const response = await request.get(`${prefix}/tasks?${query}`);
      expect(response.status(), await response.text()).toBe(200);
      const result = taskListResponseSchema.parse(await response.json());
      expect(result.meta.nextCursor).toBeNull();
      return canonical(result.data);
    };
    const before = await readHeads();
    const expected = canonical([...fixture.chain, fixture.short, fixture.realistic, fixture.unbroken]);
    expect(before).toEqual(expected);
    const packages = new Map<string, { revision: number; minutes: number | null }>();
    for (const task of before) {
      const projection = { revision: task.workPackageRevision, minutes: task.estimateMinutes };
      if (packages.has(task.workPackageId)) expect(packages.get(task.workPackageId)).toEqual(projection);
      packages.set(task.workPackageId, projection);
    }
    const knownMinutes = [...packages.values()].reduce((sum, item) => sum + (item.minutes ?? 0), 0);
    const unknownTasks = before.filter(task => task.estimateMinutes === null).length;
    expect(before).toHaveLength(12); expect(packages.size).toBe(4);
    expect(knownMinutes).toBe(240); expect(unknownTasks).toBe(0);
    expect([...packages.values()].filter(item => item.minutes === 0)).toHaveLength(2);
    const writes: { method: string; path: string }[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const q = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return route.continue();
      writes.push({ method: q.method(), path: new URL(q.url()).pathname });
      await route.abort('blockedbyclient');
    });
    const person = fixture.short.responsibleMembershipId;
    expect(person).toBeTruthy();
    const url = `/w/${fixture.workspaceId}/projects/${projectId}?week=&worker=${person}&qa=guidance#guidance-context`;
    await page.goto(url);
    const table = page.getByRole('table', { name: `Tasks in “${fixture.project.name}”`, exact: true });
    const footer = table.getByRole('row').filter({ hasText: 'Loaded team budget' });
    const summary = page.locator('summary').filter({ hasText: /^About this table$/ });
    const details = summary.locator('..');
    const assertFooter = async () => {
      await expect(footer).toHaveCount(1);
      for (const text of ['4h', 'Loaded team budget', '· Loaded: 12 tasks', '· Not estimated: 0 tasks', '· Shared estimates counted once.']) await expect(footer.getByText(text, { exact: true })).toBeVisible();
      await expect(footer).not.toContainText('More tasks available');
      await expect(footer).not.toContainText('Shared estimates disagree');
    };
    await assertFooter(); await expect(summary).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Sort', exact: true }).selectOption('due_asc');
    await expect(summary).toBeVisible(); await expect(details).not.toHaveAttribute('open');
    await summary.focus(); await expect(summary).toBeFocused(); await summary.press('Enter');
    await expect(details).toHaveAttribute('open', ''); await expect(summary).toBeFocused();
    await expect(details.getByText(dueHelp, { exact: true })).toBeVisible();
    await expect(details.getByText(assigneeHelp, { exact: true })).toHaveCount(0);
    await summary.press('Space'); await expect(details).not.toHaveAttribute('open'); await expect(summary).toBeFocused();
    await page.getByRole('combobox', { name: 'Group by', exact: true }).selectOption('assignee');
    await assertFooter();
    const rawDescription = 'Unsubmitted local description survives About this table keyboard toggles.';
    const title = table.getByRole('button', { name: fixture.short.title, exact: true });
    await title.click();
    const drawer = page.getByRole('dialog', { name: fixture.short.title, exact: true });
    await drawer.getByLabel('Description', { exact: true }).fill(rawDescription);
    await drawer.getByRole('button', { name: 'Close', exact: true }).first().click();
    await expect(drawer).toHaveCount(0);
    const preserved = await context(page);
    expect(preserved).toMatchObject({ group: 'assignee', sort: 'due_asc', week: '', person, search: '', filters: 'Filters' });
    expect(new URL(preserved.url).hash).toBe('#guidance-context');
    const frame = async (state: string) => {
      await page.evaluate(() => window.scrollTo(0, 0));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath(`table-guidance-${state}-${name}.png`), fullPage: true });
      return { state, overflow, context: await context(page) };
    };
    await expect(details).not.toHaveAttribute('open'); const closed = await frame('closed');
    await summary.focus(); await summary.press('Enter');
    await expect(details).toHaveAttribute('open', ''); await expect(summary).toBeFocused();
    await expect(details.getByText(assigneeHelp, { exact: true })).toBeVisible();
    await expect(details.getByText(dueHelp, { exact: true })).toBeVisible();
    await assertFooter(); expect(await context(page)).toEqual(preserved);
    const open = await frame('open');
    await evidenceJson(info, 'table-guidance-keyboard-stage.json', { manifestPath, projectId, before, packages: [...packages], knownMinutes, unknownTasks, preserved, closed, open, writes, errors });
    await summary.press('Space'); await expect(details).not.toHaveAttribute('open'); await expect(summary).toBeFocused();
    await assertFooter(); expect(await context(page)).toEqual(preserved);
    await title.click(); await expect(drawer.getByLabel('Description', { exact: true })).toHaveValue(rawDescription);
    await drawer.getByRole('button', { name: 'Discard draft', exact: true }).click();
    await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
    expect(await context(page)).toEqual(preserved);
    const after = await readHeads(); expect(after).toEqual(before); expect(writes).toEqual([]); expect(errors).toEqual([]);
    await evidenceJson(info, 'table-guidance-proof.json', { manifestPath, projectId, before, after, knownMinutes, unknownTasks, packageCount: packages.size, writes, errors, nativeKeys: ['Enter', 'Space'], preserved, closed, open, rawDescription, partialUnknownConflictBrowserCoverage: false, actorSwitchCovered: false });
  });
});
