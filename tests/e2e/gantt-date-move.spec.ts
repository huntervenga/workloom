// Source-authored native acceptance for the Gantt range-bar DATE MOVE (move only, no resize). Execution and
// results belong to the coordinator's compiled gate (tests/e2e/gantt-date-move.config.ts); nothing is claimed
// from source. All persisted fixtures are new projects in the historical synthetic QA workspace, written only
// through supported APIs; the showcase workspace is never touched and no database content is read.
//
// Agreed integration selectors (product wiring is concurrent; these are assumptions until it lands):
// - `[data-gantt-movable="{taskId}"]` is present only while that bar's move gate is currently enabled; any blocked
//   bar (ineligible row, viewer, retained draft, pending/unknown command) has the attribute absent. The interim
//   internal `data-gantt-move-handle` is deliberately not used here;
// - `data-testid="gantt-date-move-ghost"` is shared by the active pointer ghost AND the staged retained proposal: it
//   persists after a valid drop through review, a closed retained draft and an unknown submission, until the
//   proposal is applied or discarded. Its title is `Proposed, not applied: {start} — {due}`;
// - the saved bar stays `[data-gantt-anchor="{taskId}"] [role="img"]` named `Current: start …, due …`;
// - a single-date point's saved body is the rotated `role="img"` diamond itself (`…; only due date`), carrying the
//   movable marker; its ghost is a full-width track whose own inner diamond marks the proposed day;
// - each drawn dependency `[data-dependency-id]` holds two paths: the line, then its arrowhead;
// - a nonzero drop opens the existing retained `Edit task dates` dialog and server-previews once; it never applies.
//
// Input honesty: desktop moves use real Playwright mouse input (CDP Input.dispatchMouseEvent). The cancellation
// case uses CDP Input.dispatchTouchEvent under Chrome touch emulation: browser-generated, trusted pointer events,
// but emulated touch, not a physical touch screen. Page scripts only add passive observers; no pointer, key or
// DOM event is ever constructed or dispatched from JavaScript. The two transport faults (a lost apply
// acknowledgement; a held, then lost, title acknowledgement) forward or hold the real committed server answer and
// then abort it; no success is fabricated.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  meResponseSchema, meetingCreationResponseSchema, taskDependencyResponseSchema, taskResponseSchema,
  taskScheduleApplyResponseSchema, taskSchedulePreviewResponseSchema, type TaskDto,
} from '@workloom/contracts';
import { dailyFixture, gate } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { futurePeriod, type Daily } from './support/next-ux.js';

const desktop = { width: 1440, height: 1000 }, mobile = { width: 390, height: 844 };
/** An explicit 28-day window draws 36px days (GanttView dayWidth); the spec still measures the real axis. */
const WINDOW_DAYS = 28, DAY_PX = 36;
const eventual = { timeout: 12_000 };
const path = (url: string) => new URL(url).pathname;
const previewPath = (f: Daily) => `${f.prefix}/projects/${f.project.id}/schedule-preview`;
const applyPath = (f: Daily) => `${f.prefix}/projects/${f.project.id}/schedule-apply`;
const currentLabel = (start: string, due: string) => `Current: start ${start}, due ${due}`;
/** schedule.ganttMoveBar.proposedDates — the ghost's title for both the held and the staged proposal. */
const proposedLabel = (start: string, due: string) => `Proposed, not applied: ${start} — ${due}`;
/** Fields a date move must never touch. */
const conserved = (task: TaskDto) => ({ title: task.title, statusId: task.statusId, sectionId: task.sectionId, parentTaskId: task.parentTaskId,
  estimateMinutes: task.estimateMinutes, workPackageId: task.workPackageId, workPackageRevision: task.workPackageRevision,
  participantsRevision: task.participantsRevision, archivedAt: task.archivedAt });

type Sent = { kind: 'preview' | 'apply'; body: string | null; key: string | null };
/** Browser traffic only: every non-GET, the exact date command bodies/keys, failed API/asset requests, page errors. */
function watch(page: Page, f: Daily) {
  const commands: Sent[] = [], writes: { method: string; path: string }[] = [];
  const failures: string[] = [], planned: string[] = [], cancelled: string[] = [], errors: string[] = [], allowed: string[] = [];
  const relevant = (p: string) => p.startsWith('/api/') || /\.(?:js|css)$/.test(p);
  page.on('request', q => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(q.method())) return;
    const p = path(q.url()); writes.push({ method: q.method(), path: p });
    if (p === previewPath(f) || p === applyPath(f)) commands.push({ kind: p === previewPath(f) ? 'preview' : 'apply', body: q.postData(), key: q.headers()['idempotency-key'] ?? null });
  });
  page.on('requestfailed', q => {
    const p = path(q.url()), text = q.failure()?.errorText ?? '';
    if (allowed.includes(p)) planned.push(`${q.method()} ${p} ${text}`);
    else if (q.method() === 'GET' && text === 'net::ERR_ABORTED') cancelled.push(p); // Query cancellation at pointerdown is expected.
    else if (relevant(p)) failures.push(`${q.method()} ${p} ${text}`);
  });
  page.on('response', r => { const p = path(r.url()); if (r.status() >= 400 && relevant(p)) (allowed.includes(p) ? planned : failures).push(`${r.request().method()} ${p} ${r.status()}`); });
  page.on('pageerror', error => errors.push(error.message));
  return { commands, writes, failures, planned, cancelled, errors, allowed,
    previews: () => commands.filter(c => c.kind === 'preview'), applies: () => commands.filter(c => c.kind === 'apply') };
}
type Net = ReturnType<typeof watch>;
function clean(net: Net) { expect(net.failures, 'failed API or asset requests').toEqual([]); expect(net.errors, 'page errors').toEqual([]); }
/** Two animation frames: React has committed the discrete pointer/key handler's state and run its effects. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function openGantt(page: Page, f: Daily, start: string, query = '') {
  await page.goto(`${f.path}?view=gantt${query}`);
  const timeline = page.getByRole('region', { name: 'Project timeline', exact: true });
  const visibleCalendar = timeline.locator('[aria-label="Loaded task calendar"]');
  await expect(timeline).toBeVisible(); await expect(visibleCalendar).toBeVisible();
  await timeline.getByRole('combobox', { name: 'Days in window', exact: true }).selectOption(String(WINDOW_DAYS));
  await timeline.getByLabel('Window start', { exact: true }).fill(start);
  const days = visibleCalendar.getByRole('list', { name: 'Calendar window days', exact: true }).getByRole('listitem');
  await expect(days).toHaveCount(WINDOW_DAYS); await expect(days.first()).toHaveAttribute('title', start);
  // Read-only DOM snapshots (saved bars, connectors, movable markers) must still reach the mounted background
  // while the review dialog marks it aria-hidden/inert; user-visible controls stay on the default `timeline`.
  const inspectionTimeline = page.getByRole('region', { name: 'Project timeline', exact: true, includeHidden: true });
  const calendar = inspectionTimeline.locator('[aria-label="Loaded task calendar"]');
  return {
    timeline, calendar,
    dialog: page.getByRole('dialog', { name: 'Edit task dates', exact: true }),
    ghost: page.getByTestId('gantt-date-move-ghost'),
    row: (task: TaskDto) => timeline.getByRole('group', { name: `Calendar dates: ${task.title}`, exact: true }),
    bar: (task: TaskDto) => calendar.locator(`[data-gantt-anchor="${task.id}"] [role="img"][aria-label^="Current: "]`),
    movable: (task: TaskDto) => calendar.locator(`[data-gantt-movable="${task.id}"]`),
  };
}
type Ui = Awaited<ReturnType<typeof openGantt>>;

type Day = { date: string; left: number; right: number };
/**
 * Read-only actual axis cells in pixels relative to the calendar scroller's box. Every geometry snapshot below
 * uses the same origin, so a page notice inserted above the calendar cannot fake or hide a change.
 */
