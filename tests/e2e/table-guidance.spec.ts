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
    // Native horizontal stage: real wheel input pans only the local table; geometry/hit reads never scroll or click.
    // The 1440 fixture table fits without local scroll, so only desktop narrows to 1200 (still lg, below the
    // 1160px expanded table plus app chrome); mobile stays 390. All checks use the measured stage viewport.
    const initialViewport = page.viewportSize();
    if (name === 'desktop') await page.setViewportSize({ width: 1200, height: viewport.height });
    const stageViewport = await page.evaluate(() => ({ innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight }));
    expect(stageViewport.innerWidth).toBe(name === 'desktop' ? 1200 : viewport.width);
    await assertFooter();
    const scroller = page.locator('[data-task-table-scroll]').filter({ has: table });
    const port = () => scroller.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left + el.clientLeft, right: rect.left + el.clientLeft + el.clientWidth, scrollLeft: el.scrollLeft, maxScroll: el.scrollWidth - el.clientWidth };
    });
    const rowCount = await table.getByRole('row').count();
    const footerTexts = ['4h', 'Loaded team budget', '· Loaded: 12 tasks', '· Not estimated: 0 tasks', '· Shared estimates counted once.'];
    const measure = () => Promise.all(footerTexts.map(text => footer.getByText(text, { exact: true }).evaluate((el, label) => {
      // The first line fragment is the hit point, so a wrapped mobile span is not tested in its line gap.
      const rects = Array.from(el.getClientRects(), r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
      const first = rects[0];
      const top = first ? document.elementFromPoint((first.left + first.right) / 2, (first.top + first.bottom) / 2) : null;
      return { text: label, rects, hit: !!top && (top === el || el.contains(top)) };
    }, text)));
    // Vertical placement happens at scrollLeft 0, before the pan, so no later read can re-pan the table.
    await footer.getByText('Loaded team budget', { exact: true }).scrollIntoViewIfNeeded();
    const start = await port();
    expect(start.scrollLeft).toBe(0);
    expect(start.maxScroll, 'the fixture table must overflow its local scroller').toBeGreaterThan(0);
    // Wheel over the sticky footer does not pan natively, so target a visible non-sticky body cell (read-only lookup).
    const wheelTarget = await scroller.evaluate(el => {
      const frame = el.getBoundingClientRect();
      const left = Math.max(frame.left + el.clientLeft, 0), right = Math.min(frame.left + el.clientLeft + el.clientWidth, document.documentElement.clientWidth);
      const top = Math.max(frame.top + el.clientTop, 0), bottom = Math.min(frame.top + el.clientTop + el.clientHeight, document.documentElement.clientHeight);
      const table = el.querySelector('table');
      for (const cell of el.querySelectorAll<HTMLTableCellElement>('tbody td')) {
        if (getComputedStyle(cell).position === 'sticky') continue;
        const rect = cell.getBoundingClientRect();
        const x = Math.min(Math.max((rect.left + rect.right) / 2, left + 1), right - 1);
        const y = Math.min(Math.max((rect.top + rect.bottom) / 2, top + 1), bottom - 1);
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const hit = document.elementFromPoint(x, y);
        const hitCell = hit?.closest('td, th');
        if (!hit || !table?.contains(hit) || hitCell !== cell || hit.closest('thead, tfoot')) continue;
        return { x, y, columnIndex: cell.cellIndex, cellText: cell.textContent?.slice(0, 80) ?? '', hitTag: hit.tagName };
      }
      return null;
    });
    expect(wheelTarget, 'a visible non-sticky body cell is the topmost element inside the table scroller').not.toBeNull();
    if (!wheelTarget) throw new Error('Missing wheel target');
    await page.mouse.move(wheelTarget.x, wheelTarget.y);
    await expect.poll(async () => { await page.mouse.wheel(600, 0); const now = await port(); return now.maxScroll - now.scrollLeft; }, { intervals: [150], timeout: 10_000 }).toBeLessThanOrEqual(0.5);
    const end = await port();
    expect(end.left).toBe(start.left); expect(end.right).toBe(start.right);
    const scrolledOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(scrolledOverflow).toBeLessThanOrEqual(0);
    await assertFooter();
    const pinned = await measure();
    for (const item of pinned) {
      expect(item.hit, `${item.text} is the topmost element at its own point`).toBe(true);
      for (const rect of item.rects) {
        expect(rect.left, item.text).toBeGreaterThanOrEqual(Math.max(end.left, 0) - 0.5);
        expect(rect.right, item.text).toBeLessThanOrEqual(Math.min(end.right, stageViewport.clientWidth) + 0.5);
        expect(rect.top, item.text).toBeGreaterThanOrEqual(-0.5); expect(rect.bottom, item.text).toBeLessThanOrEqual(stageViewport.clientHeight + 0.5);
      }
    }
    expect(await table.getByRole('row').count()).toBe(rowCount);
    await expect(details).not.toHaveAttribute('open'); expect(await context(page)).toEqual(preserved);
    await page.screenshot({ path: info.outputPath(`table-guidance-scrolled-${name}.png`) });
    await evidenceJson(info, 'table-guidance-horizontal-stage.json', { initialViewport, stageViewport, start, end, scrolledOverflow, rowCount, pinned, wheelTarget, nativeInput: 'mouse.wheel deltaX 600 over a non-sticky body cell', writes, errors });
    const after = await readHeads(); expect(after).toEqual(before); expect(writes).toEqual([]); expect(errors).toEqual([]);
    await evidenceJson(info, 'table-guidance-proof.json', { manifestPath, projectId, before, after, knownMinutes, unknownTasks, packageCount: packages.size, writes, errors, nativeKeys: ['Enter', 'Space'], nativeHorizontalScroll: { initialViewport, stageViewport, wheelTarget, start, end, pinned }, preserved, closed, open, rawDescription, partialUnknownConflictBrowserCoverage: false, actorSwitchCovered: false });
  });
});
