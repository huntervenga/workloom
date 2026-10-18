// Private compiled Chrome gate: title caret at the clicked glyph and opaque whole-row selection in both themes.
// Actual shared-Auth cookie/API/JWKS and root-owned throwaway PG; no app server/DB lifecycle here.
// Themes change only through the authenticated topbar control. Auth tokens are never captured; traces/video must remain off.
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { sectionResponseSchema, tagResponseSchema, taskResponseSchema, type TaskDto } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import {
  PRIVATE_APP as APP, allTasks, apiWrite, center, createFixtureTask, freshProject, manualOrder, observeCommands,
  openTable, requireValue, savedRow, showColumns,
} from './support/asana-private-project.js';

let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
type Theme = 'light' | 'dark';
type Rgba = [number, number, number, number];
/** 'Plan 🚀 launch café': the emoji is one surrogate pair (UTF-16 5..7) and é is precomposed (UTF-16 18). */
const LAUNCH = 'Plan \u{1F680} launch café';
const TRANSPARENT: Rgba = [0, 0, 0, 0];
const toggleKey = process.platform === 'darwin' ? 'Meta' : 'Control';
const gutter = (page: Page, title: string) => page.getByRole('button', { name: `Select task: ${title}`, exact: true });
const bulkRegion = (page: Page) => page.getByRole('region', { name: 'Edit selected tasks', exact: true });
const themeButton = (page: Page) => page.getByRole('button', { name: 'Dark theme', exact: true });
const titleButton = (page: Page, id: string) => savedRow(page, id).locator(`button[data-task-cell="${id}:title"]`);
const taskName = (page: Page, id: string) => savedRow(page, id).getByRole('textbox', { name: 'Task name', exact: true });
const frames = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
function unchangedData(task: TaskDto, assignment = false) {
  const { position: _position, revision: _revision, updatedAt: _updatedAt, ...rest } = task;
  if (!assignment) return rest;
  const { responsibleMembershipId: _responsible, ...other } = rest; return other;
}
async function picture(page: Page, info: TestInfo, name: string) { await page.screenshot({ path: info.outputPath(`${name}.png`) }); }
async function selected(page: Page): Promise<string[]> {
  return page.locator('[data-task-select][aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-task-select') ?? ''));
}
async function viewportState(page: Page, sentinelId: string) {
  return savedRow(page, sentinelId).evaluate(row => {
    const scroll = document.querySelector<HTMLElement>('[data-task-table-scroll]');
    if (!scroll) throw new Error('Table scrollport is missing.');
    return { y: window.scrollY, x: window.scrollX, tableTop: scroll.scrollTop, tableLeft: scroll.scrollLeft,
      sentinelTop: row.getBoundingClientRect().top, height: row.getBoundingClientRect().height };
  });
}
function stableViewport(before: Awaited<ReturnType<typeof viewportState>>, after: Awaited<ReturnType<typeof viewportState>>) {
  for (const key of ['y', 'x', 'tableTop', 'tableLeft', 'sentinelTop'] as const) expect(Math.abs(after[key] - before[key]), key).toBeLessThanOrEqual(2);
  expect(Math.abs(after.height - 41)).toBeLessThanOrEqual(1);
}

// WCAG 2.x relative luminance/contrast over browser-resolved sRGB bytes; nothing here knows the palette.
function over(top: Rgba, bottom: Rgba): Rgba {
  const alpha = top[3] / 255, mix = (upper: number, lower: number) => Math.round(upper * alpha + lower * (1 - alpha));
  return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2]), 255];
}
function flatten(layers: readonly Rgba[]): Rgba {
  const base = layers.at(-1);
  if (!base || base[3] !== 255) throw new Error('Text has no opaque background up to its own cell.');
  return layers.slice(0, -1).reduceRight<Rgba>((under, layer) => over(layer, under), base);
}
function luminance(color: Rgba) {
  const linear = (value: number) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}
function contrast(text: Rgba, background: Rgba) {
  const [light, dark] = [luminance(over(text, background)), luminance(background)].sort((x, y) => y - x);
  return (requireValue(light) + 0.05) / (requireValue(dark) + 0.05);
}

interface Inspection {
  theme: string | null; token: Rgba; body: { background: Rgba; color: Rgba };
  scroll: { x: number; y: number; tableLeft: number; tableTop: number };
  widths: number[]; headerGutter: { left: string; right: string; background: Rgba; cell: Rgba } | null;
  rows: { id: string; selected: string | null; pressed: string | null; height: number; cells: Rgba[];
    gutter: { left: string; right: string; background: Rgba };
    texts: { cell: number; text: string; color: Rgba; layers: Rgba[] }[] }[];
}
/**
 * Computed paint after CSS transitions settle. Every color, including the raw --color-selection token,
 * goes through one detached canvas so authored hex/rgb/oklch tokens compare byte-for-byte with used colors.
 */