async function axis(calendar: Locator): Promise<Day[]> {
  return calendar.evaluate(scroller => {
    const origin = scroller.getBoundingClientRect();
    return [...scroller.querySelectorAll('ol[aria-label="Calendar window days"] > li')].map(li => {
      const r = li.getBoundingClientRect(); return { date: li.getAttribute('title') ?? '', left: r.left - origin.left, right: r.right - origin.left };
    });
  });
}
function dayOf(days: Day[], date: string) { const found = days.find(day => day.date === date); if (!found) throw Error(`Axis day ${date} is missing.`); return found; }
/** Uniform measured pitch of the real axis; the move distance is an exact integer multiple of it. */
function dayPixels(days: Day[]) {
  const pitches = days.slice(1).map((day, index) => day.left - (days[index]?.left ?? NaN));
  const pitch = pitches[0] ?? NaN;
  for (const value of pitches) expect(Math.abs(value - pitch), 'uniform day pitch').toBeLessThanOrEqual(0.01);
  expect(pitch).toBeCloseTo(DAY_PX, 1);
  return pitch;
}
/** Read-only saved-state frame: Current bar labels/boxes and the actual connector line and arrowhead geometry. */
async function savedFrame(calendar: Locator, tasks: TaskDto[], dependencyIds: string[] = []) {
  return calendar.evaluate((scroller, input) => {
    const origin = scroller.getBoundingClientRect();
    const box = (el: Element | null) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top }; };
    return {
      scrollLeft: scroller.scrollLeft,
      bars: input.ids.map(id => { const bar = scroller.querySelector(`[data-gantt-anchor="${id}"] [role="img"][aria-label^="Current: "]`); return { id, label: bar?.getAttribute('aria-label') ?? null, box: box(bar) }; }),
      connectors: input.deps.map(id => {
        const paths = scroller.querySelectorAll(`[data-gantt-connectors] [data-dependency-id="${id}"] > path`);
        return { id, paths: paths.length, line: paths[0]?.getAttribute('d') ?? null, arrow: paths[1]?.getAttribute('d') ?? null };
      }),
    };
  }, { ids: tasks.map(task => task.id), deps: dependencyIds });
}
type GhostFrame = { title: string | null; box: { left: number; right: number; top: number; bottom: number } }[];
/** Read-only snapshot of every ghost (active or staged): exact title and box, relative to the calendar scroller. */
async function ghostFrame(ui: Ui): Promise<GhostFrame> {
  return ui.ghost.evaluateAll(nodes => {
    const origin = document.querySelector('[aria-label="Loaded task calendar"]')?.getBoundingClientRect();
    const x = origin?.left ?? NaN, y = origin?.top ?? NaN;
    return nodes.map(node => { const r = node.getBoundingClientRect(); return { title: node.getAttribute('title'), box: { left: r.left - x, right: r.right - x, top: r.top - y, bottom: r.bottom - y } }; });
  });
}
/** Exactly one ghost whose box spans the real day cells `start`..`due` of the same axis. */
const ghostSpans = (ghosts: GhostFrame, days: Day[], start: string, due: string) => ghosts.length === 1
  && Math.abs((ghosts[0]?.box.left ?? NaN) - dayOf(days, start).left) <= 1.5 && Math.abs((ghosts[0]?.box.right ?? NaN) - dayOf(days, due).right) <= 1.5;
/** Real mouse: hover the centre of a saved bar and press the primary button. */
async function grab(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const box = await target.boundingBox(); if (!box) throw Error('Target has no layout box.');
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  return { x, y };
}
/**
 * A full real mouse drag that must not start a move. The ghost set is snapshotted first and must stay exactly the
 * same while held and after release: zero stays zero, and an already staged (e.g. unknown) proposal keeps its one
 * ghost with the same title and box. No dialog opens and no command or write is sent.
 */
async function refusedDrag(page: Page, ui: Ui, net: Net, target: Locator, pixels: number, label: string) {
  const commands = net.commands.length, writes = net.writes.length;
  const ghostBefore = await ghostFrame(ui);
  const start = await grab(page, target);
  await page.mouse.move(start.x + pixels, start.y, { steps: 12 }); await settle(page);
  const ghostWhileHeld = await ghostFrame(ui);
  await page.mouse.up(); await settle(page);
  expect(ghostWhileHeld, `${label}: no new or moved ghost while held`).toEqual(ghostBefore);
  expect(await ghostFrame(ui), `${label}: ghost set unchanged after release`).toEqual(ghostBefore);
  await expect(ui.dialog).toHaveCount(0);
  expect(net.commands.length, `${label}: no date command`).toBe(commands); expect(net.writes.length, `${label}: no write`).toBe(writes);
  return { label, pixels, ghostBefore, ghostWhileHeld, from: start };
}
async function previewOf(response: Awaited<ReturnType<Page['waitForResponse']>>) {
  expect(response.status(), await response.text()).toBe(200);
  return taskSchedulePreviewResponseSchema.parse(await response.json()).data;
}
const expectedRow = (task: TaskDto, startDate: string, dueDate: string) => ({ taskId: task.id, expectedRevision: task.revision, startDate, dueDate });

