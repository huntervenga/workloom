// Private compiled Chrome gate: non-modal task drawer beside the table, CSS slide, Escape layering and unsaved title drafts.
// Actual shared-Auth cookie/API on private QA 49318 with the fake provider on 49319; fixture writes use helpers, product flows use the UI.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { TaskDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import {
  PRIVATE_APP as APP, allTasks, center, createFixtureTask, freshProject, observeCommands, openTable, requireValue, savedRow,
} from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
type Theme = 'light' | 'dark';
interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }
interface Layout {
  vw: number; innerWidth: number; overflow: number; scrollY: number; tableTop: number; scroll: Box; main: Box | null; panel: Box | null;
  rows: Record<string, Box>; titleWidths: number[]; excluded: boolean;
}
interface PanelAnimation { type: string; name: string; elapsed: number; state: string | null; css: string[] }
interface ExitSnapshot { state: string | null; hidden: string | null; inert: boolean; heading: string | null | undefined; draft: string | undefined }
declare global { interface Window { drawerAnimations?: PanelAnimation[]; drawerExit?: ExitSnapshot | null } }

const SIDEBAR = 240;
const panel = (page: Page) => page.locator('[data-task-panel]');
const drawer = (page: Page, title: string) => page.getByRole('dialog', { name: title, exact: true });
const openArea = (page: Page, id: string) => savedRow(page, id).locator('[data-task-open-area]');
const taskName = (scope: Locator) => scope.getByRole('textbox', { name: 'Task name', exact: true });
const themeButton = (page: Page) => page.getByRole('button', { name: 'Dark theme', exact: true });
const gutter = (page: Page, title: string) => page.getByRole('button', { name: `Select task: ${title}`, exact: true });
const dueDate = (scope: Locator) => scope.getByLabel('Due date', { exact: true });
const calendar = (page: Page) => page.getByRole('region', { name: 'Choose a date', exact: true });
const byId = (rows: readonly TaskDto[], id: string) => requireValue(rows.find(row => row.id === id));
const near = (actual: number, expected: number, tolerance: number, label: string) =>
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);