async function inspect(page: Page, ids: readonly string[] = [], textCells: readonly number[] = []): Promise<Inspection> {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => 'transitionProperty' in animation && (animation.playState === 'running' || animation.pending)).length),
    { timeout: 5_000, message: 'CSS transitions settle' }).toBe(0);
  return page.evaluate(async ({ ids, textCells }) => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas color resolution is unavailable.');
    const rgba = (value: string): [number, number, number, number] => {
      const sentinel = 'rgba(1, 2, 3, 0.5)';
      context.fillStyle = sentinel;
      if (!CSS.supports('color', value)) throw new Error(`Not a resolvable CSS color: "${value}"`);
      context.fillStyle = value;
      if (context.fillStyle === sentinel) throw new Error(`Canvas could not resolve "${value}"`);
      context.clearRect(0, 0, 1, 1); context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data; return [r, g, b, a];
    };
    const root = document.documentElement, body = getComputedStyle(document.body);
    const scroller = document.querySelector<HTMLElement>('[data-task-table-scroll]');
    const head = scroller?.querySelector('thead tr') ?? null;
    const headCell = head?.firstElementChild ?? null;
    const headGutter = headCell?.querySelector<HTMLElement>('span[aria-hidden="true"]') ?? null;
    const rows = ids.map(id => {
      const row = scroller?.querySelector<HTMLTableRowElement>(`tr[data-task-row="${CSS.escape(id)}"]`);
      const button = row?.querySelector<HTMLElement>(':scope > td:first-child [data-task-select]');
      if (!row || !button) throw new Error('Selection fixture row or its gutter is missing.');
      const cells = [...row.children].filter((cell): cell is HTMLTableCellElement => cell instanceof HTMLTableCellElement && cell.tagName === 'TD');
      const texts = textCells.flatMap(index => {
        const cell = cells[index];
        if (!cell) throw new Error(`Direct cell ${index} is missing.`);
        const found: { cell: number; text: string; color: [number, number, number, number]; layers: [number, number, number, number][] }[] = [];
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.trim() ?? '', owner = node.parentElement;
          if (!text || !owner) continue;
          const box = owner.getBoundingClientRect();
          if (box.width <= 2 || box.height <= 2) continue;
          const layers: [number, number, number, number][] = [];
          for (let at: Element | null = owner; at; at = at.parentElement) {
            const color = rgba(getComputedStyle(at).backgroundColor);
            if (color[3] > 0) layers.push(color);
            if (color[3] === 255 || at === cell) break;
          }
          found.push({ cell: index, text, color: rgba(getComputedStyle(owner).color), layers });
        }
        return found;
      });
      const edge = getComputedStyle(button);
      return { id, selected: row.getAttribute('aria-selected'), pressed: button.getAttribute('aria-pressed'), height: row.getBoundingClientRect().height,
        cells: cells.map(cell => rgba(getComputedStyle(cell).backgroundColor)),
        gutter: { left: edge.borderLeftWidth, right: edge.borderRightWidth, background: rgba(edge.backgroundColor) }, texts };
    });
    return {
      theme: root.getAttribute('data-theme'), token: rgba(getComputedStyle(root).getPropertyValue('--color-selection').trim()),
      // Base CSS paints the canvas on <html> (body stays transparent); body text color inherits from it.
      body: { background: rgba(getComputedStyle(root).backgroundColor), color: rgba(body.color) },
      scroll: { x: window.scrollX, y: window.scrollY, tableLeft: scroller?.scrollLeft ?? 0, tableTop: scroller?.scrollTop ?? 0 },
      widths: head ? [...head.children].map(cell => cell.getBoundingClientRect().width) : [],
      headerGutter: headCell && headGutter ? { left: getComputedStyle(headGutter).borderLeftWidth, right: getComputedStyle(headGutter).borderRightWidth,
        background: rgba(getComputedStyle(headGutter).backgroundColor), cell: rgba(getComputedStyle(headCell).backgroundColor) } : null,
      rows,
    };
  }, { ids: [...ids], textCells: [...textCells] });
}
function sameColumns(before: Inspection, after: Inspection) {
  expect(after.widths).toHaveLength(before.widths.length);
  after.widths.forEach((width, index) => expect(Math.abs(width - requireValue(before.widths[index])), `column ${index}`).toBeLessThanOrEqual(0.5));
  for (const row of after.rows) expect(Math.abs(row.height - 41), `row ${row.id}`).toBeLessThanOrEqual(1);
}
function sameLayout(before: Inspection, after: Inspection) {
  for (const key of ['x', 'y', 'tableLeft', 'tableTop'] as const) expect(Math.abs(after.scroll[key] - before.scroll[key]), key).toBeLessThanOrEqual(1);
  sameColumns(before, after);
}
function expectSelectedPaint(view: Inspection, task: TaskDto, estimateIndex: number) {
  const row = requireValue(view.rows.find(item => item.id === task.id));
  expect(row.selected).toBe('true'); expect(row.pressed).toBe('true'); expect(row.cells).toHaveLength(view.widths.length);
  row.cells.forEach((cell, index) => expect(cell, `${task.title} direct td ${index}`).toEqual(view.token));
  expect(row.gutter.left).toBe('0px'); expect(row.gutter.right).toBe('0px'); expect([TRANSPARENT, view.token]).toContainEqual(row.gutter.background);
  expect(row.texts.some(text => text.cell === 0 && text.text === task.title)).toBe(true);
  expect(row.texts.some(text => text.cell === estimateIndex && text.text !== '—')).toBe(true);
  for (const text of row.texts) {
    const background = flatten(text.layers);
    expect(background, text.text).toEqual(view.token); expect(contrast(text.color, background), text.text).toBeGreaterThanOrEqual(4.5);
  }
}
function expectUnselectedPaint(view: Inspection, task: TaskDto) {
  const row = requireValue(view.rows.find(item => item.id === task.id));
  expect(row.selected).toBe('false'); expect(row.pressed).toBe('false'); expect(row.cells).toHaveLength(view.widths.length);
  row.cells.forEach((cell, index) => expect(cell, `${task.title} direct td ${index}`).not.toEqual(view.token));
}