test.describe('Gantt date move desktop1440', () => {
  test.use({ viewport: desktop, timezoneId: 'Europe/Berlin' });

  test('real mouse moves a range bar by exactly three measured days across the Berlin DST change; held ghost leaves saved bars/connectors unchanged; drop previews once and only explicit Apply saves', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move apply');
    const a = await f.createTask(`${f.token} moved range`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 120 });
    const b = await f.createTask(`${f.token} successor`, { startDate: '2027-04-05', dueDate: '2027-04-07', estimateMinutes: 60 });
    const dependency = (await f.post('/dependencies', { predecessorTaskId: a.id, successorTaskId: b.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data;
    const aBefore = await f.task(a.id), bBefore = await f.task(b.id);
    const net = watch(page, f), evidence: Record<string, unknown> = { projectId: f.project.id, taskId: a.id, dependencyId: dependency.id, source: { a: aBefore, b: bBefore } };
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-03-27', '2027-03-29'), exact: true })).toBeVisible();
      // GanttConnectors draws the line, then the arrowhead, for each dependency.
      await expect(ui.calendar.locator(`[data-gantt-connectors] [data-dependency-id="${dependency.id}"] > path`)).toHaveCount(2);
      await expect(ui.movable(a)).toHaveCount(1); await expect(ui.ghost).toHaveCount(0);
      const days = await axis(ui.calendar), pitch = dayPixels(days);
      const before = await savedFrame(ui.calendar, [a, b], [dependency.id]);
      // The saved bar is aligned with its real day cells, so the measured pitch is the drag scale.
      const savedBox = before.bars[0]?.box;
      expect(Math.abs((savedBox?.left ?? NaN) - dayOf(days, '2027-03-27').left)).toBeLessThanOrEqual(1.5);
      expect(Math.abs((savedBox?.right ?? NaN) - dayOf(days, '2027-03-29').right)).toBeLessThanOrEqual(1.5);
      expect(before.connectors[0]?.paths).toBe(2); expect(before.connectors[0]?.line).toBeTruthy(); expect(before.connectors[0]?.arrow).toBeTruthy();

      const start = await grab(page, ui.bar(a));
      await page.mouse.move(start.x + 3 * pitch, start.y, { steps: 12 });
      await expect(ui.ghost).toHaveCount(1);
      // The ghost names and draws the snapped proposal 2027-03-30 — 2027-04-01 on the same axis.
      await expect(ui.ghost).toHaveAttribute('title', proposedLabel('2027-03-30', '2027-04-01'));
      await expect.poll(async () => ghostSpans(await ghostFrame(ui), days, '2027-03-30', '2027-04-01'), eventual).toBe(true);
      const held = await savedFrame(ui.calendar, [a, b], [dependency.id]);
      expect(held, 'held ghost cannot change saved bars or connector line/arrowhead').toEqual(before);
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      await expect(ui.dialog).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('gantt-move-held-desktop.png') });
      evidence.held = { pitch, pointer: start, distance: 3 * pitch, ghost: await ghostFrame(ui), saved: held };

      const previewResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === previewPath(f));
      await page.mouse.up();
      const preview = await previewOf(await previewResponse);
      await expect(ui.dialog).toBeVisible();
      const region = ui.dialog.getByRole('region', { name: `Dates: ${a.title}`, exact: true });
      await expect(region.getByLabel('Start date', { exact: true })).toHaveValue('2027-03-30');
      await expect(region.getByLabel('Due date', { exact: true })).toHaveValue('2027-04-01');
      await expect(ui.dialog.getByRole('region', { name: `Dates: ${b.title}`, exact: true })).toHaveCount(0);
      const review = ui.dialog.getByRole('region', { name: 'Task date change preview', exact: true });
      await expect(review).toBeVisible(); await expect(review).toContainText('2027-03-30'); await expect(review).toContainText('2027-04-01');
      expect(net.previews()).toHaveLength(1); expect(net.applies()).toEqual([]);
      expect(JSON.parse(net.previews()[0]?.body ?? 'null')).toEqual({ rows: [expectedRow(aBefore, '2027-03-30', '2027-04-01')] });
      expect(preview.rows).toEqual([{ taskId: a.id, expectedRevision: aBefore.revision, before: { startDate: '2027-03-27', dueDate: '2027-03-29' }, after: { startDate: '2027-03-30', dueDate: '2027-04-01' }, changed: true }]);
      expect(preview.protectedTargets).toEqual([]); expect(preview.recoveryPeriodIds).toEqual([]);
      // Review is not apply: the server source and the saved bar/connector stay original, while the staged
      // retained proposal keeps exactly one ghost with the exact proposed dates on the same day cells.
      expect(await f.task(a.id)).toEqual(aBefore);
      await expect(ui.ghost).toHaveCount(1);
      await expect(ui.ghost).toHaveAttribute('title', proposedLabel('2027-03-30', '2027-04-01'));
      expect(ghostSpans(await ghostFrame(ui), days, '2027-03-30', '2027-04-01'), 'staged ghost on the proposed day cells').toBe(true);
      expect(await savedFrame(ui.calendar, [a, b], [dependency.id])).toEqual(before);
      evidence.review = { ghost: await ghostFrame(ui) };
      await page.screenshot({ path: info.outputPath('gantt-move-review-desktop.png') });

      const applyResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === applyPath(f));
      await ui.dialog.getByRole('button', { name: 'Apply dates', exact: true }).click();
      const applied = await applyResponse; expect(applied.status(), await applied.text()).toBe(200);
      const result = taskScheduleApplyResponseSchema.parse(await applied.json()).data;
      await expect(ui.dialog).toHaveCount(0);
      expect(net.previews()).toHaveLength(1); expect(net.applies()).toHaveLength(1);
      const sent = net.applies()[0];
      expect(sent?.key).toBeTruthy();
      expect(JSON.parse(sent?.body ?? 'null')).toEqual({ rows: [expectedRow(aBefore, '2027-03-30', '2027-04-01')], previewHash: preview.previewHash });
      const aAfter = await f.task(a.id);
      expect(aAfter).toMatchObject({ startDate: '2027-03-30', dueDate: '2027-04-01', revision: aBefore.revision + 1 });
      expect(conserved(aAfter)).toEqual(conserved(aBefore));
      expect(result.tasks.map(t => ({ id: t.id, startDate: t.startDate, dueDate: t.dueDate, revision: t.revision }))).toEqual([{ id: a.id, startDate: '2027-03-30', dueDate: '2027-04-01', revision: aAfter.revision }]);
      expect(await f.task(b.id)).toEqual(bBefore);
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-03-30', '2027-04-01'), exact: true })).toBeVisible(eventual);
      // Applied: the staged proposal is released, so its ghost is gone; the connector still has line + arrowhead.
      await expect(ui.ghost).toHaveCount(0, eventual);
      await expect(ui.calendar.locator(`[data-gantt-connectors] [data-dependency-id="${dependency.id}"] > path`)).toHaveCount(2);
      await expect(ui.movable(a)).toHaveCount(1, eventual);
      expect(net.writes.map(w => w.path)).toEqual([previewPath(f), applyPath(f)]); clean(net);
      await page.screenshot({ path: info.outputPath('gantt-move-saved-desktop.png') });
      Object.assign(evidence, { preview, previewRequest: net.previews()[0], applyRequest: sent, applied: result, after: aAfter, savedAfter: await savedFrame(ui.calendar, [a, b], [dependency.id]) });
    } finally { await evidenceJson(info, 'gantt-move-apply-desktop.json', { ...evidence, net }); }
  });

  test('native Escape mid-drag clears the ghost without dialog or command; subthreshold and zero-day snapped drags are no-ops', async ({ page, request, baseURL }, info) => {
    test.setTimeout(100_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move cancel');
    const a = await f.createTask(`${f.token} cancelled range`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 60 });
    const aBefore = await f.task(a.id);
    const net = watch(page, f), stages: unknown[] = [];
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      await expect(ui.movable(a)).toHaveCount(1);
      const pitch = dayPixels(await axis(ui.calendar)), before = await savedFrame(ui.calendar, [a]);

      // 1. Escape while the primary button is still held.
      const start = await grab(page, ui.bar(a));
      await page.mouse.move(start.x + 3 * pitch, start.y, { steps: 12 });
      await expect(ui.ghost).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(ui.ghost).toHaveCount(0);
      await page.mouse.up(); await settle(page);
      await expect(ui.ghost).toHaveCount(0); await expect(ui.dialog).toHaveCount(0);
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      expect(await savedFrame(ui.calendar, [a])).toEqual(before);
      stages.push({ stage: 'escape', pointer: start, distance: 3 * pitch });

      // 2. Below the 4px activation threshold: a press/release, not a move.
      const small = await grab(page, ui.bar(a));
      await page.mouse.move(small.x + 3, small.y, { steps: 3 }); await settle(page);
      const ghostSubthreshold = await ui.ghost.count();
      await page.mouse.up(); await settle(page);
      expect(ghostSubthreshold).toBe(0); await expect(ui.dialog).toHaveCount(0);

      // 3. Activated but snapped to zero days (0.4 day): no proposal is kept and nothing is sent.
      const zero = await grab(page, ui.bar(a));
      await page.mouse.move(zero.x + 0.4 * pitch, zero.y, { steps: 6 }); await settle(page);
      const ghostZeroDay = await ui.ghost.count(); // Evidence only: a zero-delta ghost may or may not be drawn.
      await page.mouse.up(); await settle(page);
      await expect(ui.ghost).toHaveCount(0); await expect(ui.dialog).toHaveCount(0);
      stages.push({ stage: 'subthreshold', pixels: 3, ghost: ghostSubthreshold }, { stage: 'zero-day', pixels: 0.4 * pitch, ghostWhileHeld: ghostZeroDay });

      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      expect(await savedFrame(ui.calendar, [a])).toEqual(before);
      expect(await f.task(a.id)).toEqual(aBefore); clean(net);
    } finally { await evidenceJson(info, 'gantt-move-cancel-desktop.json', { stages, net }); }
  });

  test('real mouse moves a due-only point by exactly three measured days: its own rotated body takes the pointer, the held diamond ghost leaves the saved point unchanged, drop previews once and only explicit Apply saves due with start still null', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move point');
    const a = await f.createTask(`${f.token} due-only point`, { startDate: null, dueDate: '2027-03-29', estimateMinutes: 90 });
    const aBefore = await f.task(a.id);
    expect(aBefore).toMatchObject({ startDate: null, dueDate: '2027-03-29', estimateMinutes: 90 });
    // ScheduleBar names a single-date point `{Current label}; only due date`, with the missing start as Not set.
    const pointLabel = (due: string) => `${currentLabel('Not set', due)}; only due date`;
    const net = watch(page, f), evidence: Record<string, unknown> = { projectId: f.project.id, taskId: a.id, source: aBefore };
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      const point = ui.movable(a);
      // The movable marker is on the anchored saved point body itself, not on its row label or track.
      await expect(point).toHaveCount(1); await expect(point).toHaveAttribute('role', 'img');
      await expect(point).toHaveAttribute('aria-label', pointLabel('2027-03-29'));
      expect(await point.evaluate((el, id) => el.tagName === 'SPAN' && el.closest('[data-gantt-anchor]')?.getAttribute('data-gantt-anchor') === id, a.id)).toBe(true);
      await expect(ui.bar(a)).toHaveAttribute('aria-label', pointLabel('2027-03-29'));
      await expect(ui.ghost).toHaveCount(0);
      const days = await axis(ui.calendar), pitch = dayPixels(days);
      const centreOf = (date: string) => { const day = dayOf(days, date); return (day.left + day.right) / 2; };
      // Actual rendered diamonds (the CSS rotate is part of the client rect), relative to the calendar scroller.
      const diamond = (target: Locator) => target.evaluate(el => {
        const origin = document.querySelector('[aria-label="Loaded task calendar"]')?.getBoundingClientRect(), r = el.getBoundingClientRect();
        return { x: (r.left + r.right) / 2 - (origin?.left ?? NaN), y: (r.top + r.bottom) / 2 - (origin?.top ?? NaN), width: r.width, height: r.height, rotate: getComputedStyle(el).rotate };
      });
      const before = await savedFrame(ui.calendar, [a]), savedPoint = await diamond(ui.bar(a));
      expect(savedPoint.rotate).toBe('45deg');
      expect(Math.abs(savedPoint.width - 16 * Math.SQRT2), 'rotated 16px square').toBeLessThanOrEqual(1);
      expect(Math.abs(savedPoint.width - savedPoint.height)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(savedPoint.x - centreOf('2027-03-29')), 'saved point centred on its due day').toBeLessThanOrEqual(1.5);
      // Passive capture-phase observer only: which element the browser targets and which one captures the pointer.
      await point.evaluate(el => {
        const log: { type: string; pointerType: string; isTrusted: boolean; point: boolean; tag: string; role: string | null }[] = [];
        (window as unknown as { __ganttPointLog: typeof log }).__ganttPointLog = log;
        for (const type of ['pointerdown', 'gotpointercapture']) {
          window.addEventListener(type, event => {
            const e = event as PointerEvent, target = e.target instanceof Element ? e.target : null;
            log.push({ type: e.type, pointerType: e.pointerType, isTrusted: e.isTrusted, point: target === el, tag: target?.tagName ?? '', role: target?.getAttribute('role') ?? null });
          }, { capture: true, passive: true });
        }
      });
      const pointerLog = () => page.evaluate(() => (window as unknown as { __ganttPointLog: { type: string; pointerType: string; isTrusted: boolean; point: boolean; tag: string; role: string | null }[] }).__ganttPointLog.slice());
      const onPoint = { pointerType: 'mouse', isTrusted: true, point: true, tag: 'SPAN', role: 'img' };

      const start = await grab(page, point);
      await page.mouse.move(start.x + 3 * pitch, start.y, { steps: 12 });
      await expect(ui.ghost).toHaveCount(1);
      await expect(ui.ghost).toHaveAttribute('title', proposedLabel('Not set', '2027-04-01'));
      const ghostDiamond = ui.ghost.locator('span[aria-hidden="true"]');
      await expect(ghostDiamond).toHaveCount(1);
      await expect.poll(async () => Math.abs((await diamond(ghostDiamond)).x - centreOf('2027-04-01')), eventual).toBeLessThanOrEqual(1.5);
      const heldGhost = await diamond(ghostDiamond);
      expect(heldGhost.rotate).toBe('45deg');
      expect(Math.abs(heldGhost.width - savedPoint.width)).toBeLessThanOrEqual(0.5); expect(Math.abs(heldGhost.y - savedPoint.y)).toBeLessThanOrEqual(1.5);
      expect((await pointerLog()).find(e => e.type === 'pointerdown'), 'trusted mouse pointerdown on the point body').toMatchObject(onPoint);
      await expect.poll(async () => (await pointerLog()).find(e => e.type === 'gotpointercapture') ?? null, eventual).toMatchObject(onPoint);
      const held = await savedFrame(ui.calendar, [a]);
      expect(held, 'held ghost cannot change the saved point').toEqual(before);
      expect(await diamond(ui.bar(a))).toEqual(savedPoint);
      await expect(ui.bar(a)).toHaveAttribute('aria-label', pointLabel('2027-03-29'));
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      await expect(ui.dialog).toHaveCount(0);
      expect(await f.task(a.id)).toEqual(aBefore);
      await page.screenshot({ path: info.outputPath('gantt-move-point-held-desktop.png') });
      evidence.held = { pitch, pointer: start, distance: 3 * pitch, savedPoint, ghostDiamond: heldGhost, ghost: await ghostFrame(ui), saved: held, pointerLog: await pointerLog() };

      const previewResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === previewPath(f));
      await page.mouse.up();
      const preview = await previewOf(await previewResponse);
      await expect(ui.dialog).toBeVisible();
      const region = ui.dialog.getByRole('region', { name: `Dates: ${a.title}`, exact: true });
      await expect(region.getByLabel('Start date', { exact: true })).toHaveValue('');
      await expect(region.getByLabel('Due date', { exact: true })).toHaveValue('2027-04-01');
      const review = ui.dialog.getByRole('region', { name: 'Task date change preview', exact: true });
      await expect(review).toBeVisible(); await expect(review).toContainText('2027-04-01');
      expect(net.previews()).toHaveLength(1); expect(net.applies()).toEqual([]);
      // The captured source revision travels with the null start and the shifted due.
      const row = { taskId: a.id, expectedRevision: aBefore.revision, startDate: null, dueDate: '2027-04-01' };
      expect(JSON.parse(net.previews()[0]?.body ?? 'null')).toEqual({ rows: [row] });
      expect(preview.rows).toEqual([{ taskId: a.id, expectedRevision: aBefore.revision, before: { startDate: null, dueDate: '2027-03-29' }, after: { startDate: null, dueDate: '2027-04-01' }, changed: true }]);
      expect(preview.protectedTargets).toEqual([]);
      // Review is not apply: the server source and saved point stay original; the staged diamond ghost stays proposed.
      expect(await f.task(a.id)).toEqual(aBefore);
      await expect(ui.ghost).toHaveCount(1);
      await expect(ui.ghost).toHaveAttribute('title', proposedLabel('Not set', '2027-04-01'));
      expect(Math.abs((await diamond(ghostDiamond)).x - centreOf('2027-04-01')), 'staged diamond on the proposed due day').toBeLessThanOrEqual(1.5);
      expect(await savedFrame(ui.calendar, [a])).toEqual(before);
      await expect(ui.bar(a)).toHaveAttribute('aria-label', pointLabel('2027-03-29'));
      expect(net.writes.map(w => w.path)).toEqual([previewPath(f)]);
      evidence.review = { ghost: await ghostFrame(ui), ghostDiamond: await diamond(ghostDiamond) };
      await page.screenshot({ path: info.outputPath('gantt-move-point-review-desktop.png') });

      const applyResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === applyPath(f));
      await ui.dialog.getByRole('button', { name: 'Apply dates', exact: true }).click();
      const applied = await applyResponse; expect(applied.status(), await applied.text()).toBe(200);
      const result = taskScheduleApplyResponseSchema.parse(await applied.json()).data;
      await expect(ui.dialog).toHaveCount(0);
      expect(net.previews()).toHaveLength(1); expect(net.applies()).toHaveLength(1);
      const sent = net.applies()[0];
      expect(sent?.key).toBeTruthy();
      expect(JSON.parse(sent?.body ?? 'null')).toEqual({ rows: [row], previewHash: preview.previewHash });
      const aAfter = await f.task(a.id);
      expect(aAfter).toMatchObject({ startDate: null, dueDate: '2027-04-01', revision: aBefore.revision + 1, estimateMinutes: 90 });
      expect(conserved(aAfter)).toEqual(conserved(aBefore));
      expect(result.tasks.map(t => ({ id: t.id, startDate: t.startDate, dueDate: t.dueDate, revision: t.revision }))).toEqual([{ id: a.id, startDate: null, dueDate: '2027-04-01', revision: aAfter.revision }]);
      await expect(ui.bar(a)).toHaveAttribute('aria-label', pointLabel('2027-04-01'), eventual);
      await expect(ui.ghost).toHaveCount(0, eventual);
      await expect(ui.movable(a)).toHaveCount(1, eventual);
      await expect.poll(async () => Math.abs((await diamond(ui.bar(a))).x - centreOf('2027-04-01')), eventual).toBeLessThanOrEqual(1.5);
      expect(net.writes.map(w => w.path)).toEqual([previewPath(f), applyPath(f)]); clean(net);
      await page.screenshot({ path: info.outputPath('gantt-move-point-saved-desktop.png') });
      Object.assign(evidence, { preview, previewRequest: net.previews()[0], applyRequest: sent, applied: result, after: aAfter, savedPointAfter: await diamond(ui.bar(a)), savedAfter: await savedFrame(ui.calendar, [a]) });
    } finally { await evidenceJson(info, 'gantt-move-point-desktop.json', { ...evidence, net }); }
  });
});

