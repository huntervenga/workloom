// Asana-like task grid acceptance prepared in source. Execute only in the coordinator's compiled window
// (tests/e2e/asana-table-interactions.config.ts); no result is claimed from source.
//
// Intended contract (current source is expected RED where noted in the handoff):
// - Opening, typing in, saving, pending, failing and retrying any table editor never changes the
//   table width, header widths or any task row height. Pickers are portaled outside the table.
// - Status, assignee, priority and custom single-select use a custom listbox (never a native SELECT);
//   ArrowUp/ArrowDown move, Enter or a click commits the explicit choice at once, Escape closes without a write.
// - Clicking the visible task title edits it in place: the title button's accessible name is the task
//   title itself; task details stay a separate "Open task “{title}”" action.
// - The expanded section's add row keeps the existing "Add task to “{section}”" name.
// - A custom single-select cell is one direct combobox named "Edit {field} for {title}" (inlineFields.edit).
// - Journeys: leaving a dirty title for an adjacent cell saves it once and opens that cell's picker after the
//   acknowledgement; while a quick create is unacknowledged the add row stays blank, focused and typeable.
// - A same-task cell click after a confirmed acknowledgement but before the refreshed list head never opens
//   against the pre-confirmation row; it opens on the refreshed head and saves against the confirmed revision.
// - Normal editing, pending and closing never move the table's document origin (scroll offsets excluded).
// - A real pointer click on non-focusable page content dismisses a status/priority picker without a write and
//   without returning focus to the old cell.
// - Unconfirmed custom-value feedback lives in the top layer but never paints above task details or its value
//   dialog; it returns unchanged after only the dialogs close, and its retry resends the original body and key.
// All labels come from the current English catalogs.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type Route, type TestInfo } from '@playwright/test';
import {
  personalTablePreferenceResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueListResponseSchema, taskFieldValueResponseSchema,
  taskListResponseSchema, taskResponseSchema, type ColumnChoice, type TaskDto, type TaskTableBuiltinColumn,
} from '@workloom/contracts';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import type { Daily } from './support/next-ux.js';