async function expectTheme(page: Page, theme: Theme) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(themeButton(page)).toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  await expect(themeButton(page)).toHaveAttribute('title', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
}
/** Starts from the saved/OS default, always flips once through the visible control, and ends in `theme`. */
async function forceTheme(page: Page, theme: Theme) {
  const button = themeButton(page); await expect(button).toBeVisible();
  const initial: Theme = await button.getAttribute('aria-pressed') === 'true' ? 'dark' : 'light';
  const other: Theme = initial === 'dark' ? 'light' : 'dark';
  await expectTheme(page, initial); const first = await inspect(page);
  await button.click(); await expectTheme(page, other); const second = await inspect(page);
  if (other !== theme) {
    await button.click(); await expectTheme(page, theme); const back = await inspect(page);
    expect(back.token).toEqual(first.token); expect(back.body).toEqual(first.body);
  }
  const light = initial === 'light' ? first : second, dark = initial === 'dark' ? first : second;
  expect(light.theme).toBe('light'); expect(dark.theme).toBe('dark');
  expect(light.body.background).not.toEqual(dark.body.background); expect(light.body.color).not.toEqual(dark.body.color);
  expect(light.token).not.toEqual(dark.token);
  for (const view of [light, dark]) { expect(view.token[3]).toBe(255); expect(contrast(view.body.color, view.token)).toBeGreaterThanOrEqual(4.5); }
}

/** A real pointer point on one rendered glyph of the title text, taken from its DOM Range box. */
async function glyphPoint(title: Locator, start: number, end: number, edge: 'left' | 'right') {
  const point = await title.evaluate((node, { start, end, edge }) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), text = walker.nextNode();
    if (!(text instanceof Text) || walker.nextNode() !== null) throw new Error('The title button must render exactly one text node.');
    const range = document.createRange(); range.setStart(text, start); range.setEnd(text, end);
    const boxes = [...range.getClientRects()].filter(box => box.width > 0 && box.height > 0), box = boxes[0];
    if (boxes.length !== 1 || !box) throw new Error('The chosen glyph must render as one visible box.');
    const inset = Math.min(2, box.width / 4);
    const x = edge === 'left' ? box.left + inset : box.right - inset, y = box.top + box.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit !== null && node.contains(hit), glyph: range.toString() };
  }, { start, end, edge });
  expect(point.hit).toBe(true); return point;
}
async function rawClick(page: Page, target: Locator, modifier?: 'Shift' | 'Meta' | 'Control') {
  const point = await center(target);
  expect(await target.evaluate((node, { x, y }) => { const hit = document.elementFromPoint(x, y); return hit !== null && node.contains(hit); }, point)).toBe(true);
  if (modifier) await page.keyboard.down(modifier);
  try { await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.up(); } finally { if (modifier) await page.keyboard.up(modifier); }
}
const HEADER_CLEARANCE = 80, FOOTER_CLEARANCE = 8, WHEEL_STEPS = 8;
/**
 * 390px only: the fixed bulk footer can cover a lower row that scrollIntoViewIfNeeded already deems visible.
 * Navigates with real wheel steps over the exposed page above the footer; never scripted scroll or forced clicks.
 * Throws with geometry, rather than bypassing, when the wheel cannot clear the footer.
 */