test.describe('Gantt date move desktop1440 emulated touch', () => {
  // Chrome touch emulation: CDP touch input yields browser-generated trusted pointer events. Not physical touch.
  test.use({ viewport: desktop, timezoneId: 'Europe/Berlin', hasTouch: true });

  test('CDP touchStart/touchMove/touchCancel yields a trusted browser pointercancel that ends the gesture without dialog or command', async ({ page, request, baseURL }, info) => {
    test.setTimeout(100_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move pointercancel');
    const a = await f.createTask(`${f.token} touch range`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 60 });
    const aBefore = await f.task(a.id);
    const net = watch(page, f), evidence: Record<string, unknown> = { input: 'CDP Input.dispatchTouchEvent with Chrome touch emulation; not physical touch' };
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      await expect(ui.movable(a)).toHaveCount(1);
      const pitch = dayPixels(await axis(ui.calendar)), before = await savedFrame(ui.calendar, [a]);
      // Passive capture-phase observer only; it records what the browser dispatches and never dispatches itself.
      await page.evaluate(() => {
        const log: { type: string; pointerType: string; pointerId: number; isTrusted: boolean; movable: string | null }[] = [];
        (window as unknown as { __ganttPointerLog: typeof log }).__ganttPointerLog = log;
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
          window.addEventListener(type, event => {
            const e = event as PointerEvent;
            log.push({ type: e.type, pointerType: e.pointerType, pointerId: e.pointerId, isTrusted: e.isTrusted, movable: e.target instanceof Element ? e.target.closest('[data-gantt-movable]')?.getAttribute('data-gantt-movable') ?? null : null });
          }, { capture: true, passive: true });
        }
      });
      const pointerLog = () => page.evaluate(() => (window as unknown as { __ganttPointerLog: { type: string; pointerType: string; pointerId: number; isTrusted: boolean; movable: string | null }[] }).__ganttPointerLog.slice());
      const box = await ui.bar(a).boundingBox(); if (!box) throw Error('Saved bar has no layout box.');
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (3 * pitch * step) / 6, y, id: 1 }] });
      await settle(page);
      const ghostBeforeCancel = await ui.ghost.count();
      const beforeCancel = await pointerLog();
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      const down = beforeCancel.find(e => e.type === 'pointerdown');
      expect(down, 'browser pointerdown from emulated touch').toMatchObject({ pointerType: 'touch', isTrusted: true, movable: a.id });
      await expect.poll(async () => (await pointerLog()).some(e => e.type === 'pointercancel' && e.isTrusted && e.pointerType === 'touch' && e.pointerId === down?.pointerId), eventual).toBe(true);
      await settle(page);
      await expect(ui.ghost).toHaveCount(0); await expect(ui.dialog).toHaveCount(0);
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      const after = await savedFrame(ui.calendar, [a]);
      expect(after.bars.map(bar => bar.label)).toEqual(before.bars.map(bar => bar.label));
      expect(await f.task(a.id)).toEqual(aBefore); clean(net);
      // Whether the move was active (ghost drawn) before cancel depends on the wrapper's touch-action; if the
      // browser chose to pan, its own pointercancel precedes touchCancel. Both are recorded, neither is assumed.
      const cancelBeforeTouchCancel = beforeCancel.some(e => e.type === 'pointercancel');
      info.annotations.push({ type: 'touch-arbitration', description: `ghostBeforeCancel=${ghostBeforeCancel}; pointercancelBeforeTouchCancel=${cancelBeforeTouchCancel}` });
      Object.assign(evidence, { pitch, ghostBeforeCancel, cancelBeforeTouchCancel, pointerLog: await pointerLog(), before, after });
    } finally { await evidenceJson(info, 'gantt-move-pointercancel-touch-emulated.json', { ...evidence, net }); }
  });
});