async function picture(page: Page, info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`) }); }
async function mouseClick(page: Page, target: Locator) { const at = await center(target); await page.mouse.click(at.x, at.y); }
async function typeDraft(page: Page, input: Locator, text: string) {
  await mouseClick(page, input); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(text); await expect(input).toHaveValue(text);
}
async function setTheme(page: Page, theme: Theme) {
  const button = themeButton(page), pressed = theme === 'dark' ? 'true' : 'false'; await expect(button).toBeVisible();
  if (await button.getAttribute('aria-pressed') !== pressed) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', pressed); await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function layout(page: Page, ids: readonly string[]): Promise<Layout> {
  return page.evaluate(ids => {
    const box = (node: Element): Box => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const scroll = document.querySelector<HTMLElement>('[data-task-table-scroll]');
    if (!scroll) throw new Error('Table scrollport is missing.');
    const root = document.documentElement, main = document.querySelector('main, [role="main"]'), pane = document.querySelector('[data-task-panel]');
    const rows: Record<string, Box> = {}, titleWidths: number[] = [];
    for (const id of ids) {
      const row = scroll.querySelector(`tr[data-task-row="${CSS.escape(id)}"]`), title = row?.querySelector(`button[data-task-cell="${CSS.escape(id)}:title"]`)?.closest('td');
      if (!row || !title) throw new Error(`Saved row ${id} or its title cell is missing.`);
      rows[id] = box(row); titleWidths.push(title.getBoundingClientRect().width);
    }
    return { vw: root.clientWidth, innerWidth: window.innerWidth, overflow: root.scrollWidth - root.clientWidth, scrollY: window.scrollY,
      tableTop: scroll.scrollTop, scroll: box(scroll), main: main ? box(main) : null, panel: pane ? box(pane) : null, rows, titleWidths,
      excluded: scroll.closest('[inert], [aria-hidden="true"]') !== null };
  }, ids);
}
function expectRows(l: Layout) { for (const [id, row] of Object.entries(l.rows)) near(row.height, 41, 1, `row ${id} height`); }
function expectFullTable(l: Layout) {
  expect(l.panel).toBeNull(); expect(l.overflow).toBeLessThanOrEqual(1); expect(l.excluded).toBe(false);
  expect(l.vw - l.scroll.right, 'right gutter').toBeLessThanOrEqual(32); expect(l.vw - l.scroll.right).toBeGreaterThanOrEqual(0);
  expect(l.scroll.left).toBeGreaterThanOrEqual(SIDEBAR - 1); expect(l.scroll.left - SIDEBAR, 'left gutter').toBeLessThanOrEqual(32);
  expect(l.scroll.width, 'available width').toBeGreaterThanOrEqual(l.vw - SIDEBAR - 64);
  near(requireValue(l.main ?? undefined).right, l.vw, 1, 'main right edge'); expectRows(l);
}
function expectBeside(before: Layout, after: Layout, minWidth: number) {
  const pane = requireValue(after.panel ?? undefined), clamp = Math.min(544, Math.max(384, after.innerWidth * 0.34));
  near(pane.right, after.vw, 1, 'pane right edge'); near(pane.width, clamp, 2, 'pane clamp width'); expect(pane.top).toBeGreaterThanOrEqual(0);
  expect(after.scroll.right, 'table ends before pane').toBeLessThanOrEqual(pane.left + 1);
  expect(after.scroll.width, 'table stays usable').toBeGreaterThanOrEqual(minWidth); near(after.scroll.left, before.scroll.left, 1, 'table left edge');
  expect(after.excluded).toBe(false); expect(after.overflow).toBeLessThanOrEqual(1); expectRows(after);
  for (const width of after.titleWidths) near(width, 300, 2, 'title column');
  near(after.scrollY, before.scrollY, 2, 'window Y'); near(after.tableTop, before.tableTop, 2, 'table scrollTop');
  for (const [id, row] of Object.entries(before.rows)) near(requireValue(after.rows[id]).top, row.top, 2, `row ${id} top`);
}
async function expectHitInsideRow(page: Page, id: string) {
  const at = await center(savedRow(page, id).locator(`button[data-task-cell="${id}:title"]`));
  expect(await savedRow(page, id).evaluate((row, p) => { const hit = document.elementFromPoint(p.x, p.y); return hit !== null && row.contains(hit); }, at), 'no overlay over table').toBe(true);
}

/** Read-only capture of CSS animation events on the panel element itself; installed before the opening action. */
async function watchPanelAnimations(page: Page) {
  await page.evaluate(() => {
    const log: PanelAnimation[] = []; window.drawerAnimations = log;
    const record = (event: AnimationEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.matches('[data-task-panel]')) return;
      log.push({ type: event.type, name: event.animationName, elapsed: event.elapsedTime, state: target.getAttribute('data-state'),
        css: target.getAnimations().flatMap(animation => animation instanceof CSSAnimation ? [animation.animationName] : []) });
    };
    document.addEventListener('animationstart', record, true); document.addEventListener('animationend', record, true);
  });
}
async function expectSlide(page: Page, state: 'open' | 'closed') {
  const read = () => page.evaluate(() => window.drawerAnimations ?? []);
  await expect.poll(async () => (await read()).some(e => e.type === 'animationend' && e.state === state), { message: `pane ${state} animation ends` }).toBe(true);
  const log = await read();
  const start = requireValue(log.find(e => e.type === 'animationstart' && e.state === state)), end = requireValue(log.find(e => e.type === 'animationend' && e.state === state));
  expect(start.name).not.toBe('none'); expect(start.css).toContain(start.name); expect(end.name).toBe(start.name);
  expect(end.elapsed).toBeGreaterThanOrEqual(0.159); expect(end.elapsed).toBeLessThanOrEqual(0.201);
}

/** The details, child table and comment composer use one vertical pane scroll owner. */
async function expectContinuousScroll(page: Page, pane: Locator) {
  const children = pane.getByRole('region', { name: 'Subtasks', exact: true });
  await expect(children).toBeAttached();
  await expect(children.getByRole('button', { name: 'Add subtask', exact: true })).toBeAttached();
  await expect(children.locator('tr[data-task-row]')).toHaveCount(12);
  const activity = pane.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity).toBeAttached();
  const comment = activity.getByRole('textbox', { name: 'Comment', exact: true });
  await expect(comment).toBeAttached();
  const structure = await pane.evaluate(node => {
    const nameOf = (element: Element) => element.getAttribute('aria-label') ?? (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ');
    const region = (name: string) => Array.from(node.querySelectorAll('section')).find(element => nameOf(element) === name);
    const description = Array.from(node.querySelectorAll('textarea')).find(input => Array.from(input.labels ?? []).some(label => label.textContent?.trim() === 'Description'));
    const subtasks = region('Subtasks'), stream = region('Activity'), composer = stream?.querySelector('textarea');
    if (!description || !subtasks || !stream || !composer) throw new Error('Continuous task content is missing.');
    const scrollOwner = (element: Element) => {
      // Text controls scroll their own text; horizontal-only table wrappers can
      // compute overflow-y:auto without owning any vertical content scroll.
      for (let parent = element.parentElement; parent !== null && parent !== node; parent = parent.parentElement) {
        if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) return parent;
      }
      return null;
    };
    const owner = scrollOwner(description);
    const verticalPorts = Array.from(node.querySelectorAll<HTMLElement>('*')).filter(element => !element.matches('textarea,input') && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1);
    return { oneScroller: owner !== null && verticalPorts.length === 1 && verticalPorts[0] === owner && [subtasks, stream, composer].every(element => scrollOwner(element) === owner),
      descriptionBeforeSubtasks: Boolean(description.compareDocumentPosition(subtasks) & Node.DOCUMENT_POSITION_FOLLOWING),
      subtasksBeforeActivity: Boolean(subtasks.compareDocumentPosition(stream) & Node.DOCUMENT_POSITION_FOLLOWING),
      independentCommentForm: composer.closest('form') !== null && composer.closest('form') !== description.closest('form') };
  });
  expect(structure).toEqual({ oneScroller: true, descriptionBeforeSubtasks: true, subtasksBeforeActivity: true, independentCommentForm: true });
  const windowY = await page.evaluate(() => scrollY);
  await comment.scrollIntoViewIfNeeded(); await expect(comment).toBeInViewport();
  near(await page.evaluate(() => scrollY), windowY, 2, 'only the pane scrolls to comments');
}

async function desktopDrawer(page: Page, info: TestInfo, width: 1440 | 1920, theme: Theme) {
  await page.setViewportSize({ width, height: width === 1920 ? 1080 : 1000 });
  const f = await freshProject(page, provider, `Drawer ${width} ${theme}`);
  const a = await createFixtureTask(f, `Drawer anchor ${width}`), b = await createFixtureTask(f, `Drawer neighbor ${width}`);
  const c = await createFixtureTask(f, `Drawer switch ${width}`), ids = [a.id, b.id, c.id];
  for (let child = 0; child < 12; child++) await createFixtureTask(f, `Drawer child ${width} ${child + 1}`, { parentTaskId: a.id, workScope: 'detail' });
  const baseline = await allTasks(f); expect(byId(baseline, b.id).responsibleMembershipId).toBeNull();
  await openTable(f); await setTheme(page, theme);
  for (const id of ids) await expect(savedRow(page, id)).toBeVisible();
  const before = await layout(page, ids); expectFullTable(before);

  const writes = observeCommands(page, f.prefix); await watchPanelAnimations(page);
  await mouseClick(page, openArea(page, a.id));
  const pane = drawer(page, a.title); await expect(pane).toBeVisible(); await expect(pane).not.toHaveAttribute('aria-modal', 'true');
  await expect(panel(page)).toHaveAttribute('data-state', 'open'); await expectSlide(page, 'open');
  expectBeside(before, await layout(page, ids), width === 1920 ? 900 : 500); await expectHitInsideRow(page, b.id);
  const dependencies = pane.getByRole('region', { name: 'Task dependencies', exact: true });
  await expect(dependencies.getByRole('button', { name: 'Add dependency', exact: true })).toBeVisible();
  await expect(dependencies.getByText('No unfinished predecessors', { exact: true })).toBeVisible();
  expect(requireValue((await dependencies.boundingBox()) ?? undefined).height, 'dependencies stay a compact ordinary field').toBeLessThanOrEqual(100);
  expect(await pane.evaluate(node => {
    const dependencies = node.querySelector('section[aria-label="Task dependencies"]');
    const estimate = Array.from(node.querySelectorAll('input')).find(input => Array.from(input.labels ?? []).some(label => label.textContent?.trim() === 'Team estimate, hours'));
    return dependencies !== null && estimate !== undefined && Boolean(dependencies.compareDocumentPosition(estimate) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await picture(page, info, `drawer-${width}-${theme}-open`); expect(writes.commands).toEqual([]);
  await expectContinuousScroll(page, pane);
  await picture(page, info, `drawer-${width}-${theme}-activity`);

  // Neighbor Assignee edit with the real mouse while the same drawer element stays mounted and open.
  const original = requireValue((await panel(page).elementHandle()) ?? undefined), neighbor = savedRow(page, b.id);
  const assigneeCell = neighbor.locator(`button[data-task-cell="${b.id}:responsibleMembershipId"]`);
  await expect(assigneeCell).toBeAttached();
  await mouseClick(page, assigneeCell);
  const assignee = neighbor.getByRole('combobox', { name: 'Assignee', exact: true }); await expect(assignee).toBeVisible();
  if (await assignee.getAttribute('aria-expanded') !== 'true') await mouseClick(page, assignee);
  await mouseClick(page, page.getByRole('listbox').getByRole('option', { name: f.owner.displayName, exact: true }));
  await expect.poll(async () => byId(await allTasks(f), b.id).responsibleMembershipId).toBe(f.owner.id);
  await expect(neighbor).toContainText(f.owner.displayName); await expect(drawer(page, a.title)).toBeVisible();
  expect(await original.evaluate(node => node.isConnected ? node.getAttribute('data-state') : 'detached')).toBe('open');
  expect(writes.commands).toHaveLength(1); expect(requireValue(writes.commands[0]).path).toContain(b.id);
  expect(byId(await allTasks(f), a.id)).toEqual(byId(baseline, a.id));

  const nameInput = taskName(pane);
  await expect(nameInput).toBeEnabled();
  await mouseClick(page, nameInput); await expect(nameInput).toBeFocused();
  // Router navigation commits after the key event. Capture the real closing DOM
  // before its short animation unmounts it, rather than reading an earlier frame.
  await panel(page).evaluate(node => {
    window.drawerExit = null;
    const observer = new MutationObserver(() => {
      if (node.getAttribute('data-state') !== 'closed') return;
      window.drawerExit = {
        state: node.getAttribute('data-state'), hidden: node.getAttribute('aria-hidden'), inert: node.hasAttribute('inert'),
        heading: node.querySelector('h2')?.textContent,
        draft: Array.from(node.querySelectorAll('input')).find(input => Array.from(input.labels ?? []).some(label => label.textContent?.trim() === 'Task name'))?.value,
      };
      observer.disconnect();
    });
    observer.observe(node, { attributes: true, attributeFilter: ['data-state', 'aria-hidden', 'inert'] });
  });
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.drawerExit), { timeout: 5000 }).toEqual({ state: 'closed', hidden: 'true', inert: true, heading: a.title, draft: a.title });
  await expectSlide(page, 'closed'); await expect(panel(page)).toHaveCount(0);

  // Dirty title draft survives switching to another task and back, with no command.
  await mouseClick(page, openArea(page, a.id)); await expect(drawer(page, a.title)).toBeVisible();
  const draft = `${a.title} unsaved draft`; await typeDraft(page, taskName(drawer(page, a.title)), draft);
  await mouseClick(page, openArea(page, c.id));
  const other = drawer(page, c.title); await expect(other).toBeVisible(); await expect(taskName(other)).toHaveValue(c.title); await expect(panel(page)).toHaveCount(1);
  await mouseClick(page, openArea(page, a.id));
  const back = drawer(page, a.title); await expect(back).toBeVisible(); await expect(taskName(back)).toHaveValue(draft);
  expect(writes.commands).toHaveLength(1);
  const final = await allTasks(f); expect(byId(final, a.id)).toEqual(byId(baseline, a.id)); expect(byId(final, c.id)).toEqual(byId(baseline, c.id));
  writes.close();
}

async function mobileDrawer(page: Page, info: TestInfo, theme: Theme) {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await freshProject(page, provider, `Drawer mobile ${theme}`);
  const a = await createFixtureTask(f, `Mobile drawer ${theme}`, { dueDate: '2035-03-03' }), b = await createFixtureTask(f, `Mobile neighbor ${theme}`);
  const baseline = await allTasks(f);
  await openTable(f); await setTheme(page, theme);
  const writes = observeCommands(page, f.prefix); await watchPanelAnimations(page);
  await mouseClick(page, openArea(page, a.id));
  const pane = drawer(page, a.title); await expect(pane).toBeVisible(); await expect(panel(page)).toHaveAttribute('data-state', 'open');
  await expectSlide(page, 'open');
  const opened = await layout(page, [a.id, b.id]), box = requireValue(opened.panel ?? undefined);
  near(box.left, 0, 1, 'pane left'); near(box.width, opened.vw, 1, 'pane full width'); expect(opened.overflow).toBeLessThanOrEqual(1);
  expect(opened.excluded || await pane.getAttribute('aria-modal') === 'true', 'table and sidebar excluded').toBe(true);
  expect(await panel(page).evaluate(node => { const hit = document.elementFromPoint(innerWidth / 2, innerHeight / 2); return hit !== null && node.contains(hit); })).toBe(true);
  await picture(page, info, `drawer-390-${theme}-open`);

  const draft = `${a.title} mobile draft`; await typeDraft(page, taskName(pane), draft);
  await mouseClick(page, dueDate(pane)); await expect(calendar(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(calendar(page)).toHaveCount(0);
  await expect(pane).toBeVisible(); await expect(panel(page)).toHaveAttribute('data-state', 'open');
  await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);

  await mouseClick(page, openArea(page, a.id));
  const again = drawer(page, a.title); await expect(again).toBeVisible(); await expect(taskName(again)).toHaveValue(draft);
  await picture(page, info, `drawer-390-${theme}-reopened`);
  expect(writes.commands).toEqual([]); expect(await allTasks(f)).toEqual(baseline); writes.close();
}

test.describe('private task drawer layout', () => {
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth native gate requires traces and video off.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  test('1440 light drawer sits beside the table, slides, keeps neighbor edits and restores a switched title draft', async ({ page }, info) => {
    await desktopDrawer(page, info, 1440, 'light');
  });
  test('1920 dark drawer sits beside the table, slides, keeps neighbor edits and restores a switched title draft', async ({ page }, info) => {
    await desktopDrawer(page, info, 1920, 'dark');
  });
  for (const theme of ['light', 'dark'] as const) {
    test(`390 ${theme} drawer is full-width modal, Escape closes the calendar first and reopen keeps the unsaved title`, async ({ page }, info) => {
      await mobileDrawer(page, info, theme);
    });
  }
  test('1440 reduced motion opens without animation, gutter Escape clears selection only, inside Escape closes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    const f = await freshProject(page, provider, 'Drawer reduced motion');
    const a = await createFixtureTask(f, 'Reduced drawer anchor'), b = await createFixtureTask(f, 'Reduced drawer neighbor'), ids = [a.id, b.id];
    const baseline = await allTasks(f);
    await openTable(f); await setTheme(page, 'light');
    const before = await layout(page, ids); expectFullTable(before);
    const writes = observeCommands(page, f.prefix);
    await mouseClick(page, openArea(page, a.id));
    const pane = drawer(page, a.title); await expect(pane).toBeVisible(); await expect(pane).not.toHaveAttribute('aria-modal', 'true');
    const motion = await panel(page).evaluate(node => { const style = getComputedStyle(node); return { name: style.animationName, durations: style.animationDuration.split(',').map(value => parseFloat(value)) }; });
    expect(motion.name === 'none' || motion.durations.every(value => value === 0), JSON.stringify(motion)).toBe(true);
    expectBeside(before, await layout(page, ids), 500);

    const select = gutter(page, b.title); await mouseClick(page, select);
    await expect(select).toHaveAttribute('aria-pressed', 'true'); await expect(select).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-task-select][aria-pressed="true"]')).toHaveCount(0);
    await expect(pane).toBeVisible(); await expect(panel(page)).toHaveAttribute('data-state', 'open');
    await mouseClick(page, taskName(pane)); await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
    expect(writes.commands).toEqual([]); expect(await allTasks(f)).toEqual(baseline); writes.close();
  });
});