const CUSTOM_EDIT_LABEL = (field: string, title: string) => `Edit ${field} for ${title}`;
const viewports = [['desktop', { width: 1440, height: 1000 }], ['medium', { width: 1024, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const;

const taskTable = (page: Page) => page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Task', exact: true }) });
const inlineForm = (page: Page) => page.getByRole('form', { name: /^Edit .+ in the task table$/ });
const quickForm = (page: Page) => page.getByRole('form', { name: 'Add a task to QA section', exact: true });
const picker = (page: Page) => page.getByRole('listbox');

/** Personal columns for this new QA project only; estimate stays last so it is pinned from lg. */
async function useColumns(f: Daily, fieldId?: string) {
  const shown: TaskTableBuiltinColumn[] = ['title', 'status', 'responsible', 'dueDate', 'priority'];
  const hidden: TaskTableBuiltinColumn[] = ['participants', 'tags', 'weeklyPlan', 'weeklyActual'];
  const columns: ColumnChoice[] = [
    ...shown.map(key => ({ column: { kind: 'builtin' as const, key }, visible: true })),
    ...(fieldId ? [{ column: { kind: 'field' as const, fieldId }, visible: true }] : []),
    { column: { kind: 'builtin', key: 'estimate' }, visible: true },
    ...hidden.map(key => ({ column: { kind: 'builtin' as const, key }, visible: false })),
  ];
  const r = await f.request.put(`${f.prefix}/projects/${f.project.id}/table-preferences/me`, { headers: { origin: f.origin, 'idempotency-key': randomUUID() }, data: { expectedRevision: 0, columns } });
  expect(r.status(), await r.text()).toBe(200);
  return personalTablePreferenceResponseSchema.parse(await r.json()).data;
}

async function projectTasks(f: Daily) {
  const r = await f.request.get(`${f.prefix}/tasks`, { params: { projectId: f.project.id, limit: 200, includeArchived: 'true' } });
  expect(r.status(), await r.text()).toBe(200);
  return taskListResponseSchema.parse(await r.json()).data;
}

/**
 * Read-only: rendered table, header and every body-row size, plus the table's document origin. The origin
 * adds the window and table-scrollport scroll offsets, so a legitimate focus scroll is not a shift, while
 * content inserted above the table (a page-level notice) is. Portaled popovers are not row content.
 */
function grid(page: Page) {
  return taskTable(page).evaluate(node => {
    const table = node as HTMLTableElement, px = (n: number) => Math.round(n * 10) / 10;
    const scroller = table.closest<HTMLElement>('[data-task-table-scroll]');
    return {
      top: px(table.getBoundingClientRect().top + scrollY + (scroller?.scrollTop ?? 0)),
      table: px(table.getBoundingClientRect().width),
      head: [...(table.tHead?.rows[0]?.cells ?? [])].map(cell => ({ name: cell.textContent?.trim() ?? '', width: px(cell.getBoundingClientRect().width) })),
      rows: [...table.tBodies].flatMap(body => [...body.rows]).map(row => ({ text: (row.cells[0]?.textContent ?? '').trim().slice(0, 48), height: px(row.getBoundingClientRect().height) })),
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}
type Grid = Awaited<ReturnType<typeof grid>>;
const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
/** `origin: false` is only for a state that intentionally shows a page-level notice; normal editing, pending and closing keep it. */
function frameDrift(before: Grid, after: Grid, out: string[], { origin = true } = {}) {
  if (origin && !near(before.top, after.top)) out.push(`table document top ${before.top} → ${after.top}`);
  if (!near(before.table, after.table)) out.push(`table width ${before.table} → ${after.table}`);
  if (before.head.length !== after.head.length) out.push(`header count ${before.head.length} → ${after.head.length}`);
  before.head.forEach((cell, i) => { const next = after.head[i]; if (next && !near(cell.width, next.width)) out.push(`header ${cell.name} ${cell.width} → ${next.width}`); });
  if (after.pageOverflow > 0) out.push(`page horizontal overflow ${after.pageOverflow}`);
}
function drift(before: Grid, after: Grid, options?: { origin?: boolean }): string[] {
  const out: string[] = [];
  frameDrift(before, after, out, options);
  if (before.rows.length !== after.rows.length) out.push(`row count ${before.rows.length} → ${after.rows.length}`);
  before.rows.forEach((row, i) => { const next = after.rows[i]; if (next && !near(row.height, next.height)) out.push(`row ${i} "${row.text}" ${row.height} → ${next.height}`); });
  return out;
}
/** Creation may add rows: compare the frame and every pre-existing row matched by its unique first-cell text. */
function driftKept(before: Grid, after: Grid): string[] {
  const out: string[] = [];
  frameDrift(before, after, out);
  const unique = (g: Grid) => new Map(g.rows.filter(row => row.text !== '' && g.rows.filter(other => other.text === row.text).length === 1).map(row => [row.text, row.height]));
  const later = unique(after); let matched = 0;
  for (const [text, height] of unique(before)) { const next = later.get(text); if (next === undefined) continue; matched++; if (!near(height, next)) out.push(`row "${text}" ${height} → ${next}`); }
  if (matched === 0) out.push('no pre-existing row could be matched');
  return out;
}

/** Read-only placement: positive size, fully inside the viewport, owns the hit at its center. */
function placement(target: Locator) {
  return target.evaluate(el => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { tag: el.tagName, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh, hit: hit !== null && (hit === el || el.contains(hit)), inTable: el.closest('table') !== null };
  });
}

/** Read-only picker check: portaled listbox in the viewport; every option visible in its frame owns its hit. */
function pickerGeometry(listbox: Locator) {
  return listbox.evaluate(box => {
    const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, r = box.getBoundingClientRect();
    const frame = { left: Math.max(0, r.left + box.clientLeft), top: Math.max(0, r.top + box.clientTop), right: Math.min(vw, r.left + box.clientLeft + box.clientWidth), bottom: Math.min(vh, r.top + box.clientTop + box.clientHeight) };
    const options = [...box.querySelectorAll('[role="option"]')].map(option => {
      const q = option.getBoundingClientRect(), shown = q.height > 0 && q.top >= frame.top - 0.5 && q.bottom <= frame.bottom + 0.5 && q.left >= frame.left - 0.5 && q.right <= frame.right + 0.5;
      const hit = shown ? document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) : null;
      return { name: option.getAttribute('aria-label') ?? option.textContent?.trim() ?? '', selected: option.getAttribute('aria-selected') === 'true', shown, hit: hit !== null && (hit === option || option.contains(hit)) };
    });
    return { tag: box.tagName, portaled: box.closest('table') === null, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh, options };
  });
}
async function expectUsablePicker(page: Page) {
  const listbox = picker(page); await expect(listbox).toHaveCount(1); await expect(listbox).toBeVisible();
  const geometry = await pickerGeometry(listbox);
  expect(geometry.tag).not.toBe('SELECT'); expect(geometry.portaled).toBe(true); expect(geometry.inViewport).toBe(true);
  expect(geometry.options.filter(option => option.shown).length).toBeGreaterThan(0); expect(geometry.options.filter(option => option.shown && !option.hit)).toEqual([]);
  // Keyboard ownership: focus sits in the listbox or on a combobox that controls it.
  expect(await page.evaluate(() => {
    const active = document.activeElement; if (!active || active === document.body) return false;
    if (active.closest('[role="listbox"]')) return true;
    const controlled = (active.getAttribute('aria-controls') ?? '').split(' ').filter(Boolean).map(id => document.getElementById(id));
    return active.tagName !== 'SELECT' && controlled.some(el => el?.getAttribute('role') === 'listbox');
  })).toBe(true);
  expect(await taskTable(page).locator('select').count()).toBe(0);
  return geometry;
}
const isActive = (option: Locator) => option.evaluate(el => el === document.activeElement || (el.id !== '' && document.activeElement?.getAttribute('aria-activedescendant') === el.id));
/** Native arrow keys only; no assumption about the initially active option or wrapping. */
async function arrowTo(page: Page, option: Locator) {
  const count = await picker(page).getByRole('option').count();
  for (const key of ['ArrowDown', 'ArrowUp'] as const) for (let i = 0; i <= count && !(await isActive(option)); i++) await page.keyboard.press(key);
  expect(await isActive(option)).toBe(true);
}
const kept = (task: TaskDto) => ({ title: task.title, description: task.description, statusId: task.statusId, priority: task.priority, startDate: task.startDate, dueDate: task.dueDate, estimateMinutes: task.estimateMinutes, sectionId: task.sectionId, parentTaskId: task.parentTaskId, workPackageId: task.workPackageId, responsibleMembershipId: task.responsibleMembershipId });
function recordWrites(page: Page) {
  const writes: { method: string; path: string }[] = [], errors: string[] = [];
  page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: new URL(q.url()).pathname }); });
  page.on('pageerror', error => errors.push(error.message));
  return { writes, errors };
}
/** One rendered frame after a key, so a request a handler would start has been issued. Not a timer. */
const settleFrame = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`) });
/** Read-only: where focus is now; `inTable` covers both the old cell button and its in-cell editor. */
function focusOwner(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName ?? null, body: active === null || active === document.body, inTable: active !== null && active.closest('table') !== null, label: active?.getAttribute('aria-label') ?? null };
  });
}
/** Read-only: open top-layer popovers outside every dialog; these would paint above a modal dialog. */
function popoversOutsideDialogs(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[popover]')]
    .filter(el => el.matches(':popover-open') && el.closest('[role="dialog"],[role="alertdialog"]') === null)
    .map(el => ({ cellPopover: el.hasAttribute('data-cell-popover'), text: (el.textContent ?? '').trim().slice(0, 80) })));
}

for (const [name, viewport] of viewports) test.describe(`Asana table interactions ${name}`, () => {
  test.use({ viewport });

  test('stable grid: opening, typing and closing every built-in editor keeps table/header widths and every row height; pickers are portaled and hit-testable; no writes', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await dailyFixture(request, baseURL, 'Asana grid'); const columns = await useColumns(f);
    const above = await f.createTask(`${f.token} above`);
    const work = await f.createTask(`${f.token} geometry`, { priority: 'medium', dueDate: '2027-06-01', estimateMinutes: 90 });
    const below = await f.createTask(`${f.token} below`, { responsibleMembershipId: f.other.id, participantMembershipIds: [f.other.id] });
    const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    try {
      await page.goto(f.path); await expect(page.getByRole('button', { name: `Edit status for ${work.title}`, exact: true })).toBeVisible();
      const base = await grid(page); measured.push({ stage: 'base', grid: base });
      for (const [field, label] of [['status', 'Edit status for'], ['assignee', 'Edit assignee for'], ['priority', 'Edit priority for']] as const) {
        const trigger = page.getByRole('button', { name: `${label} ${work.title}`, exact: true }); await trigger.click();
        const opened = await grid(page); const geometry = await expectUsablePicker(page); measured.push({ stage: `${field} open`, grid: opened, picker: geometry });
        expect.soft(drift(base, opened), `${field} open`).toEqual([]); await shot(page, info, `grid-${field}-open-${name}`);
        if (field === 'assignee') {
          await page.keyboard.type(f.other.displayName.slice(0, 3)); const typed = await grid(page); measured.push({ stage: 'assignee search typed', grid: typed });
          expect.soft(drift(base, typed), 'assignee search typing').toEqual([]); await expect(picker(page).getByRole('option', { name: f.other.displayName, exact: true })).toBeVisible();
        }
        await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); await expect(trigger).toBeFocused();
        const closed = await grid(page); measured.push({ stage: `${field} closed`, grid: closed }); expect.soft(drift(base, closed), `${field} closed`).toEqual([]);
      }
      for (const [field, trigger, control, typed] of [
        ['due date', page.getByRole('button', { name: `Edit due date for ${work.title}`, exact: true }), inlineForm(page).getByLabel('Due date', { exact: true }), null],
        ['estimate', page.getByRole('button', { name: `Edit team estimate for ${work.title}`, exact: true }), inlineForm(page).getByRole('textbox', { name: 'Team estimate (hours)', exact: true }), '5'],
        ['title', page.getByRole('button', { name: work.title, exact: true }), inlineForm(page).getByRole('textbox', { name: 'Task name', exact: true }), ' typed'],
      ] as const) {
        await trigger.click(); await expect(control).toBeFocused();
        const opened = await grid(page); const where = await placement(control); measured.push({ stage: `${field} open`, grid: opened, control: where });
        expect.soft(drift(base, opened), `${field} open`).toEqual([]); expect(where).toMatchObject({ inViewport: true, hit: true }); await shot(page, info, `grid-${field}-open-${name}`);
        if (typed !== null) {
          await page.keyboard.press('End'); await page.keyboard.type(typed); const typing = await grid(page); measured.push({ stage: `${field} typing`, grid: typing });
          expect.soft(drift(base, typing), `${field} typing`).toEqual([]);
          for (let i = 0; i < typed.length; i++) await page.keyboard.press('Backspace');
        }
        await page.keyboard.press('Escape'); await expect(control).toHaveCount(0);
        const closed = await grid(page); measured.push({ stage: `${field} closed`, grid: closed }); expect.soft(drift(base, closed), `${field} closed`).toEqual([]);
      }
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(new URL(page.url()).searchParams.get('task')).toBeNull();
      expect(writes).toEqual([]); expect(errors).toEqual([]);
      for (const task of [above, work, below]) expect(await f.task(task.id)).toEqual(task);
    } finally { await evidenceJson(info, `asana-grid-${name}.json`, { viewport, projectId: f.project.id, columns, taskIds: [above.id, work.id, below.id], measured, writes, errors }); }
  });

  test('custom dropdowns: keyboard status, clicked priority and searched assignee commit only the explicit choice once; Escape writes nothing; a held response keeps the grid stable', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await dailyFixture(request, baseURL, 'Asana pickers'); await useColumns(f);
    const work = await f.createTask(`${f.token} picker`, { priority: 'medium', description: 'Unchanged description', dueDate: '2027-06-01', estimateMinutes: 90 });
    const neighbour = await f.createTask(`${f.token} neighbour`);
    const query = f.other.displayName; expect(f.own.displayName.toLowerCase().includes(query.toLowerCase())).toBe(false);
    const path = `${f.prefix}/tasks/${work.id}`, attempts: { key: string | undefined; body: Record<string, unknown> }[] = [];
    const committed = gate(), ack = gate(); const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>; attempts.push({ key: route.request().headers()['idempotency-key'], body });
      const actual = await route.fetch();
      if ('responsibleMembershipId' in body) { committed.release(); await ack.wait; }
      await route.fulfill({ response: actual });
    });
    try {
      await page.goto(f.path); const base = await grid(page);
      const status = page.getByRole('button', { name: `Edit status for ${work.title}`, exact: true });
      await status.click(); await expectUsablePicker(page); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape');
      await expect(picker(page)).toHaveCount(0); await expect(status).toBeFocused(); await settleFrame(page); expect(writes).toEqual([]); expect(await f.task(work.id)).toEqual(work);

      await status.click(); await expectUsablePicker(page); await arrowTo(page, picker(page).getByRole('option', { name: f.progress.name, exact: true })); expect(writes).toEqual([]);
      const statusSaved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await page.keyboard.press('Enter'); const afterStatus = await taskResult(await statusSaved, 200);
      expect(attempts[0]?.body).toEqual({ expectedRevision: work.revision, statusId: f.progress.id });
      expect(kept(afterStatus)).toEqual({ ...kept(work), statusId: f.progress.id }); await expect(picker(page)).toHaveCount(0);
      await expect(status).toContainText(f.progress.name); await expect(status).toBeFocused();

      const priority = page.getByRole('button', { name: `Edit priority for ${work.title}`, exact: true }); await priority.click();
      const options = (await expectUsablePicker(page)).options; expect(options.find(option => option.name === 'High')).toMatchObject({ shown: true, hit: true });
      const prioritySaved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await picker(page).getByRole('option', { name: 'High', exact: true }).click(); const afterPriority = await taskResult(await prioritySaved, 200);
      expect(attempts[1]?.body).toEqual({ expectedRevision: afterStatus.revision, priority: 'high' }); expect(kept(afterPriority)).toEqual({ ...kept(afterStatus), priority: 'high' });
      await expect(picker(page)).toHaveCount(0); await expect(priority).toContainText('High');

      const assignee = page.getByRole('button', { name: `Edit assignee for ${work.title}`, exact: true }); await assignee.click(); await expectUsablePicker(page);
      await page.keyboard.type(query); const target = picker(page).getByRole('option', { name: query, exact: true });
      await expect(target).toBeVisible(); await expect(picker(page).getByRole('option', { name: f.own.displayName, exact: true })).toHaveCount(0);
      await arrowTo(page, target); expect(attempts).toHaveLength(2); await shot(page, info, `picker-assignee-search-${name}`);
      const assigneeSaved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await page.keyboard.press('Enter'); await committed.wait;
      const pending = await grid(page); measured.push({ stage: 'assignee response held', grid: pending }); expect.soft(drift(base, pending), 'held assignee response').toEqual([]); await shot(page, info, `picker-assignee-pending-${name}`);
      expect(attempts).toHaveLength(3); ack.release(); const afterAssignee = await taskResult(await assigneeSaved, 200);
      expect(attempts[2]?.body).toEqual({ expectedRevision: afterPriority.revision, responsibleMembershipId: f.other.id }); expect(kept(afterAssignee)).toEqual({ ...kept(afterPriority), responsibleMembershipId: f.other.id });
      await expect(assignee).toContainText(f.other.displayName);
      const done = await grid(page); measured.push({ stage: 'after three choices', grid: done }); expect.soft(drift(base, done), 'after choices').toEqual([]);
      expect(new Set(attempts.map(a => a.key)).size).toBe(3); expect(attempts.every(a => Boolean(a.key))).toBe(true);
      expect(writes).toEqual(Array.from({ length: 3 }, () => ({ method: 'PATCH', path }))); expect(errors).toEqual([]);
      expect(kept(await f.task(work.id))).toEqual(kept(afterAssignee)); expect((await f.task(work.id)).revision).toBe(work.revision + 3); expect(await f.task(neighbour.id)).toEqual(neighbour);
      await shot(page, info, `picker-final-${name}`);
    } finally { ack.release(); await evidenceJson(info, `asana-pickers-${name}.json`, { viewport, projectId: f.project.id, work, attempts, measured, writes, errors }); if (!page.isClosed()) await page.unroute(`**${path}`); }
  });

  test('title click edits in place and details stay separate; a held then lost title acknowledgement keeps the grid stable, retains input and retries the exact original once', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await dailyFixture(request, baseURL, 'Asana title'); await useColumns(f);
    const work = await f.createTask(`${f.token} title`, { estimateMinutes: 60 }); const other = await f.createTask(`${f.token} other`);
    const path = `${f.prefix}/tasks/${work.id}`, attempts: { key: string | undefined; body: string | null }[] = [];
    const committed = gate(), held = gate(); const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      const actual = await route.fetch(); expect(actual.status()).toBe(200);
      if (attempts.length === 1) { committed.release(); await held.wait; await route.abort('failed'); return; }
      await route.fulfill({ response: actual });
    });
    try {
      await page.goto(f.path); const base = await grid(page);
      const titleBox = inlineForm(page).getByRole('textbox', { name: 'Task name', exact: true });
      // The normal click target is the visible title text itself, not a separate pencil icon.
      const rename = page.getByRole('button', { name: work.title, exact: true }); await expect(rename).toHaveText(work.title);
      await rename.click();
      await expect(inlineForm(page)).toHaveCount(1); await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue(work.title);
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(new URL(page.url()).searchParams.get('task')).toBeNull();
      expect.soft(drift(base, await grid(page)), 'title open').toEqual([]);
      await page.keyboard.press('Escape'); await expect(inlineForm(page)).toHaveCount(0);

      await page.getByRole('button', { name: `Open task “${work.title}”`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: work.title, exact: true }); await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(work.title);
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0); await settleFrame(page); expect(writes).toEqual([]);

      const next = `${f.token} renamed in place`;
      await rename.click(); await expect(titleBox).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(next);
      const typing = await grid(page); measured.push({ stage: 'typing', grid: typing }); expect.soft(drift(base, typing), 'title typing').toEqual([]);
      await page.keyboard.press('ControlOrMeta+Enter'); await committed.wait;
      expect((await f.task(work.id)).title).toBe(next); await expect(titleBox).toHaveValue(next);
      const pending = await grid(page); measured.push({ stage: 'pending', grid: pending }); expect.soft(drift(base, pending), 'title pending').toEqual([]); await shot(page, info, `title-pending-${name}`);
      held.release(); const retry = inlineForm(page).getByRole('button', { name: 'Retry', exact: true }); await expect(retry).toBeVisible(); await expect(titleBox).toHaveValue(next);
      const failed = await grid(page); measured.push({ stage: 'lost acknowledgement', grid: failed, retry: await placement(retry) }); expect.soft(drift(base, failed), 'title lost acknowledgement').toEqual([]);
      expect(await placement(retry)).toMatchObject({ inViewport: true, hit: true }); await shot(page, info, `title-retry-${name}`);
      const retried = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await retry.click(); const saved = await taskResult(await retried, 200);
      await expect(inlineForm(page)).toHaveCount(0); await expect(page.getByRole('button', { name: next, exact: true })).toHaveText(next);
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy();
      expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: work.revision, title: next });
      expect(saved).toMatchObject({ title: next, revision: work.revision + 1 }); expect(kept(saved)).toEqual({ ...kept(work), title: next });
      const after = await grid(page); measured.push({ stage: 'saved', grid: after }); expect.soft(drift(base, after), 'title saved').toEqual([]);
      expect((await projectTasks(f)).map(task => task.id).sort()).toEqual([work.id, other.id].sort()); expect(await f.task(other.id)).toEqual(other);
      expect(writes).toEqual([{ method: 'PATCH', path }, { method: 'PATCH', path }]); expect(errors).toEqual([]);
    } finally { held.release(); await evidenceJson(info, `asana-title-${name}.json`, { viewport, projectId: f.project.id, work, attempts, measured, writes, errors }); if (!page.isClosed()) await page.unroute(`**${path}`); }
  });

  test('fast entry: one click on the add row, then type/Enter three tasks without reclicking; blank Enter creates nothing and keeps focus; each saved once in its section', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await dailyFixture(request, baseURL, 'Asana fast entry'); await useColumns(f);
    const posts: { key: string | undefined; body: Record<string, unknown> }[] = []; const { writes, errors } = recordWrites(page);
    page.on('request', q => { if (q.method() === 'POST' && new URL(q.url()).pathname === `${f.prefix}/tasks`) posts.push({ key: q.headers()['idempotency-key'], body: JSON.parse(q.postData() ?? '{}') as Record<string, unknown> }); });
    const titles = [1, 2, 3].map(n => `${f.token} fast ${n}`), created: TaskDto[] = [];
    await page.goto(f.path); await page.getByRole('button', { name: 'Add task to “QA section”', exact: true }).click();
    const titleBox = quickForm(page).getByRole('textbox', { name: 'Task name', exact: true });
    for (const title of titles) {
      await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue('');
      const response = page.waitForResponse(r => apiCall(r, 'POST', `${f.prefix}/tasks`)); await page.keyboard.type(title); await page.keyboard.press('Enter');
      created.push(await taskResult(await response, 201)); await expect(taskTable(page).getByRole('row').filter({ hasText: title })).toHaveCount(1);
    }
    await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue('');
    await page.keyboard.press('Enter'); await settleFrame(page); await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue('');
    await page.keyboard.type('   '); await page.keyboard.press('Enter'); await settleFrame(page); await expect(titleBox).toBeFocused();
    expect(posts).toHaveLength(3); expect(new Set(posts.map(p => p.key)).size).toBe(3);
    posts.forEach((post, i) => expect(post.body).toMatchObject({ projectId: f.project.id, sectionId: f.section.id, title: titles[i] }));
    expect(created.map(task => ({ title: task.title, sectionId: task.sectionId, parentTaskId: task.parentTaskId }))).toEqual(titles.map(title => ({ title, sectionId: f.section.id, parentTaskId: null })));
    const stored = await projectTasks(f); expect(stored.map(task => task.title).sort()).toEqual([...titles].sort()); expect(stored.every(task => task.sectionId === f.section.id)).toBe(true);
    await expect(page.getByRole('dialog')).toHaveCount(0); expect(new URL(page.url()).searchParams.get('task')).toBeNull();
    expect(writes.filter(w => !(w.method === 'POST' && w.path === `${f.prefix}/tasks`))).toEqual([]); expect(errors).toEqual([]);
    const order = await taskTable(page).getByRole('row').evaluateAll((rows, wanted) => rows.map(row => wanted.find(title => row.textContent?.includes(title)) ?? null).filter(Boolean), titles);
    await shot(page, info, `fast-entry-${name}`); await evidenceJson(info, `asana-fast-entry-${name}.json`, { viewport, projectId: f.project.id, sectionId: f.section.id, posts, created, stored: stored.map(task => ({ id: task.id, title: task.title, sectionId: task.sectionId })), renderedOrder: order, blankEnterPosts: 0 });
  });

  test('journey: dirty title then an adjacent status click saves the title once on blur, opens the status picker after its held acknowledgement and stores the explicit status separately', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await dailyFixture(request, baseURL, 'Asana title to status'); await useColumns(f);
    const work = await f.createTask(`${f.token} journey`, { priority: 'medium', dueDate: '2027-06-01', estimateMinutes: 90 }); const neighbour = await f.createTask(`${f.token} journey neighbour`);
    const path = `${f.prefix}/tasks/${work.id}`, attempts: { key: string | undefined; body: Record<string, unknown> }[] = [];
    const committed = gate(), ack = gate(); const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      attempts.push({ key: route.request().headers()['idempotency-key'], body: JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown> });
      const actual = await route.fetch();
      if (attempts.length === 1) { committed.release(); await ack.wait; }
      await route.fulfill({ response: actual });
    });
    const next = `${f.token} journey renamed`, foreignDraft = 'This task has other unsaved changes. Resume its full draft to review them.';
    try {
      await page.goto(f.path); const base = await grid(page);
      const titleBox = inlineForm(page).getByRole('textbox', { name: 'Task name', exact: true });
      await page.getByRole('button', { name: work.title, exact: true }).click(); await expect(titleBox).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(next); expect(attempts).toEqual([]);
      // No Enter: clicking the adjacent cell of the same task is the only commit signal for the dirty title.
      const titleResponse = page.waitForResponse(r => apiCall(r, 'PATCH', path));
      await page.getByRole('button', { name: `Edit status for ${work.title}`, exact: true }).click();
      await expect.poll(() => attempts.length, { message: 'the blurred dirty title is saved', timeout: 10_000 }).toBe(1); await committed.wait;
      expect(attempts[0]?.body).toEqual({ expectedRevision: work.revision, title: next }); expect((await f.task(work.id)).title).toBe(next);
      // Acknowledgement held: the next picker is only intended, the title is neither abandoned nor a foreign draft, and nothing else is sent.
      await expect(picker(page)).toHaveCount(0); await expect(page.getByText(foreignDraft, { exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Resume draft', exact: true })).toHaveCount(0);
      const held = await grid(page); measured.push({ stage: 'title acknowledgement held', grid: held }); expect.soft(drift(base, held), 'title acknowledgement held').toEqual([]);
      await settleFrame(page); expect(attempts).toHaveLength(1); await shot(page, info, `journey-title-held-${name}`);
      ack.release(); const renamed = await taskResult(await titleResponse, 200); expect(kept(renamed)).toEqual({ ...kept(work), title: next });
      const usable = await expectUsablePicker(page); measured.push({ stage: 'status picker after acknowledgement', grid: await grid(page), picker: usable });
      await arrowTo(page, picker(page).getByRole('option', { name: f.progress.name, exact: true })); expect(attempts).toHaveLength(1); await shot(page, info, `journey-status-picker-${name}`);
      const statusSaved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await page.keyboard.press('Enter'); const afterStatus = await taskResult(await statusSaved, 200);
      expect(attempts[1]?.body).toEqual({ expectedRevision: renamed.revision, statusId: f.progress.id }); expect(kept(afterStatus)).toEqual({ ...kept(renamed), statusId: f.progress.id });
      await expect(picker(page)).toHaveCount(0); await expect(page.getByRole('button', { name: `Edit status for ${next}`, exact: true })).toContainText(f.progress.name);
      await expect(page.getByRole('button', { name: next, exact: true })).toHaveText(next);
      await expect(taskTable(page).getByText('Draft', { exact: true })).toHaveCount(0); await expect(page.getByText(foreignDraft, { exact: true })).toHaveCount(0);
      const after = await grid(page); measured.push({ stage: 'both saved', grid: after }); expect.soft(drift(base, after), 'both saved').toEqual([]);
      await settleFrame(page); expect(attempts).toHaveLength(2); expect(new Set(attempts.map(a => a.key)).size).toBe(2);
      expect(writes).toEqual([{ method: 'PATCH', path }, { method: 'PATCH', path }]); expect(errors).toEqual([]);
      const final = await f.task(work.id); expect(kept(final)).toEqual(kept(afterStatus)); expect(final.revision).toBe(work.revision + 2); expect(await f.task(neighbour.id)).toEqual(neighbour);
    } finally { ack.release(); await evidenceJson(info, `asana-journey-title-status-${name}.json`, { viewport, projectId: f.project.id, work, attempts, measured, writes, errors }); if (!page.isClosed()) await page.unroute(`**${path}`); }
  });

  test('journey: fast chain under latency keeps the next title typeable while the first create acknowledgement is held; two explicit Enters create exactly two tasks once each', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await dailyFixture(request, baseURL, 'Asana fast chain'); await useColumns(f); const anchor = await f.createTask(`${f.token} anchor`);
    const createPath = `${f.prefix}/tasks`, posts: { key: string | undefined; body: Record<string, unknown> }[] = [], created: TaskDto[] = [];
    const committed = gate(), ack = gate(); const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    await page.route(`**${createPath}`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push({ key: route.request().headers()['idempotency-key'], body: JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown> });
      const actual = await route.fetch(); expect(actual.status()).toBe(201); created.push(taskResponseSchema.parse(await actual.json()).data);
      if (posts.length === 1) { committed.release(); await ack.wait; }
      await route.fulfill({ response: actual });
    });
    const [first, second] = [`${f.token} chain 1`, `${f.token} chain 2`];
    try {
      await page.goto(f.path); await page.getByRole('button', { name: 'Add task to “QA section”', exact: true }).click();
      const titleBox = quickForm(page).getByRole('textbox', { name: 'Task name', exact: true }); await expect(titleBox).toBeFocused(); const base = await grid(page);
      await page.keyboard.type(first); await page.keyboard.press('Enter');
      await expect.poll(() => posts.length, { message: 'the first explicit Enter is sent', timeout: 10_000 }).toBe(1); await committed.wait;
      // First acknowledgement still held: the person keeps typing at once, without reclicking.
      await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue(''); await expect(titleBox).toBeEditable();
      await page.keyboard.type(second); await expect(titleBox).toHaveValue(second);
      const held = await grid(page); measured.push({ stage: 'first create held, second typed', grid: held }); expect.soft(driftKept(base, held), 'first create held').toEqual([]);
      await shot(page, info, `journey-chain-held-${name}`);
      // A queued explicit Enter may wait for the first outcome; it must never become an implicit retry.
      await page.keyboard.press('Enter'); await settleFrame(page); expect(posts.length).toBeLessThanOrEqual(2); expect(posts[0]?.body).toMatchObject({ title: first });
      ack.release();
      await expect.poll(() => created.length, { message: 'both explicit creates are sent', timeout: 15_000 }).toBe(2);
      for (const title of [first, second]) await expect(taskTable(page).getByRole('row').filter({ hasText: title })).toHaveCount(1);
      await expect(titleBox).toBeFocused(); await expect(titleBox).toHaveValue('');
      await settleFrame(page); expect(posts).toHaveLength(2); expect(new Set(posts.map(p => p.key)).size).toBe(2); expect(posts.every(p => Boolean(p.key))).toBe(true);
      posts.forEach((post, i) => expect(post.body).toMatchObject({ projectId: f.project.id, sectionId: f.section.id, title: [first, second][i] }));
      expect(created.map(task => ({ title: task.title, sectionId: task.sectionId, parentTaskId: task.parentTaskId }))).toEqual([first, second].map(title => ({ title, sectionId: f.section.id, parentTaskId: null })));
      const stored = await projectTasks(f); expect(stored.map(task => task.title).sort()).toEqual([anchor.title, first, second].sort()); expect(stored.every(task => task.sectionId === f.section.id)).toBe(true);
      const after = await grid(page); measured.push({ stage: 'both created', grid: after }); expect.soft(driftKept(base, after), 'both created').toEqual([]);
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(writes.filter(w => !(w.method === 'POST' && w.path === createPath))).toEqual([]); expect(errors).toEqual([]);
      expect(await f.task(anchor.id)).toEqual(anchor); await shot(page, info, `journey-chain-final-${name}`);
    } finally { ack.release(); await evidenceJson(info, `asana-journey-chain-${name}.json`, { viewport, projectId: f.project.id, sectionId: f.section.id, anchorId: anchor.id, posts, created: created.map(task => ({ id: task.id, title: task.title, sectionId: task.sectionId })), measured, writes, errors }); if (!page.isClosed()) await page.unroute(`**${createPath}`); }
  });

  test('custom single-select column: picker keeps the grid stable, Escape writes nothing and Enter stores the explicit stable option ID only', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await dailyFixture(request, baseURL, 'Asana custom enum');
    const field = (await f.post('/fields', { projectId: f.project.id, name: 'QA stage', type: 'single_select', options: [{ name: 'Design', color: '#6366f1' }, { name: 'Review', color: '#0d9488' }, { name: 'Ship', color: '#f59e0b' }] }, taskFieldDefinitionResponseSchema)).data;
    const review = field.options.find(option => option.name === 'Review'); if (!review) throw Error('Stored Review option required.');
    await useColumns(f, field.id); const work = await f.createTask(`${f.token} stage`); const neighbour = await f.createTask(`${f.token} stage neighbour`);
    const valuePath = `${f.prefix}/tasks/${work.id}/field-values/${field.id}`; const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    try {
      await page.goto(f.path); await expect(taskTable(page).getByRole('columnheader', { name: 'QA stage', exact: true })).toBeVisible(); const base = await grid(page);
      const trigger = page.getByRole('combobox', { name: CUSTOM_EDIT_LABEL(field.name, work.title), exact: true });
      await trigger.click(); const geometry = await expectUsablePicker(page); const opened = await grid(page); measured.push({ stage: 'open', grid: opened, picker: geometry });
      expect.soft(drift(base, opened), 'custom open').toEqual([]); await shot(page, info, `custom-enum-open-${name}`);
      await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); await settleFrame(page); expect(writes).toEqual([]);
      await trigger.click(); await expectUsablePicker(page); await arrowTo(page, picker(page).getByRole('option', { name: 'Review', exact: true })); expect(writes).toEqual([]);
      const put = page.waitForResponse(r => apiCall(r, 'PUT', valuePath)); const sent = page.waitForRequest(q => q.method() === 'PUT' && new URL(q.url()).pathname === valuePath);
      await page.keyboard.press('Enter'); const body = (await sent).postDataJSON() as unknown; const response = await put;
      expect(response.status(), await response.text()).toBe(200); const value = taskFieldValueResponseSchema.parse(await response.json()).data;
      expect(body).toEqual({ expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: review.id } });
      expect(value).toMatchObject({ taskId: work.id, fieldId: field.id, value: { type: 'single_select', value: review.id } });
      await expect(picker(page)).toHaveCount(0); await expect(trigger).toContainText('Review');
      const after = await grid(page); measured.push({ stage: 'saved', grid: after }); expect.soft(drift(base, after), 'custom saved').toEqual([]);
      expect(writes).toEqual([{ method: 'PUT', path: valuePath }]); expect(errors).toEqual([]);
      expect(await f.task(work.id)).toEqual(work); expect(await f.task(neighbour.id)).toEqual(neighbour);
    } finally { await evidenceJson(info, `asana-custom-enum-${name}.json`, { viewport, projectId: f.project.id, fieldId: field.id, measured, writes, errors }); }
  });

  test('outside pointer: a real click on the non-focusable project heading dismisses the status and priority pickers without a write and without returning focus to the old cell', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await dailyFixture(request, baseURL, 'Asana outside dismiss'); await useColumns(f);
    const work = await f.createTask(`${f.token} outside`, { priority: 'medium', dueDate: '2027-06-01', estimateMinutes: 90 }); const neighbour = await f.createTask(`${f.token} outside neighbour`);
    const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    try {
      await page.goto(f.path); const heading = page.getByRole('heading', { level: 1, name: f.project.name, exact: true });
      await expect(heading).toBeVisible(); await expect(page.getByRole('button', { name: `Edit status for ${work.title}`, exact: true })).toBeVisible();
      const base = await grid(page); measured.push({ stage: 'base', grid: base, headingTabIndex: await heading.evaluate(el => el.tabIndex) });
      for (const [field, label] of [['status', 'Edit status for'], ['priority', 'Edit priority for']] as const) {
        const trigger = page.getByRole('button', { name: `${label} ${work.title}`, exact: true }); await trigger.click();
        // A highlighted but unchosen option must not be committed by leaving.
        await expectUsablePicker(page); await page.keyboard.press('ArrowDown');
        const opened = await grid(page); measured.push({ stage: `${field} open`, grid: opened }); expect.soft(drift(base, opened), `${field} open`).toEqual([]);
        // An ordinary pointer click with Playwright actionability checks: nothing may cover the heading.
        await heading.click();
        await expect(picker(page)).toHaveCount(0); await expect(inlineForm(page)).toHaveCount(0); await expect(trigger).toBeVisible();
        // Let any deferred focus return run before asserting that none happened.
        await settleFrame(page); await settleFrame(page);
        const owner = await focusOwner(page), closed = await grid(page); measured.push({ stage: `${field} dismissed by heading click`, focus: owner, grid: closed });
        expect(await trigger.evaluate(el => el === document.activeElement)).toBe(false); expect(owner.inTable).toBe(false);
        expect.soft(drift(base, closed), `${field} dismissed`).toEqual([]); await shot(page, info, `outside-dismiss-${field}-${name}`);
        expect(writes).toEqual([]); expect(await f.task(work.id)).toEqual(work);
      }
      await expect(page.getByRole('dialog')).toHaveCount(0); expect(new URL(page.url()).searchParams.get('task')).toBeNull();
      expect(writes).toEqual([]); expect(errors).toEqual([]); expect(await f.task(neighbour.id)).toEqual(neighbour);
    } finally { await evidenceJson(info, `asana-outside-dismiss-${name}.json`, { viewport, projectId: f.project.id, taskIds: [work.id, neighbour.id], measured, writes, errors }); }
  });

  test('custom field unconfirmed: a lost committed value acknowledgement keeps cell recovery hidden under task details, never above the dialog, then the exact original retry stores one revision', async ({ page, request, baseURL }, info) => {
    test.setTimeout(90_000);
    const f = await dailyFixture(request, baseURL, 'Asana custom unconfirmed');
    const field = (await f.post('/fields', { projectId: f.project.id, name: 'QA stage', type: 'single_select', options: [{ name: 'Design', color: '#6366f1' }, { name: 'Review', color: '#0d9488' }, { name: 'Ship', color: '#f59e0b' }] }, taskFieldDefinitionResponseSchema)).data;
    const review = field.options.find(option => option.name === 'Review'); if (!review) throw Error('Stored Review option required.');
    await useColumns(f, field.id); const work = await f.createTask(`${f.token} unconfirmed stage`); const neighbour = await f.createTask(`${f.token} unconfirmed neighbour`);
    const valuePath = `${f.prefix}/tasks/${work.id}/field-values/${field.id}`, attempts: { key: string | undefined; body: string | null }[] = [], served: number[] = [];
    const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    const storedValues = async () => {
      const r = await f.request.get(`${f.prefix}/tasks/${work.id}/field-values`); expect(r.status(), await r.text()).toBe(200);
      return taskFieldValueListResponseSchema.parse(await r.json()).data;
    };
    await page.route(`**${valuePath}`, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postData() });
      // The real server answers every attempt; only the first answer is lost on its way back.
      const actual = await route.fetch(); served.push(actual.status());
      if (attempts.length === 1) { await route.abort('failed'); return; }
      await route.fulfill({ response: actual });
    });
    const retryOriginal = page.getByRole('button', { name: 'Retry original', exact: true });
    const openSubmission = page.getByRole('button', { name: 'Open submission', exact: true });
    try {
      await page.goto(f.path); await expect(taskTable(page).getByRole('columnheader', { name: field.name, exact: true })).toBeVisible(); const base = await grid(page); measured.push({ stage: 'base', grid: base });
      const trigger = page.getByRole('combobox', { name: CUSTOM_EDIT_LABEL(field.name, work.title), exact: true });
      await trigger.click(); await expectUsablePicker(page); const opened = await grid(page); measured.push({ stage: 'open', grid: opened }); expect.soft(drift(base, opened), 'custom open').toEqual([]);
      await arrowTo(page, picker(page).getByRole('option', { name: 'Review', exact: true })); expect(writes).toEqual([]);
      await page.keyboard.press('Enter');
      await expect(retryOriginal).toBeVisible(); expect(attempts).toHaveLength(1); expect(served).toEqual([200]);
      // Committed on the server although the browser never saw the answer.
      expect(await storedValues()).toEqual([expect.objectContaining({ fieldId: field.id, revision: 1, value: { type: 'single_select', value: review.id } })]);
      await expect(trigger).toContainText('Review'); await expect(trigger).toBeDisabled(); await expect(openSubmission).toBeVisible();
      const cellRetry = await placement(retryOriginal); expect(cellRetry).toMatchObject({ inViewport: true, hit: true });
      // The details route of this same feedback popover, next to its Retry original.
      const reviewInDetails = page.locator('[data-cell-popover]').filter({ has: retryOriginal }).getByRole('button', { name: 'Review in details', exact: true });
      await expect(reviewInDetails).toBeVisible(); const cellReview = await placement(reviewInDetails); expect(cellReview).toMatchObject({ inViewport: true, hit: true });
      // The unconfirmed state intentionally adds the page-level "Open submission" notice; only this stage skips the origin oracle.
      const failed = await grid(page); measured.push({ stage: 'unconfirmed', grid: failed, retry: cellRetry, review: cellReview }); expect.soft(drift(base, failed, { origin: false }), 'custom unconfirmed').toEqual([]);
      await shot(page, info, `custom-unconfirmed-cell-${name}`);

      await reviewInDetails.click(); expect(attempts).toHaveLength(1);
      const drawer = page.getByRole('dialog', { name: work.title, exact: true }); await expect(drawer).toBeVisible();
      await expect(drawer.getByText(`The value of “${field.name}” is unconfirmed. Other field values wait until its result is known.`, { exact: true })).toBeVisible();
      await expect(retryOriginal).toBeHidden(); expect(await popoversOutsideDialogs(page)).toEqual([]);
      const drawerClose = drawer.getByRole('button', { name: 'Close', exact: true }).first(), openValue = drawer.getByRole('button', { name: `Open “${field.name}”`, exact: true });
      const closeHit = await placement(drawerClose); await openValue.scrollIntoViewIfNeeded(); const openHit = await placement(openValue);
      measured.push({ stage: 'task details over unconfirmed cell', close: closeHit, openValue: openHit, popovers: await popoversOutsideDialogs(page) });
      expect(closeHit).toMatchObject({ inViewport: true, hit: true }); expect(openHit).toMatchObject({ inViewport: true, hit: true }); await shot(page, info, `custom-unconfirmed-details-${name}`);

      await openValue.click();
      const valueDialog = page.getByRole('dialog', { name: `Value of “${field.name}”`, exact: true }); const retained = valueDialog.getByRole('combobox', { name: field.name, exact: true });
      await expect(retained).toContainText('Review'); await expect(retained).toBeDisabled();
      await expect(valueDialog.getByText('Showing the submitted value. It stays fixed until the server responds.', { exact: true })).toBeVisible();
      await expect(retryOriginal).toBeHidden(); expect(await popoversOutsideDialogs(page)).toEqual([]);
      const resend = valueDialog.getByRole('button', { name: 'Retry submission', exact: true }), valueClose = valueDialog.getByRole('group', { name: 'Value actions', exact: true }).getByRole('button', { name: 'Close', exact: true });
      const valueHits: Record<string, unknown> = {};
      for (const [label, button] of [['retry submission', resend], ['close', valueClose]] as const) {
        await button.scrollIntoViewIfNeeded(); const hit = await placement(button); valueHits[label] = hit; expect(hit, label).toMatchObject({ inViewport: true, hit: true });
      }
      measured.push({ stage: 'value dialog over unconfirmed cell', buttons: valueHits }); await shot(page, info, `custom-unconfirmed-value-${name}`);

      // Close only the dialogs: nothing is resent, and the original cell recovery comes back unchanged.
      await valueClose.click(); await expect(valueDialog).toHaveCount(0); await expect(drawer).toBeVisible();
      await expect(retryOriginal).toBeHidden(); expect(await popoversOutsideDialogs(page)).toEqual([]);
      await drawerClose.click(); await expect(drawer).toHaveCount(0); await settleFrame(page); expect(attempts).toHaveLength(1);
      await expect(retryOriginal).toBeVisible(); await expect(openSubmission).toBeVisible(); await expect(trigger).toContainText('Review');
      const restored = await placement(retryOriginal); measured.push({ stage: 'dialogs closed, cell recovery restored', retry: restored }); expect(restored).toMatchObject({ inViewport: true, hit: true });

      const resent = page.waitForResponse(r => apiCall(r, 'PUT', valuePath)); await retryOriginal.click(); const response = await resent;
      expect(response.status(), await response.text()).toBe(200); const value = taskFieldValueResponseSchema.parse(await response.json()).data;
      await expect(retryOriginal).toHaveCount(0); await expect(openSubmission).toHaveCount(0); await expect(trigger).toBeEnabled(); await expect(trigger).toContainText('Review');
      await settleFrame(page); expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(attempts[0]?.key).toBeTruthy(); expect(served).toEqual([200, 200]);
      expect(JSON.parse(attempts[0]?.body ?? '{}')).toEqual({ expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'single_select', value: review.id } });
      expect(value).toMatchObject({ taskId: work.id, fieldId: field.id, revision: 1, value: { type: 'single_select', value: review.id } });
      expect(await storedValues()).toEqual([value]);
      const after = await grid(page); measured.push({ stage: 'retried and confirmed', grid: after }); expect.soft(drift(base, after), 'custom confirmed').toEqual([]);
      expect(writes).toEqual([{ method: 'PUT', path: valuePath }, { method: 'PUT', path: valuePath }]); expect(errors).toEqual([]);
      expect(await f.task(work.id)).toEqual(work); expect(await f.task(neighbour.id)).toEqual(neighbour);
    } finally { await evidenceJson(info, `asana-custom-unconfirmed-${name}.json`, { viewport, projectId: f.project.id, fieldId: field.id, attempts, served, measured, writes, errors }); if (!page.isClosed()) await page.unroute(`**${valuePath}`); }
  });

  test('picker search accepts a native Search click then uninterrupted typing without stealing focus or writing', async ({ page, request, baseURL }, info) => {
    const f = await dailyFixture(request, baseURL, 'Asana search focus'); await useColumns(f);
    const work = await f.createTask(`${f.token} search focus`); const { writes, errors } = recordWrites(page);
    await page.goto(f.path); const base = await grid(page);
    const trigger = page.getByRole('button', { name: `Edit assignee for ${work.title}`, exact: true });
    await trigger.click(); await expectUsablePicker(page);
    const search = page.getByRole('combobox', { name: 'Search: Assignee', exact: true });
    expect(await placement(search)).toMatchObject({ inViewport: true, hit: true, inTable: false });
    await search.click(); await expect(search).toBeFocused();
    const query = f.other.displayName;
    await page.keyboard.type(query.slice(0, 2)); await expect(search).toHaveValue(query.slice(0, 2)); await expect(search).toBeFocused();
    await settleFrame(page); await page.keyboard.type(query.slice(2));
    await expect(search).toHaveValue(query); await expect(search).toBeFocused();
    await expect(picker(page).getByRole('option', { name: query, exact: true })).toBeVisible();
    await expect(picker(page).getByRole('option', { name: f.own.displayName, exact: true })).toHaveCount(0);
    expect(drift(base, await grid(page))).toEqual([]); expect(writes).toEqual([]); expect(await f.task(work.id)).toEqual(work);
    await shot(page, info, `picker-search-native-focus-${name}`);
    await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); await expect(trigger).toBeFocused();
    await settleFrame(page); expect(writes).toEqual([]); expect(errors).toEqual([]);
    await evidenceJson(info, `asana-search-native-focus-${name}.json`, { viewport, projectId: f.project.id, taskId: work.id, query, writes, errors });
  });

  test('drawer assignee picker stays inside its modal, searches and closes alone on Escape, then explicit form Save persists only that assignee', async ({ page, request, baseURL }, info) => {
    const f = await dailyFixture(request, baseURL, 'Asana modal picker'); await useColumns(f);
    const work = await f.createTask(`${f.token} modal picker`, { description: 'Keep this exact description', priority: 'high', dueDate: '2027-06-01', estimateMinutes: 90 });
    const neighbour = await f.createTask(`${f.token} modal neighbour`);
    const path = `${f.prefix}/tasks/${work.id}`; const { writes, errors } = recordWrites(page);
    const attempts: { key: string | undefined; body: unknown }[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() === 'PATCH') attempts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
      await route.continue();
    });
    try {
      await page.goto(f.path);
      const title = page.getByRole('button', { name: work.title, exact: true }); await title.hover();
      await page.getByRole('button', { name: `Open task “${work.title}”`, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: work.title, exact: true });
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(work.title);
      const assignee = drawer.getByRole('combobox', { name: 'Assignee', exact: true }); await assignee.click();
      await expect(picker(page)).toBeVisible();
      expect(await picker(page).evaluate(el => el.closest('[role="dialog"]')?.getAttribute('aria-labelledby') !== null && el.closest('[role="dialog"]') !== null)).toBe(true);
      const firstGeometry = await pickerGeometry(picker(page)); expect(firstGeometry.inViewport).toBe(true);
      expect(firstGeometry.options.filter(option => option.shown).every(option => option.hit)).toBe(true);
      const search = drawer.getByRole('combobox', { name: 'Search: Assignee', exact: true });
      expect(await placement(search)).toMatchObject({ inViewport: true, hit: true, inTable: false });
      await search.click(); await page.keyboard.type(f.other.displayName); await expect(search).toHaveValue(f.other.displayName); await expect(search).toBeFocused();
      await expect(picker(page).getByRole('option', { name: f.other.displayName, exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(picker(page)).toHaveCount(0); await expect(drawer).toBeVisible(); await expect(assignee).toBeFocused();
      await settleFrame(page); expect(writes).toEqual([]); expect(await f.task(work.id)).toEqual(work);
      await assignee.click(); await drawer.getByRole('combobox', { name: 'Search: Assignee', exact: true }).click(); await page.keyboard.type(f.other.displayName);
      const target = picker(page).getByRole('option', { name: f.other.displayName, exact: true });
      expect(await placement(target)).toMatchObject({ inViewport: true, hit: true, inTable: false }); await target.click();
      await expect(picker(page)).toHaveCount(0); await expect(assignee).toContainText(f.other.displayName); await settleFrame(page);
      expect(writes).toEqual([]); expect(await f.task(work.id)).toEqual(work);
      await shot(page, info, `drawer-assignee-draft-${name}`);
      const saved = page.waitForResponse(response => apiCall(response, 'PATCH', path));
      await drawer.getByRole('button', { name: 'Save', exact: true }).click(); const after = await taskResult(await saved, 200);
      expect(attempts).toHaveLength(1); expect(attempts[0]?.key).toBeTruthy();
      expect(attempts[0]?.body).toEqual({ expectedRevision: work.revision, responsibleMembershipId: f.other.id });
      expect(kept(after)).toEqual({ ...kept(work), responsibleMembershipId: f.other.id });
      expect(after.participants).toEqual(work.participants); expect(after.participantsRevision).toBe(work.participantsRevision); expect(after.workPackageRevision).toBe(work.workPackageRevision);
      expect(kept(await f.task(work.id))).toEqual(kept(after)); expect(after.revision).toBe(work.revision + 1); expect(await f.task(neighbour.id)).toEqual(neighbour);
      expect(writes).toEqual([{ method: 'PATCH', path }]); expect(errors).toEqual([]);
    } finally {
      await evidenceJson(info, `asana-modal-assignee-${name}.json`, { viewport, projectId: f.project.id, taskId: work.id, attempts, writes, errors });
      if (!page.isClosed()) await page.unroute(`**${path}`);
    }
  });


  test('journey: plain title Enter opens the next blank immediately and queues its explicit create behind the held title acknowledgement without wiping newer input or stealing focus', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await dailyFixture(request, baseURL, 'Asana rename to create'); await useColumns(f);
    const work = await f.createTask(`${f.token} original title`, { description: 'Keep existing description', estimateMinutes: 60 });
    const path = `${f.prefix}/tasks/${work.id}`, createPath = `${f.prefix}/tasks`;
    const patches: { key: string | undefined; body: unknown }[] = [], posts: { key: string | undefined; body: Record<string, unknown> }[] = [];
    const committed = gate(), ack = gate(); const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      patches.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
      const actual = await route.fetch(); expect(actual.status()).toBe(200); committed.release(); await ack.wait;
      await route.fulfill({ response: actual });
    });
    await page.route(`**${createPath}`, async route => {
      if (route.request().method() === 'POST') posts.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() as Record<string, unknown> });
      await route.continue();
    });
    const renamed = `${f.token} renamed existing`, nextTitle = `${f.token} queued new task`, newerBuffer = `${f.token} unsent newer buffer`;
    const row = () => taskTable(page).locator(`[data-task-row="${work.id}"]`);
    try {
      await page.goto(f.path); const base = await grid(page); const rowHeight = (await row().boundingBox())?.height;
      expect(rowHeight).toBeGreaterThan(0);
      await page.getByRole('button', { name: work.title, exact: true }).click();
      const titleBox = inlineForm(page).getByRole('textbox', { name: 'Task name', exact: true }); await expect(titleBox).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(renamed);
      const titleSaved = page.waitForResponse(response => apiCall(response, 'PATCH', path)); await page.keyboard.press('Enter');
      const quickTitle = quickForm(page).getByRole('textbox', { name: 'Task name', exact: true });
      await expect(quickTitle).toBeVisible(); await expect(quickTitle).toBeFocused(); await expect(quickTitle).toHaveValue(''); await expect(quickTitle).toBeEditable();
      await committed.wait; expect(patches).toHaveLength(1); expect(posts).toEqual([]);
      expect(kept(await f.task(work.id))).toEqual({ ...kept(work), title: renamed });
      // The original task is committed on the server, while the browser still has no UPDATE ACK.
      await page.keyboard.type(nextTitle); await expect(quickTitle).toHaveValue(nextTitle); await page.keyboard.press('Enter');
      await expect(quickTitle).toHaveValue(''); await expect(quickTitle).toBeFocused(); await expect(quickTitle).toBeEditable();
      await page.keyboard.type(newerBuffer); await expect(quickTitle).toHaveValue(newerBuffer);
      await settleFrame(page); expect(posts).toEqual([]); expect(patches).toHaveLength(1);
      expect(writes).toEqual([{ method: 'PATCH', path }]);
      const pending = await grid(page); measured.push({ stage: 'update ACK held, next create queued, newer buffer typed', grid: pending });
      const pendingDrift: string[] = []; frameDrift(base, pending, pendingDrift); expect(pendingDrift).toEqual([]); expect((await row().boundingBox())?.height).toBe(rowHeight);
      await shot(page, info, `rename-next-queued-${name}`);
      const search = page.getByLabel('Search tasks', { exact: true }); await search.click(); await expect(search).toBeFocused();
      const createSaved = page.waitForResponse(response => apiCall(response, 'POST', createPath)); ack.release();
      const afterRename = await taskResult(await titleSaved, 200), created = await taskResult(await createSaved, 201);
      await expect(page.getByRole('button', { name: renamed, exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: nextTitle, exact: true })).toBeVisible();
      await expect(quickTitle).toHaveValue(newerBuffer); await expect(search).toBeFocused();
      await settleFrame(page); expect(patches).toHaveLength(1); expect(posts).toHaveLength(1);
      expect(patches[0]?.body).toEqual({ expectedRevision: work.revision, title: renamed });
      expect(posts[0]?.body).toMatchObject({ projectId: f.project.id, sectionId: f.section.id, title: nextTitle });
      expect(patches[0]?.key).toBeTruthy(); expect(posts[0]?.key).toBeTruthy(); expect(posts[0]?.key).not.toBe(patches[0]?.key);
      expect(kept(afterRename)).toEqual({ ...kept(work), title: renamed }); expect(afterRename.revision).toBe(work.revision + 1);
      expect(created).toMatchObject({ title: nextTitle, projectId: f.project.id, sectionId: f.section.id, parentTaskId: null });
      const stored = await projectTasks(f); expect(stored.map(task => task.title).sort()).toEqual([renamed, nextTitle].sort());
      expect(stored.every(task => task.sectionId === f.section.id)).toBe(true); expect(await f.task(work.id)).toEqual(afterRename); expect(await f.task(created.id)).toEqual(created);
      const after = await grid(page); measured.push({ stage: 'rename and queued create confirmed, newer buffer kept', grid: after });
      const finalDrift: string[] = []; frameDrift(base, after, finalDrift); expect(finalDrift).toEqual([]); expect((await row().boundingBox())?.height).toBe(rowHeight);
      expect(writes).toEqual([{ method: 'PATCH', path }, { method: 'POST', path: createPath }]); expect(errors).toEqual([]);
      await shot(page, info, `rename-next-confirmed-${name}`);
    } finally {
      ack.release(); await evidenceJson(info, `asana-rename-next-create-${name}.json`, { viewport, projectId: f.project.id, work, renamed, nextTitle, newerBuffer, patches, posts, measured, writes, errors });
      if (!page.isClosed()) { await page.unroute(`**${path}`); await page.unroute(`**${createPath}`); }
    }
  });

  test('journey: a same-task status click after the confirmed title acknowledgement but before the refreshed list head waits for that head, then saves the explicit status once against the confirmed revision', async ({ page, request, baseURL }, info) => {
    test.setTimeout(60_000);
    const f = await dailyFixture(request, baseURL, 'Asana stale head'); await useColumns(f);
    const work = await f.createTask(`${f.token} stale head`, { description: 'Keep this exact description', priority: 'high', dueDate: '2027-06-01', estimateMinutes: 90 });
    const neighbour = await f.createTask(`${f.token} stale head neighbour`);
    const path = `${f.prefix}/tasks/${work.id}`, listPath = `${f.prefix}/tasks`;
    const patches: { key: string | undefined; body: unknown }[] = [], heldLists: string[] = [];
    const listHeld = gate(), listGate = gate(); let armed = false;
    const { writes, errors } = recordWrites(page); const measured: Record<string, unknown>[] = [];
    page.on('request', q => { if (q.method() === 'PATCH' && new URL(q.url()).pathname === path) patches.push({ key: q.headers()['idempotency-key'], body: q.postDataJSON() }); });
    // Only this project's task-list reads, and only after the initial load: the real answer is fetched, then its delivery waits.
    const isProjectList = (url: URL) => url.pathname === listPath && url.searchParams.get('projectId') === f.project.id;
    const holdList = async (route: Route) => {
      if (!armed || route.request().method() !== 'GET') return route.continue();
      const actual = await route.fetch(); expect(actual.status()).toBe(200);
      heldLists.push(route.request().url()); listHeld.release(); await listGate.wait;
      await route.fulfill({ response: actual });
    };
    await page.route(isProjectList, holdList);
    const renamed = `${f.token} stale head renamed`, row = () => taskTable(page).locator(`[data-task-row="${work.id}"]`);
    try {
      await page.goto(f.path); const status = row().getByRole('button', { name: /^Edit status for / });
      await expect(status).toBeVisible(); const base = await grid(page); measured.push({ stage: 'base', grid: base });
      await page.getByRole('button', { name: work.title, exact: true }).click();
      const titleBox = inlineForm(page).getByRole('textbox', { name: 'Task name', exact: true }); await expect(titleBox).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(renamed);
      armed = true;
      const titleSaved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await page.keyboard.press('ControlOrMeta+Enter');
      const confirmed = await taskResult(await titleSaved, 200);
      expect(confirmed.revision).toBe(work.revision + 1); expect(kept(confirmed)).toEqual({ ...kept(work), title: renamed });
      // The acknowledgement has been delivered and its list refresh has started; that refresh is now held.
      await listHeld.wait; expect(patches).toHaveLength(1); expect(await f.task(work.id)).toEqual(confirmed);
      await expect(inlineForm(page)).toHaveCount(0);
      const shownBefore = await row().evaluate(el => (el.textContent ?? '').trim().slice(0, 160));
      // The ordinary click on the same task's status cell while the loaded row still predates the confirmation.
      await status.click(); await settleFrame(page); await settleFrame(page);
      const waiting = await grid(page); measured.push({ stage: 'status clicked while refreshed list held', grid: waiting, shownBefore, heldLists: heldLists.length, inlineForms: await inlineForm(page).count() });
      expect(await picker(page).count(), 'no status picker from the pre-confirmation row').toBe(0); expect(patches).toHaveLength(1);
      expect.soft(drift(base, waiting), 'status click while list held').toEqual([]); await shot(page, info, `stale-head-held-${name}`);

      listGate.release();
      await expect(page.getByRole('form', { name: `Edit ${renamed} in the task table`, exact: true })).toBeVisible();
      const usable = await expectUsablePicker(page); await expect(row().getByRole('button', { name: renamed, exact: true })).toHaveText(renamed);
      measured.push({ stage: 'status picker after refreshed head', grid: await grid(page), picker: usable }); expect(patches).toHaveLength(1);
      await arrowTo(page, picker(page).getByRole('option', { name: f.progress.name, exact: true })); expect(patches).toHaveLength(1);
      const statusSaved = page.waitForResponse(r => apiCall(r, 'PATCH', path)); await page.keyboard.press('Enter'); const afterStatus = await taskResult(await statusSaved, 200);
      expect(patches[1]?.body).toEqual({ expectedRevision: confirmed.revision, statusId: f.progress.id });
      expect(patches[0]?.body).toEqual({ expectedRevision: work.revision, title: renamed });
      expect(patches.every(p => Boolean(p.key))).toBe(true); expect(new Set(patches.map(p => p.key)).size).toBe(2);
      await expect(picker(page)).toHaveCount(0); await expect(page.getByRole('button', { name: renamed, exact: true })).toHaveText(renamed);
      await expect(page.getByRole('button', { name: `Edit status for ${renamed}`, exact: true })).toContainText(f.progress.name);
      await settleFrame(page); expect(patches).toHaveLength(2);
      const after = await grid(page); measured.push({ stage: 'title and status confirmed', grid: after }); expect.soft(drift(base, after), 'title and status confirmed').toEqual([]);
      const final = await f.task(work.id); expect(final).toEqual(afterStatus);
      expect(kept(final)).toEqual({ ...kept(work), title: renamed, statusId: f.progress.id }); expect(final.revision).toBe(work.revision + 2);
      expect(await f.task(neighbour.id)).toEqual(neighbour);
      expect(writes).toEqual([{ method: 'PATCH', path }, { method: 'PATCH', path }]); expect(errors).toEqual([]);
    } finally {
      listGate.release(); await evidenceJson(info, `asana-stale-head-${name}.json`, { viewport, projectId: f.project.id, work, renamed, patches, heldLists, measured, writes, errors });
      if (!page.isClosed()) await page.unroute(isProjectList, holdList);
    }
  });

});