test.describe('Gantt date move desktop1440 eligibility', () => {
  test.use({ viewport: desktop, timezoneId: 'Europe/Berlin' });

  test('meeting and archived rows expose no movable wrapper and real drags on them send nothing, while an ordinary row in the same view stays movable', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move eligibility');
    const control = await f.createTask(`${f.token} ordinary control`, { startDate: '2027-05-10', dueDate: '2027-05-12', estimateMinutes: 60 });
    const toArchive = await f.createTask(`${f.token} archived range`, { startDate: '2027-05-05', dueDate: '2027-05-07', estimateMinutes: 60 });
    const archived = (await f.post(`/tasks/${toArchive.id}/archive`, { expectedRevision: toArchive.revision }, taskResponseSchema, 200)).data;
    expect(archived.archivedAt).not.toBeNull();
    const period = await futurePeriod(f);
    const meeting = (await f.post(`/projects/${f.project.id}/meetings`, { title: `${f.token} planning call`, statusId: f.todo.id, sectionId: f.section.id, plannedPeriodId: period.id,
      plannedStartAt: '2027-05-04T10:00:00.000Z', timezone: 'Asia/Nicosia', plannedDurationMinutes: 60, organizerMembershipId: f.own.id, attendeeMembershipIds: [f.own.id] }, meetingCreationResponseSchema)).data;
    const sources = await Promise.all([control, archived, meeting.task].map(task => f.task(task.id)));
    const net = watch(page, f), attempts: unknown[] = [];
    try {
      const ui = await openGantt(page, f, '2027-05-01', '&includeArchived=true');
      await expect(ui.row(archived)).toBeVisible(); await expect(ui.row(meeting.task)).toBeVisible();
      await expect(ui.movable(control)).toHaveCount(1);
      await expect(ui.movable(archived)).toHaveCount(0); await expect(ui.movable(meeting.task)).toHaveCount(0);
      await expect(ui.bar(archived)).toBeVisible();
      await expect(ui.row(meeting.task).getByRole('img', { name: /^Current: / })).toHaveCount(0);
      const days = await axis(ui.calendar), pitch = dayPixels(days);

      attempts.push(await refusedDrag(page, ui, net, ui.bar(archived), 3 * pitch, 'archived bar'));
      // A meeting has no current bar; press its real track at the planned day and drag across it.
      const meetingRow = await ui.row(meeting.task).boundingBox(); if (!meetingRow) throw Error('Meeting row has no layout box.');
      const origin = await ui.calendar.boundingBox(); if (!origin) throw Error('Calendar has no layout box.');
      // Axis cells are calendar-relative; the real mouse needs viewport pixels.
      const day = dayOf(days, '2027-05-04'), dayX = origin.x + (day.left + day.right) / 2;
      await page.mouse.move(dayX, meetingRow.y + meetingRow.height / 2); await page.mouse.down();
      await page.mouse.move(dayX + 3 * pitch, meetingRow.y + meetingRow.height / 2, { steps: 12 }); await settle(page);
      const meetingGhost = await ui.ghost.count();
      await page.mouse.up(); await settle(page);
      expect(meetingGhost).toBe(0); await expect(ui.ghost).toHaveCount(0); await expect(ui.dialog).toHaveCount(0);
      attempts.push({ label: 'meeting track', ghostWhileHeld: meetingGhost });

      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      expect(await Promise.all([control, archived, meeting.task].map(task => f.task(task.id)))).toEqual(sources); clean(net);
      await page.screenshot({ path: info.outputPath('gantt-move-ineligible-desktop.png') });
    } finally { await evidenceJson(info, 'gantt-move-ineligible-desktop.json', { attempts, archivedId: archived.id, meetingTaskId: meeting.task.id, controlId: control.id, net }); }
  });

  test('an actual synthetic viewer session sees saved bars without a movable wrapper or Edit dates, and real drags send nothing', async ({ browser, request, baseURL }, info) => {
    test.setTimeout(100_000);
    if (!baseURL) throw Error('Already-running compiled baseURL required.');
    const f = await dailyFixture(request, baseURL, 'Gantt move viewer');
    const viewer = f.members.find(member => member.role === 'viewer');
    if (!viewer) throw Error('The historical QA workspace fixture viewer membership is required.');
    const a = await f.createTask(`${f.token} viewer range`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 60 });
    const aBefore = await f.task(a.id);
    // Real authorization projection: an HttpOnly development session for the fixture viewer, no mocked role.
    const context = await browser.newContext({ baseURL, viewport: desktop, timezoneId: 'Europe/Berlin' });
    let net: Net | null = null; const attempts: unknown[] = [];
    try {
      const switched = await context.request.post('/api/v1/dev/session', { headers: { origin: f.origin, 'x-workloom-dev-tool': '1' }, data: { actorId: viewer.userId } });
      expect(switched.status(), await switched.text()).toBe(200);
      const me = await context.request.get('/api/v1/me'); expect(me.status()).toBe(200);
      expect(meResponseSchema.parse(await me.json()).data.actor.id).toBe(viewer.userId);
      const page = await context.newPage(); page.setDefaultTimeout(15_000); net = watch(page, f);
      const ui = await openGantt(page, f, '2027-03-25');
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-03-27', '2027-03-29'), exact: true })).toBeVisible();
      await expect(ui.row(a).getByRole('button', { name: 'Edit dates', exact: true })).toHaveCount(0);
      await expect(ui.calendar.locator('[data-gantt-movable]')).toHaveCount(0);
      const pitch = dayPixels(await axis(ui.calendar));
      attempts.push(await refusedDrag(page, ui, net, ui.bar(a), 3 * pitch, 'viewer bar'));
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      expect(await f.task(a.id)).toEqual(aBefore); clean(net);
      await page.screenshot({ path: info.outputPath('gantt-move-viewer-desktop.png') });
    } finally { await evidenceJson(info, 'gantt-move-viewer-desktop.json', { viewerMembershipId: viewer.id, actualDevSession: true, attempts, net }); await context.close(); }
  });
});