async function wheelClearOfFooter(page: Page, target: Locator) {
  const viewport = requireValue(page.viewportSize() ?? undefined), px = (value: number) => Math.round(value * 10) / 10;
  const geometry = async () => {
    const box = requireValue(await target.boundingBox() ?? undefined), panel = await bulkRegion(page).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, footerTop: panel?.y ?? viewport.height, scrollY: await page.evaluate(() => window.scrollY) };
  };
  for (let step = 0; ; step++) {
    const at = await geometry(), limit = at.footerTop - FOOTER_CLEARANCE, middle = (HEADER_CLEARANCE + limit) / 2;
    const below = at.y >= limit, above = at.y <= HEADER_CLEARANCE;
    if (!below && !above && at.x >= 0 && at.x <= viewport.width
      && await target.evaluate((node, { x, y }) => { const hit = document.elementFromPoint(x, y); return hit !== null && node.contains(hit); }, at)) return;
    const where = `center=(${px(at.x)},${px(at.y)}) band=[${HEADER_CLEARANCE},${px(limit)}] footerTop=${px(at.footerTop)} viewport=${viewport.width}x${viewport.height} scrollY=${px(at.scrollY)}`;
    if (!below && !above) throw new Error(`Selection target is occluded inside the exposed band: ${where}`);
    if (step === WHEEL_STEPS) throw new Error(`Selection target still occluded after ${WHEEL_STEPS} wheel steps: ${where}`);
    await page.mouse.move(viewport.width / 2, middle); await page.mouse.wheel(0, Math.round(at.y - middle)); await frames(page);
    const after = await geometry();
    console.log(`SELECTION_WHEEL_NAV ${JSON.stringify({ step: step + 1, scrollY: [px(at.scrollY), px(after.scrollY)],
      targetCenterY: [px(at.y), px(after.y)], footerTop: [px(at.footerTop), px(after.footerTop)] })}`);
    if (Math.abs(after.y - at.y) < 0.5) throw new Error(`Wheel made no scroll progress: ${where} afterScrollY=${px(after.scrollY)} afterCenterY=${px(after.y)}`);
  }
}

interface CaretCase { title: string; start: number; end: number; edge: 'left' | 'right'; caret: number }
// Distinct fresh tasks per click, so a retained Escape draft is never reopened.
const caretCases: readonly CaretCase[] = [
  { title: LAUNCH, start: 5, end: 7, edge: 'right', caret: 7 },
  { title: `${LAUNCH} - start`, start: 0, end: 1, edge: 'left', caret: 0 },
  { title: `${LAUNCH} - accent`, start: 18, end: 19, edge: 'left', caret: 18 },
  { title: `${LAUNCH} - end`, start: LAUNCH.length + 5, end: LAUNCH.length + 6, edge: 'right', caret: LAUNCH.length + 6 },
];
async function caretAtClickedText(page: Page, info: TestInfo, theme: Theme) {
  expect(LAUNCH).toHaveLength(19); expect(LAUNCH.codePointAt(5)).toBe(0x1f680);
  const f = await freshProject(page, provider, `Caret ${theme}`); const tasks: TaskDto[] = [];
  for (const item of caretCases) { const task = await createFixtureTask(f, item.title); expect(task.title).toBe(item.title); tasks.push(task); }
  await openTable(f); await forceTheme(page, theme);
  const before = manualOrder(await allTasks(f)); const writes = observeCommands(page, f.prefix);
  for (const [index, item] of caretCases.entries()) {
    const task = requireValue(tasks[index]), title = titleButton(page, task.id), input = taskName(page, task.id);
    await title.scrollIntoViewIfNeeded(); await expect(title).toHaveText(item.title); await expect(title).toHaveAttribute('title', item.title);
    await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveCount(0);
    const opened = await viewportState(page, task.id); expect(Math.abs(opened.height - 41)).toBeLessThanOrEqual(1);
    const point = await glyphPoint(title, item.start, item.end, item.edge); expect(point.glyph).toBe(item.title.slice(item.start, item.end));
    await page.mouse.move(point.x, point.y);
    expect(await title.evaluate(node => node.matches(':hover'))).toBe(true);
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[title]')?.getAttribute('title') ?? null, point)).toBe(item.title);
    await picture(page, info, `caret-${theme}-${index}-hover`);
    await page.mouse.down(); await page.mouse.up();
    await expect(input).toBeFocused(); await expect(input).toHaveValue(item.title);
    expect(await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([item.caret, item.caret]);
    stableViewport(opened, await viewportState(page, task.id)); await picture(page, info, `caret-${theme}-${index}-open`);
    await page.keyboard.type('X');
    await expect(input).toHaveValue(`${item.title.slice(0, item.caret)}X${item.title.slice(item.caret)}`);
    await page.keyboard.press('Escape'); await expect(input).toHaveCount(0);
    await expect(title).toHaveText(item.title); expect(writes.commands).toEqual([]);
    stableViewport(opened, await viewportState(page, task.id));
  }
  await frames(page); expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before); writes.close();
}