test.describe('Gantt date move desktop1440 retained owners', () => {
  test.use({ viewport: desktop, timezoneId: 'Europe/Berlin' });

  test('a retained unsaved manual date draft on a non-first task blocks bar moves on other and same rows; Continue recovers the exact inputs with zero preview/apply', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move draft owner');
    const a = await f.createTask(`${f.token} first row`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 60 });
    const b = await f.createTask(`${f.token} second row`, { startDate: '2027-04-05', dueDate: '2027-04-07', estimateMinutes: 60 });
    const sources = await Promise.all([a, b].map(task => f.task(task.id)));
    const net = watch(page, f), attempts: unknown[] = [];
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      await expect(ui.movable(a)).toHaveCount(1); await expect(ui.movable(b)).toHaveCount(1);
      const pitch = dayPixels(await axis(ui.calendar)), before = await savedFrame(ui.calendar, [a, b]);
      await ui.row(b).getByRole('button', { name: 'Edit dates', exact: true }).click();
      await expect(ui.dialog).toBeVisible();
      const region = ui.dialog.getByRole('region', { name: `Dates: ${b.title}`, exact: true });
      await region.getByLabel('Start date', { exact: true }).fill('2027-04-04');
      await region.getByLabel('Due date', { exact: true }).fill('2027-04-09');
      await ui.dialog.locator('button[aria-label="Close"]').click(); await expect(ui.dialog).toHaveCount(0);
      const resume = page.getByRole('button', { name: 'Continue date draft', exact: true });
      await expect(resume).toBeVisible();
      // The gate is closed for every bar: no movable attribute; a manual draft draws no ghost.
      await expect(ui.calendar.locator('[data-gantt-movable]')).toHaveCount(0); await expect(ui.ghost).toHaveCount(0);

      attempts.push(await refusedDrag(page, ui, net, ui.bar(a), 2 * pitch, 'other row while draft retained'));
      attempts.push(await refusedDrag(page, ui, net, ui.bar(b), -2 * pitch, 'draft row itself'));
      expect(await savedFrame(ui.calendar, [a, b])).toEqual(before);
      await expect(resume).toBeVisible();

      await resume.click(); await expect(ui.dialog).toBeVisible();
      await expect(region.getByLabel('Start date', { exact: true })).toHaveValue('2027-04-04');
      await expect(region.getByLabel('Due date', { exact: true })).toHaveValue('2027-04-09');
      await expect(ui.dialog.getByRole('region', { name: `Dates: ${a.title}`, exact: true })).toHaveCount(0);
      await expect(ui.dialog.getByRole('region', { name: 'Task date change preview', exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('gantt-move-retained-draft-desktop.png') });
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);

      // Explicit discard releases the owner; the ordinary row is movable again (positive control).
      await ui.dialog.getByRole('button', { name: 'Discard date draft', exact: true }).click();
      await expect(ui.dialog).toHaveCount(0); await expect(resume).toHaveCount(0);
      await expect(ui.movable(a)).toHaveCount(1); await expect(ui.movable(b)).toHaveCount(1);
      expect(net.commands).toEqual([]); expect(net.writes).toEqual([]);
      expect(await Promise.all([a, b].map(task => f.task(task.id)))).toEqual(sources); clean(net);
    } finally { await evidenceJson(info, 'gantt-move-retained-draft-desktop.json', { attempts, net }); }
  });

  test('a committed apply with a lost acknowledgement stays unknown, blocks moves, survives a newer real source edit, and the exact body/key replay never overwrites the latest dates', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move lost ack');
    const a = await f.createTask(`${f.token} acknowledged range`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 90 });
    const b = await f.createTask(`${f.token} neighbour range`, { startDate: '2027-04-05', dueDate: '2027-04-07', estimateMinutes: 60 });
    const aBefore = await f.task(a.id), bBefore = await f.task(b.id);
    const net = watch(page, f); net.allowed.push(applyPath(f));
    const attempts: { body: string | null; key: string | null; status: number; data: unknown }[] = [];
    const evidence: Record<string, unknown> = { transportInjected: 'first real 200 apply response forwarded from route.fetch, then aborted', source: aBefore };
    await page.route(`**${applyPath(f)}`, async route => {
      const response = await route.fetch(), text = await response.text();
      attempts.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] ?? null, status: response.status(), data: JSON.parse(text) });
      if (attempts.length === 1) await route.abort('failed'); else await route.fulfill({ response });
    });
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      const days = await axis(ui.calendar), pitch = dayPixels(days);
      const anyMovable = ui.calendar.locator('[data-gantt-movable]');
      const previewResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === previewPath(f));
      const start = await grab(page, ui.bar(a));
      await page.mouse.move(start.x + 3 * pitch, start.y, { steps: 12 }); await expect(ui.ghost).toHaveCount(1);
      await expect(ui.ghost).toHaveAttribute('title', proposedLabel('2027-03-30', '2027-04-01'));
      await page.mouse.up();
      const preview = await previewOf(await previewResponse);
      await expect(ui.dialog.getByRole('region', { name: 'Task date change preview', exact: true })).toBeVisible();
      // The staged proposal keeps its one ghost during review; the retained draft closes the gate for every bar.
      await expect(ui.ghost).toHaveCount(1); await expect(ui.ghost).toHaveAttribute('title', proposedLabel('2027-03-30', '2027-04-01'));
      await expect(anyMovable).toHaveCount(0);
      await ui.dialog.getByRole('button', { name: 'Apply dates', exact: true }).click();
      await expect(ui.dialog.getByRole('button', { name: 'Retry original dates', exact: true })).toBeVisible();
      expect(attempts).toHaveLength(1); expect(attempts[0]?.status).toBe(200);
      const expectedBody = { rows: [expectedRow(aBefore, '2027-03-30', '2027-04-01')], previewHash: preview.previewHash };
      expect(JSON.parse(attempts[0]?.body ?? 'null')).toEqual(expectedBody); expect(attempts[0]?.key).toBeTruthy();
      const committed = await f.task(a.id);
      expect(committed).toMatchObject({ startDate: '2027-03-30', dueDate: '2027-04-01', revision: aBefore.revision + 1 });
      expect(conserved(committed)).toEqual(conserved(aBefore));

      await ui.dialog.locator('button[aria-label="Close"]').click(); await expect(ui.dialog).toHaveCount(0);
      const retry = page.getByRole('button', { name: 'Retry original date submission', exact: true });
      await expect(retry).toBeVisible();
      // Unknown: the original proposal stays staged as exactly one ghost on its day cells, and no bar is movable.
      // The refusal helper snapshots that ghost and requires it unchanged, never forced to zero.
      await expect(ui.ghost).toHaveCount(1); await expect(ui.ghost).toHaveAttribute('title', proposedLabel('2027-03-30', '2027-04-01'));
      expect(ghostSpans(await ghostFrame(ui), days, '2027-03-30', '2027-04-01'), 'unknown staged ghost on the proposed day cells').toBe(true);
      await expect(anyMovable).toHaveCount(0);
      const blocked = [await refusedDrag(page, ui, net, ui.bar(b), 2 * pitch, 'other row while unknown'), await refusedDrag(page, ui, net, ui.bar(a), 2 * pitch, 'unknown row itself')];
      expect(blocked.map(attempt => attempt.ghostBefore.map(ghost => ghost.title))).toEqual([[proposedLabel('2027-03-30', '2027-04-01')], [proposedLabel('2027-03-30', '2027-04-01')]]);
      await page.getByRole('button', { name: 'Open original dates', exact: true }).click();
      const region = ui.dialog.getByRole('region', { name: `Dates: ${a.title}`, exact: true });
      await expect(region.getByLabel('Start date', { exact: true })).toHaveValue('2027-03-30'); await expect(region.getByLabel('Start date', { exact: true })).toBeDisabled();
      await expect(region.getByLabel('Due date', { exact: true })).toHaveValue('2027-04-01'); await expect(region.getByLabel('Due date', { exact: true })).toBeDisabled();
      await page.screenshot({ path: info.outputPath('gantt-move-unknown-desktop.png') });
      await ui.dialog.locator('button[aria-label="Close"]').click(); await expect(ui.dialog).toHaveCount(0);

      // A newer real source on the same task: ordinary PATCH with the current revision and its own key.
      const externalKey = randomUUID(), externalBody = { expectedRevision: committed.revision, startDate: '2027-04-02', dueDate: '2027-04-03' };
      const external = await request.patch(`${f.prefix}/tasks/${a.id}`, { headers: { origin: f.origin, 'idempotency-key': externalKey }, data: externalBody });
      expect(external.status(), await external.text()).toBe(200);
      const latest = taskResponseSchema.parse(await external.json()).data;
      expect(latest).toMatchObject({ startDate: '2027-04-02', dueDate: '2027-04-03', revision: committed.revision + 1 });
      const latestStored = await f.task(a.id); expect(latestStored).toMatchObject({ startDate: '2027-04-02', dueDate: '2027-04-03', revision: latest.revision });

      const replay = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === applyPath(f));
      await retry.click(); expect((await replay).status()).toBe(200);
      await expect(retry).toHaveCount(0);
      // Confirmed: the staged proposal is released and the gate reopens for both bars.
      await expect(ui.ghost).toHaveCount(0, eventual);
      await expect(ui.movable(a)).toHaveCount(1, eventual); await expect(ui.movable(b)).toHaveCount(1);
      expect(attempts).toHaveLength(2); expect(attempts[1]?.status).toBe(200);
      expect(attempts[1]?.body).toBe(attempts[0]?.body); expect(attempts[1]?.key).toBe(attempts[0]?.key);
      expect(taskScheduleApplyResponseSchema.parse(attempts[1]?.data).data).toEqual(taskScheduleApplyResponseSchema.parse(attempts[0]?.data).data);
      // Exact replay returns the stored outcome only; the latest real source is not overwritten.
      expect(await f.task(a.id)).toEqual(latestStored); expect(await f.task(b.id)).toEqual(bBefore);
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-04-02', '2027-04-03'), exact: true })).toBeVisible(eventual);
      expect(net.previews()).toHaveLength(1); expect(net.applies()).toHaveLength(2);
      expect(net.applies()[1]).toEqual(net.applies()[0]);
      expect(net.writes.map(w => w.path)).toEqual([previewPath(f), applyPath(f), applyPath(f)]); clean(net);
      Object.assign(evidence, { preview, attempts, committed, external: { method: 'PATCH', key: externalKey, body: externalBody, result: latest }, blocked, final: await f.task(a.id) });
    } finally { await page.unroute(`**${applyPath(f)}`); await evidenceJson(info, 'gantt-move-lost-ack-desktop.json', { ...evidence, net }); }
  });
});