async function selectionPaint(page: Page, info: TestInfo, width: 1440 | 390, theme: Theme) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  const f = await freshProject(page, provider, `Selection ${width} ${theme}`);
  const tag = (await apiWrite(page, `${f.prefix}/tags`, { name: 'Selection paint tag', color: '#2563eb' }, tagResponseSchema)).data;
  const fixtures: TaskDto[] = [];
  // The third row is completed, so its muted title paint is held to the same selected contrast.
  for (const [title, estimateMinutes, statusId] of [['First gutter row', 30, f.todoId], ['Middle toggled row', 90, f.todoId], ['Third shift row', 150, f.doneId]] as const) {
    const created = await createFixtureTask(f, title, { estimateMinutes, statusId }); expect(created.statusId).toBe(statusId);
    fixtures.push((await apiWrite(page, `${f.prefix}/tasks/${created.id}`, { expectedRevision: created.revision, tagIds: [tag.id] }, taskResponseSchema, 'PATCH')).data);
  }
  const a = requireValue(fixtures[0]), b = requireValue(fixtures[1]), c = requireValue(fixtures[2]);
  expect(c.statusId).toBe(f.doneId);
  await openTable(f); await showColumns(page, ['Tags', 'Team estimate']);
  await expect(savedRow(page, c.id).getByRole('button', { name: `Reopen ${c.title}`, exact: true })).toBeVisible();
  const table = page.locator('[data-task-table-scroll] table');
  const column = (name: string) => table.getByRole('columnheader', { name, exact: true }).evaluate((node: HTMLTableCellElement) => node.cellIndex);
  const tagsIndex = await column('Tags'), estimateIndex = await column('Team estimate');
  for (const task of fixtures) {
    expect(task.tags.map(value => value.id)).toEqual([tag.id]); expect(task.estimateMinutes).not.toBeNull();
    await expect(savedRow(page, task.id).locator(':scope > td').nth(tagsIndex)).toContainText(tag.name);
  }
  await forceTheme(page, theme);
  const before = manualOrder(await allTasks(f)); const writes = observeCommands(page, f.prefix);
  for (const task of [c, b, a]) await gutter(page, task.title).scrollIntoViewIfNeeded();
  const ids = [a.id, b.id, c.id], textCells = [0, estimateIndex];
  const baseline = await inspect(page, ids, textCells);
  for (const row of baseline.rows) expect(Math.abs(row.height - 41), `row ${row.id}`).toBeLessThanOrEqual(1);
  for (const task of fixtures) expectUnselectedPaint(baseline, task);
  await picture(page, info, `selection-${width}-${theme}-none`);

  await rawClick(page, gutter(page, a.title)); expect(await selected(page)).toEqual([a.id]);
  const afterFirst = await inspect(page, ids, textCells); sameLayout(baseline, afterFirst);
  // Only the deliberate mobile wheel may move the page; each selection click is still held to no jump.
  if (width === 390) await wheelClearOfFooter(page, gutter(page, c.title));
  const preShift = width === 390 ? await inspect(page, ids, textCells) : baseline;
  await rawClick(page, gutter(page, c.title), 'Shift'); expect(await selected(page)).toEqual(ids);
  await expect(bulkRegion(page)).toContainText('3 tasks selected');
  const range = await inspect(page, ids, textCells); sameLayout(preShift, range); sameColumns(baseline, range);
  for (const task of fixtures) expectSelectedPaint(range, task, estimateIndex);
  await picture(page, info, `selection-${width}-${theme}-range`);

  if (width === 390) await wheelClearOfFooter(page, gutter(page, b.title));
  const preToggle = width === 390 ? await inspect(page, ids, textCells) : baseline;
  await rawClick(page, gutter(page, b.title), toggleKey); expect(await selected(page)).toEqual([a.id, c.id]);
  await expect(bulkRegion(page)).toContainText('2 tasks selected');
  const toggled = await inspect(page, ids, textCells); sameLayout(preToggle, toggled); sameColumns(baseline, toggled);
  expectSelectedPaint(toggled, a, estimateIndex); expectSelectedPaint(toggled, c, estimateIndex); expectUnselectedPaint(toggled, b);
  const head = requireValue(toggled.headerGutter ?? undefined);
  expect(head.left).toBe('0px'); expect(head.right).toBe('0px'); expect([TRANSPARENT, head.cell]).toContainEqual(head.background);
  await expect(page.getByRole('textbox', { name: 'Task name', exact: true })).toHaveCount(0); await expect(page.getByRole('dialog')).toHaveCount(0);
  await picture(page, info, `selection-${width}-${theme}-toggled`);

  if (width === 390) {
    // The table's own horizontal scroll reveals Tags/estimate; the page itself never pans sideways.
    await savedRow(page, c.id).locator(':scope > td').nth(estimateIndex).scrollIntoViewIfNeeded();
    const revealed = await inspect(page, ids, textCells); sameColumns(baseline, revealed);
    expect(revealed.scroll.tableLeft).toBeGreaterThan(baseline.scroll.tableLeft); expect(revealed.scroll.x).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expectSelectedPaint(revealed, a, estimateIndex); expectSelectedPaint(revealed, c, estimateIndex); expectUnselectedPaint(revealed, b);
    await picture(page, info, `selection-${width}-${theme}-revealed`);
  }
  await frames(page); expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before); writes.close();
}