test.describe('Gantt date move desktop1440 global command owner', () => {
  test.use({ viewport: desktop, timezoneId: 'Europe/Berlin' });

  // The move gate reads the client-wide protectedCommandsFor(client).protecting (title, hours, field values, …),
  // not only schedule owners. One real title owner is the bounded native check of that global scope.
  test('a held, then lost, real title save on a different task closes the move gate: other-bar drags make no ghost or date command; the original drawer replays the exact key/body once and the gate reopens', async ({ page, request, baseURL }, info) => {
    test.setTimeout(150_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move title owner');
    const a = await f.createTask(`${f.token} title owner`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 60 });
    const b = await f.createTask(`${f.token} other bar`, { startDate: '2027-04-05', dueDate: '2027-04-07', estimateMinutes: 60 });
    const aBefore = await f.task(a.id), bBefore = await f.task(b.id);
    const renamed = `${f.token} title owner renamed`, titlePath = `${f.prefix}/tasks/${a.id}`;
    const net = watch(page, f); net.allowed.push(titlePath);
    const attempts: { key: string | null; body: string | null; status: number; data: unknown }[] = [];
    const reached = gate(), held = gate();
    const evidence: Record<string, unknown> = { owner: 'TaskDrawer title PATCH in the global protected command registry; not a date owner',
      transportInjected: 'first real 200 PATCH answer from route.fetch held on a gate, then aborted; the replay answer is forwarded', source: { a: aBefore, b: bBefore } };
    await page.route(`**${titlePath}`, async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const response = await route.fetch(), text = await response.text();
      attempts.push({ key: route.request().headers()['idempotency-key'] ?? null, body: route.request().postData(), status: response.status(), data: JSON.parse(text) });
      if (attempts.length === 1) { reached.release(); await held.wait; await route.abort('failed'); } else await route.fulfill({ response });
    });
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      const anyMovable = ui.calendar.locator('[data-gantt-movable]');
      await expect(ui.movable(a)).toHaveCount(1); await expect(ui.movable(b)).toHaveCount(1);
      const pitch = dayPixels(await axis(ui.calendar)), before = await savedFrame(ui.calendar, [a, b]);
      const pendingNotice = page.getByText('A task command is waiting for the server response. Its original values are kept.', { exact: true });
      const unknownNotice = page.getByText('A task command is unconfirmed. Its original values and key are kept.', { exact: true });
      const resume = page.getByRole('button', { name: 'Resume original editor', exact: true });

      // 1. Pending: a title-only Save from the full-task drawer opened by the calendar row title. The real
      //    request has committed on the server, but its answer is held, so the UI stays pending.
      await ui.row(a).getByRole('button', { name: a.title, exact: true }).click();
      const drawer = page.getByRole('dialog', { name: a.title, exact: true });
      await expect(drawer.getByLabel('Task name', { exact: true })).toHaveValue(a.title);
      await drawer.getByLabel('Task name', { exact: true }).fill(renamed);
      expect(net.writes).toEqual([]);
      await drawer.getByRole('button', { name: 'Save', exact: true }).click();
      await reached.wait;
      await expect(drawer.getByRole('button', { name: 'Saving…', exact: true })).toBeVisible();
      expect(attempts).toHaveLength(1); expect(attempts[0]?.status).toBe(200); expect(attempts[0]?.key).toBeTruthy();
      expect(JSON.parse(attempts[0]?.body ?? 'null')).toEqual({ expectedRevision: aBefore.revision, title: renamed });
      const committed = await f.task(a.id);
      expect(committed).toMatchObject({ title: renamed, revision: aBefore.revision + 1, startDate: aBefore.startDate, dueDate: aBefore.dueDate });
      await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
      await expect(pendingNotice).toBeVisible(); await expect(resume).toBeVisible();
      await expect(anyMovable).toHaveCount(0); await expect(ui.ghost).toHaveCount(0);
      const whilePending = await refusedDrag(page, ui, net, ui.bar(b), 2 * pitch, 'other bar while title pending');
      expect(await savedFrame(ui.calendar, [a, b])).toEqual(before);
      expect(await f.task(b.id)).toEqual(bBefore);
      await page.screenshot({ path: info.outputPath('gantt-move-title-pending-desktop.png') });

      // 2. Unknown: the committed answer is lost in transport. The owner keeps its key; the gate stays closed.
      held.release();
      await expect(unknownNotice).toBeVisible(eventual); await expect(pendingNotice).toHaveCount(0); await expect(resume).toBeVisible();
      expect(attempts).toHaveLength(1);
      await expect(anyMovable).toHaveCount(0); await expect(ui.ghost).toHaveCount(0);
      const whileUnknown = await refusedDrag(page, ui, net, ui.bar(b), -2 * pitch, 'other bar while title unknown');
      expect(await savedFrame(ui.calendar, [a, b])).toEqual(before);
      expect(await f.task(b.id)).toEqual(bBefore); expect(await f.task(a.id)).toEqual(committed);
      await page.screenshot({ path: info.outputPath('gantt-move-title-unknown-desktop.png') });

      // 3. Recovery through the original owner: Resume original editor, then Retry submission of the same key/body.
      await resume.click();
      // The drawer's name may already show either title; it is the dialog holding the kept Task name.
      const original = page.getByRole('dialog').filter({ has: page.getByLabel('Task name', { exact: true }) });
      await expect(original.getByLabel('Task name', { exact: true })).toHaveValue(renamed);
      const replay = page.waitForResponse(r => r.request().method() === 'PATCH' && path(r.url()) === titlePath);
      await original.getByRole('button', { name: 'Retry submission', exact: true }).click();
      expect((await replay).status()).toBe(200);
      await expect(original.getByRole('button', { name: 'Retry submission', exact: true })).toHaveCount(0, eventual);
      await original.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(original).toHaveCount(0);
      await expect(unknownNotice).toHaveCount(0); await expect(resume).toHaveCount(0);
      await expect(ui.movable(a)).toHaveCount(1, eventual); await expect(ui.movable(b)).toHaveCount(1);
      await expect(ui.ghost).toHaveCount(0);

      expect(attempts).toHaveLength(2); expect(attempts[1]?.status).toBe(200);
      expect(attempts[1]?.body).toBe(attempts[0]?.body); expect(attempts[1]?.key).toBe(attempts[0]?.key);
      expect(taskResponseSchema.parse(attempts[1]?.data).data).toEqual(taskResponseSchema.parse(attempts[0]?.data).data);
      // The title revision advanced exactly once; dates never moved; the dragged task is untouched.
      const aAfter = await f.task(a.id);
      expect(aAfter).toEqual(committed);
      expect(aAfter).toMatchObject({ title: renamed, revision: aBefore.revision + 1, startDate: '2027-03-27', dueDate: '2027-03-29' });
      expect(await f.task(b.id)).toEqual(bBefore);
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-03-27', '2027-03-29'), exact: true })).toBeVisible();
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-04-05', '2027-04-07'), exact: true })).toBeVisible();
      expect((await savedFrame(ui.calendar, [a, b])).bars.map(bar => bar.label)).toEqual(before.bars.map(bar => bar.label));
      expect(net.commands).toEqual([]);
      expect(net.writes).toEqual([{ method: 'PATCH', path: titlePath }, { method: 'PATCH', path: titlePath }]); clean(net);
      Object.assign(evidence, { attempts, committed, blocked: [whilePending, whileUnknown], final: aAfter });
    } finally { held.release(); await page.unroute(`**${titlePath}`); await evidenceJson(info, 'gantt-move-title-owner-desktop.json', { ...evidence, net }); }
  });
});