// A single provider/JWKS key per serial suite. Root restarts its private API between failed runs.
test.describe('title caret and opaque row selection in both themes', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth native gate requires traces and video off.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); });

  test('light desktop title click opens at the clicked UTF-16 glyph on four fresh tasks and Escape writes nothing', async ({ page }, info) => { await caretAtClickedText(page, info, 'light'); });
  test('dark desktop title click opens at the clicked UTF-16 glyph on four fresh tasks and Escape writes nothing', async ({ page }, info) => { await caretAtClickedText(page, info, 'dark'); });

  test('held real title ACK leaves raw-mouse focus on another row gutter and confirms one exact revision', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Caret held ACK');
    const target = await createFixtureTask(f, LAUNCH, { estimateMinutes: 45 }), stable = await createFixtureTask(f, 'Stable focus row', { estimateMinutes: 30 });
    await openTable(f); const writes = observeCommands(page, f.prefix);
    const title = titleButton(page, target.id), input = taskName(page, target.id); await title.scrollIntoViewIfNeeded();
    const point = await glyphPoint(title, 5, 7, 'right');
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.up();
    await expect(input).toBeFocused(); expect(await input.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd])).toEqual([7, 7]);
    const edited = `${LAUNCH.slice(0, 7)}X${LAUNCH.slice(7)}`; await page.keyboard.type('X'); await expect(input).toHaveValue(edited);
    let release!: () => void; let held = false; const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**${f.prefix}/tasks/${target.id}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(200); held = true; await gate; await route.fulfill({ response });
    });
    const focusTarget = gutter(page, stable.title); const spot = await center(focusTarget); const baseline = await viewportState(page, stable.id);
    try {
      await page.keyboard.press('Control+Enter'); await expect.poll(() => held).toBe(true);
      await page.mouse.move(spot.x, spot.y); await page.mouse.down(); await page.mouse.up();
      await expect(focusTarget).toBeFocused(); stableViewport(baseline, await viewportState(page, stable.id));
      expect(writes.commands).toHaveLength(1); expect((await allTasks(f)).find(row => row.id === target.id)?.title).toBe(edited);
      await picture(page, info, 'caret-ack-held');
    } finally { release(); }
    await expect(title).toHaveText(edited); await expect(input).toHaveCount(0);
    await frames(page); await expect(focusTarget).toBeFocused(); stableViewport(baseline, await viewportState(page, stable.id));
    await picture(page, info, 'caret-ack-confirmed');
    expect(writes.commands).toHaveLength(1); const sent = requireValue(writes.commands[0]);
    expect(sent.method).toBe('PATCH'); expect(sent.path).toBe(`${f.prefix}/tasks/${target.id}`);
    expect(JSON.parse(sent.body)).toEqual({ expectedRevision: target.revision, title: edited });
    const after = await allTasks(f), saved = requireValue(after.find(row => row.id === target.id));
    expect(saved.title).toBe(edited); expect(saved.revision).not.toBe(target.revision);
    expect({ ...unchangedData(saved), title: target.title }).toEqual(unchangedData(target));
    expect(after.find(row => row.id === stable.id)).toEqual(stable); writes.close();
  });

  test('light desktop gutter, Shift and Meta/Ctrl selection paints every direct cell with the opaque token', async ({ page }, info) => { await selectionPaint(page, info, 1440, 'light'); });
  test('dark desktop gutter, Shift and Meta/Ctrl selection paints every direct cell with the opaque token', async ({ page }, info) => { await selectionPaint(page, info, 1440, 'dark'); });
  test('light mobile gutter, Shift and Meta/Ctrl selection paints every direct cell inside390pixels', async ({ page }, info) => { await selectionPaint(page, info, 390, 'light'); });
  test('dark mobile gutter, Shift and Meta/Ctrl selection paints every direct cell inside390pixels', async ({ page }, info) => { await selectionPaint(page, info, 390, 'dark'); });


  test('neutral row arrows and Shift ranges work in both themes, Enter opens once, and editors retain their keys without writes', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Keyboard row selection');
    const a = await createFixtureTask(f, 'Keyboard first'), b = await createFixtureTask(f, 'Keyboard second'), c = await createFixtureTask(f, 'Keyboard third');
    await openTable(f); const before = manualOrder(await allTasks(f)); const writes = observeCommands(page, f.prefix);
    for (const theme of ['light', 'dark'] as const) {
      await forceTheme(page, theme);
      await rawClick(page, gutter(page, a.title)); await expect(gutter(page, a.title)).toBeFocused();
      expect(await selected(page)).toEqual([a.id]);
      const stable = await viewportState(page, a.id), geometry = await inspect(page, [a.id, b.id, c.id]);
      await page.keyboard.press('ArrowDown'); await expect(gutter(page, b.title)).toBeFocused(); expect(await selected(page)).toEqual([b.id]);
      await page.keyboard.press('Shift+ArrowDown'); await expect(gutter(page, c.title)).toBeFocused(); expect(await selected(page)).toEqual([b.id, c.id]);
      await page.keyboard.press('Shift+ArrowUp'); await expect(gutter(page, b.title)).toBeFocused(); expect(await selected(page)).toEqual([b.id]);
      await page.keyboard.press('ArrowUp'); await expect(gutter(page, a.title)).toBeFocused(); expect(await selected(page)).toEqual([a.id]);
      await page.keyboard.press('ArrowUp'); await expect(gutter(page, a.title)).toBeFocused(); expect(await selected(page)).toEqual([a.id]);
      stableViewport(stable, await viewportState(page, a.id)); sameColumns(geometry, await inspect(page, [a.id, b.id, c.id]));
      await page.keyboard.press('Enter'); const pane = page.locator('[data-task-panel][data-state="open"]');
      await expect(pane).toHaveCount(1); await expect(pane.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(a.title);
      expect(await selected(page)).toEqual([a.id]);
      await page.keyboard.press('Escape'); await expect(pane).toHaveCount(0); await expect(gutter(page, a.title)).toBeFocused();
      await titleButton(page, a.id).click(); const input = taskName(page, a.id); await expect(input).toBeFocused();
      await page.keyboard.press('ArrowDown'); await expect(input).toBeFocused(); expect(await selected(page)).toEqual([a.id]);
      await expect(page.locator('[data-task-panel][data-state="open"]')).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(input).toHaveCount(0);
      await rawClick(page, gutter(page, a.title)); await page.keyboard.press('Escape'); expect(await selected(page)).toEqual([]);
      await picture(page, info, `keyboard-selection-${theme}`);
    }
    await frames(page); expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before); writes.close();
  });

  test('keyboard navigation crosses visible groups, skips collapsed rows, reveals the next offscreen row minimally and never hijacks a draft', async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Keyboard visible rows');
    const section = (await apiWrite(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Keyboard grouped section' }, sectionResponseSchema)).data;
    const groupedA = await createFixtureTask(f, 'Keyboard grouped first', { sectionId: section.id });
    const groupedB = await createFixtureTask(f, 'Keyboard grouped last', { sectionId: section.id });
    const parent = await createFixtureTask(f, 'Keyboard parent');
    const child = await createFixtureTask(f, 'Keyboard concealed child', { parentTaskId: parent.id });
    const tail: TaskDto[] = [];
    for (let index = 0; index < 24; index += 1) tail.push(await createFixtureTask(f, `Keyboard long row ${String(index + 1).padStart(2, '0')}`));
    await openTable(f); const before = manualOrder(await allTasks(f)); const writes = observeCommands(page, f.prefix);
    await rawClick(page, gutter(page, groupedA.title)); await page.keyboard.press('ArrowDown');
    await expect(gutter(page, groupedB.title)).toBeFocused(); expect(await selected(page)).toEqual([groupedB.id]);
    await page.keyboard.press('ArrowDown'); await expect(gutter(page, parent.title)).toBeFocused(); expect(await selected(page)).toEqual([parent.id]);
    await savedRow(page, parent.id).getByRole('button', { name: `Collapse subtasks of “${parent.title}”`, exact: true }).click();
    await expect(savedRow(page, child.id)).toHaveCount(0);
    await page.getByRole('button', { name: `Collapse section “${section.name}”`, exact: true }).click();
    await expect(savedRow(page, groupedA.id)).toHaveCount(0); await expect(savedRow(page, groupedB.id)).toHaveCount(0);
    await rawClick(page, gutter(page, parent.title));
    let didScroll = false;
    for (const task of tail) {
      const prior = await savedRow(page, task.id).evaluate(row => {
        const box = row.getBoundingClientRect(), table = row.closest('[data-task-table-scroll]');
        const footer = document.querySelector<HTMLElement>('section.fixed.bottom-3'); const foot = footer?.getBoundingClientRect();
        const overlap = foot && foot.right > box.left && foot.left < box.right;
        return { y: window.scrollY, x: window.scrollX, tableLeft: table?.scrollLeft ?? 0, bottom: box.bottom, visibleBottom: overlap ? Math.min(innerHeight, foot.top) : innerHeight };
      });
      await page.keyboard.press('ArrowDown'); await expect(gutter(page, task.title)).toBeFocused(); expect(await selected(page)).toEqual([task.id]);
      const after = await savedRow(page, task.id).evaluate(row => {
        const box = row.getBoundingClientRect(), table = row.closest('[data-task-table-scroll]');
        const header = row.closest('[data-app-shell-main]')?.parentElement?.querySelector(':scope > header')?.getBoundingClientRect();
        const footer = document.querySelector<HTMLElement>('section.fixed.bottom-3'); const foot = footer?.getBoundingClientRect();
        const overlap = foot && foot.right > box.left && foot.left < box.right;
        return { y: window.scrollY, x: window.scrollX, tableLeft: table?.scrollLeft ?? 0, top: box.top, bottom: box.bottom, headerBottom: header?.bottom ?? 0, visibleBottom: overlap ? Math.min(innerHeight, foot.top) : innerHeight, height: box.height };
      });
      expect(Math.abs(after.x - prior.x)).toBeLessThanOrEqual(1); expect(Math.abs(after.tableLeft - prior.tableLeft)).toBeLessThanOrEqual(1);
      expect(after.top).toBeGreaterThanOrEqual(after.headerBottom - 1); expect(after.bottom).toBeLessThanOrEqual(after.visibleBottom + 1);
      expect(Math.abs(after.height - 41)).toBeLessThanOrEqual(1);
      const movement = after.y - prior.y; expect(movement).toBeGreaterThanOrEqual(-1);
      expect(movement).toBeLessThanOrEqual(Math.max(0, prior.bottom - prior.visibleBottom) + 2); didScroll ||= movement > 1;
    }
    expect(didScroll).toBe(true); const last = requireValue(tail.at(-1)); const end = await viewportState(page, last.id);
    await page.keyboard.press('ArrowDown'); await expect(gutter(page, last.title)).toBeFocused(); stableViewport(end, await viewportState(page, last.id));
    await page.keyboard.press('Escape'); expect(await selected(page)).toEqual([]); await expect(bulkRegion(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Add task without a section', exact: true }).click();
    const draft = page.locator('[data-task-draft-row][data-task-draft-state="draft"]'); const draftName = draft.getByRole('textbox', { name: 'Task name', exact: true });
    await expect(draftName).toBeFocused(); await page.keyboard.press('ArrowUp'); await expect(draftName).toBeFocused(); expect(await selected(page)).toEqual([]);
    await page.keyboard.press('Escape'); await expect(draft).toHaveCount(0);
    await picture(page, info, 'keyboard-nearest-visible'); await frames(page);
    expect(writes.commands).toEqual([]); expect(manualOrder(await allTasks(f))).toEqual(before); writes.close();
  });
});