test.describe('Gantt date move mobile390 keyboard fallback', () => {
  test.use({ viewport: mobile, timezoneId: 'Europe/Berlin' });

  test('keyboard Enter on Edit dates, filled endpoints and Preview changes send one preview and no apply; only explicit Apply saves the exact dates', async ({ page, request, baseURL }, info) => {
    test.setTimeout(100_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Gantt move keyboard');
    const a = await f.createTask(`${f.token} keyboard range`, { startDate: '2027-03-27', dueDate: '2027-03-29', estimateMinutes: 60 });
    const aBefore = await f.task(a.id);
    const net = watch(page, f), evidence: Record<string, unknown> = { input: 'keyboard only; no touch or Safari claim' };
    try {
      const ui = await openGantt(page, f, '2027-03-25');
      const edit = ui.row(a).getByRole('button', { name: 'Edit dates', exact: true });
      await edit.focus(); await expect(edit).toBeFocused(); await page.keyboard.press('Enter');
      await expect(ui.dialog).toBeVisible();
      const region = ui.dialog.getByRole('region', { name: `Dates: ${a.title}`, exact: true });
      await region.getByLabel('Start date', { exact: true }).fill('2027-03-29');
      await region.getByLabel('Due date', { exact: true }).fill('2027-04-03');
      expect(net.commands).toEqual([]);
      const previewResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === previewPath(f));
      const previewButton = ui.dialog.getByRole('button', { name: 'Preview changes', exact: true });
      await previewButton.focus(); await page.keyboard.press('Enter');
      const preview = await previewOf(await previewResponse);
      await expect(ui.dialog.getByRole('region', { name: 'Task date change preview', exact: true })).toBeVisible();
      expect(net.previews()).toHaveLength(1); expect(net.applies()).toEqual([]);
      expect(JSON.parse(net.previews()[0]?.body ?? 'null')).toEqual({ rows: [expectedRow(aBefore, '2027-03-29', '2027-04-03')] });
      expect(await f.task(a.id)).toEqual(aBefore);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath('gantt-keyboard-review-mobile.png') });

      const applyResponse = page.waitForResponse(r => r.request().method() === 'POST' && path(r.url()) === applyPath(f));
      const applyButton = ui.dialog.getByRole('button', { name: 'Apply dates', exact: true });
      await applyButton.focus(); await page.keyboard.press('Enter');
      const applied = await applyResponse; expect(applied.status(), await applied.text()).toBe(200);
      await expect(ui.dialog).toHaveCount(0);
      expect(JSON.parse(net.applies()[0]?.body ?? 'null')).toEqual({ rows: [expectedRow(aBefore, '2027-03-29', '2027-04-03')], previewHash: preview.previewHash });
      const aAfter = await f.task(a.id);
      expect(aAfter).toMatchObject({ startDate: '2027-03-29', dueDate: '2027-04-03', revision: aBefore.revision + 1 });
      expect(conserved(aAfter)).toEqual(conserved(aBefore));
      await expect(ui.timeline.getByRole('img', { name: currentLabel('2027-03-29', '2027-04-03'), exact: true })).toHaveCount(1, eventual);
      expect(net.writes.map(w => w.path)).toEqual([previewPath(f), applyPath(f)]); clean(net);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: info.outputPath('gantt-keyboard-saved-mobile.png') });
      Object.assign(evidence, { preview, previewRequest: net.previews()[0], applyRequest: net.applies()[0], before: aBefore, after: aAfter });
    } finally { await evidenceJson(info, 'gantt-keyboard-mobile.json', { ...evidence, net }); }
  });
});
