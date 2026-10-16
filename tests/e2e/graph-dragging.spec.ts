import { expect, test, type Locator, type Page } from '@playwright/test';
import { graphLayoutResponseSchema, projectDependencyPolicyResponseSchema, taskDependencyResponseSchema, type TaskDto } from '@workloom/contracts';
import { apiCall, dailyFixture, gate } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { mutate, sizes, type Daily } from './support/next-ux.js';

type Point = { x: number; y: number };
type NativeDragEvent = { type: string; x: number; y: number; taskId: string | null };
const graphRegion = (page: Page) => page.getByRole('region', { name: 'Project dependencies', exact: true });
const nodeFor = (graph: Locator, task: TaskDto) => graph.locator(`.react-flow__node[data-id="${task.id}"]`);
const saveFor = (graph: Locator) => graph.getByRole('button', { name: 'Save my layout', exact: true });
const layoutPath = (f: Daily) => `${f.prefix}/projects/${f.project.id}/graph-layout`;
async function readLayout(f: Daily) {
  const response = await f.request.get(layoutPath(f)); expect(response.status()).toBe(200);
  return graphLayoutResponseSchema.parse(await response.json()).data;
}
async function point(node: Locator): Promise<Point> {
  return node.evaluate(element => { const matrix = new DOMMatrixReadOnly((element as HTMLElement).style.transform); return { x: matrix.e, y: matrix.f }; });
}
async function browserPoint(page: Page, value: Point): Promise<Point> {
  // CSSOM serializes numeric transforms with browser precision; preserve raw API
  // doubles separately and compare rendered values using that same native path.
  return page.evaluate(value => {
    const style = document.createElement('div').style;
    style.transform = `translate(${value.x}px, ${value.y}px)`;
    const matrix = new DOMMatrixReadOnly(style.transform); return { x: matrix.e, y: matrix.f };
  }, value);
}
async function viewport(graph: Locator) {
  return graph.locator('.react-flow__viewport').evaluate(element => { const m = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { zoom: m.a, x: m.e, y: m.f }; });
}
async function openGraph(page: Page, f: Daily, root: TaskDto, count: number, navigate = true) {
  // A clean native navigation selects the same explicit roots again; selection is not a saved view.
  if (navigate) await page.goto(f.path);
  else await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('checkbox', { name: `Select for graph: ${root.title}`, exact: true }).check();
  await page.getByRole('button', { name: 'Selected graph (1)', exact: true }).click();
  const graph = graphRegion(page);
  await graph.getByLabel('Neighbor depth', { exact: true }).selectOption('1');
  await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
  await expect(graph.locator('.react-flow__node')).toHaveCount(count);
  await expect(saveFor(graph)).toBeDisabled();
  return graph;
}
async function nonUnitZoom(graph: Locator) {
  await graph.getByRole('button', { name: 'Fit selected graph', exact: true }).click();
  // Wait for React Flow's own viewport transition, then deliberately select a non-unit zoom.
  await expect.poll(async () => (await viewport(graph)).zoom > 0).toBe(true);
  await graph.getByRole('button', { name: 'Zoom out', exact: true }).click();
  let previous = '', equalReads = 0;
  await expect.poll(async () => {
    const current = JSON.stringify(await viewport(graph)); equalReads = current === previous ? equalReads + 1 : 0; previous = current;
    return equalReads >= 2 && Math.abs((await viewport(graph)).zoom - 1) > 0.01;
  }).toBe(true);
}
/** Native Playwright mouse input, also at the mobile viewport; this is not physical-touch evidence. */
async function drag(page: Page, graph: Locator, task: TaskDto, dx = 22, dy = 24) {
  const node = nodeFor(graph, task), background = node.locator('p').first();
  await background.scrollIntoViewIfNeeded();
  const box = await background.boundingBox(); if (!box) throw Error('Visible graph metadata is required for native dragging.');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await point(node), beforeViewport = await viewport(graph);
  const movable = await node.evaluate(element => element.classList.contains('draggable'));
  await page.evaluate(() => {
    const host = window as typeof window & { __workloomGraphDrag?: { events: { type: string; x: number; y: number; taskId: string | null }[]; stop: () => void } };
    host.__workloomGraphDrag?.stop();
    const abort = new AbortController(), events: { type: string; x: number; y: number; taskId: string | null }[] = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) window.addEventListener(type, event => {
      const e = event as PointerEvent; events.push({ type, x: e.clientX, y: e.clientY, taskId: (e.target as Element).closest?.('.react-flow__node')?.getAttribute('data-id') ?? null });
    }, { capture: true, signal: abort.signal });
    host.__workloomGraphDrag = { events, stop: () => abort.abort() };
  });
  try {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    // Native XYFlow establishes its anchor at the threshold-crossing mousemove,
    // so observe an already-active drag rather than count that initial segment.
    await page.mouse.move(start.x + dx / 4, start.y + dy / 4, { steps: 2 });
    let activeAnchor: { point: Point; viewport: Awaited<ReturnType<typeof viewport>>; event: NativeDragEvent } | null = null;
    if (movable) {
      await expect(node).toHaveClass(/\bdragging\b/);
      let previous = '', equalReads = 0;
      await expect.poll(async () => { const current = JSON.stringify(await point(node)); equalReads = current === previous ? equalReads + 1 : 0; previous = current; return equalReads >= 2; }).toBe(true);
      const event = await page.evaluate(() => (window as typeof window & { __workloomGraphDrag?: { events: NativeDragEvent[] } }).__workloomGraphDrag?.events.findLast(event => event.type === 'mousemove'));
      if (!event) throw Error('An actual native mousemove must establish the active anchor.');
      activeAnchor = { point: await point(node), viewport: await viewport(graph), event };
    }
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 6 }); await page.mouse.up();
    let settled = '', equalReads = 0;
    await expect.poll(async () => {
      const current = JSON.stringify({ point: await point(node), viewport: await viewport(graph), dragging: await node.evaluate(element => element.classList.contains('dragging')) });
      equalReads = current === settled ? equalReads + 1 : 0; settled = current; return equalReads >= 2;
    }).toBe(true);
    const events = await page.evaluate(() => (window as typeof window & { __workloomGraphDrag?: { events: unknown[] } }).__workloomGraphDrag?.events ?? []);
    return { before, after: await point(node), beforeViewport, afterViewport: await viewport(graph), activeAnchor, draggingAfter: await node.evaluate(element => element.classList.contains('dragging')), start, requested: { dx, dy }, events };
  } finally {
    await page.evaluate(() => { const host = window as typeof window & { __workloomGraphDrag?: { stop: () => void } }; host.__workloomGraphDrag?.stop(); delete host.__workloomGraphDrag; });
  }
}
function assertScaledDrag(result: Awaited<ReturnType<typeof drag>>, id: string) {
  const events = result.events as NativeDragEvent[];
  const down = events.find(event => event.type === 'mousedown'), up = events.findLast(event => event.type === 'mouseup');
  expect(down?.taskId).toBe(id); if (!down || !up) throw Error('Actual native pointer down/up evidence is required.');
  expect(result.afterViewport).toEqual(result.beforeViewport);
  expect(result.draggingAfter).toBe(false);
  const anchor = result.activeAnchor; if (!anchor) throw Error('An observed active native drag anchor is required.');
  expect(anchor.viewport).toEqual(result.beforeViewport);
  expect(result.after.x - anchor.point.x).toBeCloseTo((up.x - anchor.event.x) / anchor.viewport.zoom, 1);
  expect(result.after.y - anchor.point.y).toBeCloseTo((up.y - anchor.event.y) / anchor.viewport.zoom, 1);
}

for (const [name, size] of sizes) test.describe(`Graph native mouse dragging ${name}`, () => {
  test.use({ viewport: size });
  test('arranges a personal draft with explicit save, retained hidden positions, exact lost-ACK retry, navigation protection and bounded coordinates', async ({ page, request, baseURL }, info) => {
    test.setTimeout(120_000); page.setDefaultTimeout(15_000);
    const f = await dailyFixture(request, baseURL, 'Native graph drag'), external = await dailyFixture(request, baseURL, 'Native graph neighbor');
    const root = await f.createTask(`${f.token} drag background`), hidden = await f.createTask(`${f.token} hidden saved position`), neighbor = await external.createTask(`${external.token} cross-project neighbor`);
    const edge = (await f.post('/dependencies', { predecessorTaskId: neighbor.id, successorTaskId: root.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data;
    const seeded = (await mutate(f, 'PUT', `/projects/${f.project.id}/graph-layout`, { expectedRevision: 0, positions: [{ taskId: root.id, x: 0, y: 0 }, { taskId: neighbor.id, x: 400, y: 0 }, { taskId: hidden.id, x: 700, y: 300 }] }, graphLayoutResponseSchema)).data;
    const policyPath = `${f.prefix}/projects/${f.project.id}/dependency-policy`;
    const policy = projectDependencyPolicyResponseSchema.parse(await (await request.get(policyPath)).json()).data;
    const writes: { method: string; path: string; key?: string; body: string | null }[] = [], errors: string[] = [];
    page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: new URL(q.url()).pathname, key: q.headers()['idempotency-key'], body: q.postData() }); });
    page.on('pageerror', e => errors.push(e.message));
    let graph = await openGraph(page, f, root, 2);
    await expect(nodeFor(graph, hidden)).toHaveCount(0);
    await expect(graph.getByText('Drag a card’s background to arrange your view. Choose Save my layout to keep your changes.', { exact: true })).toBeVisible();
    await nonUnitZoom(graph);
    const initialDrag = await drag(page, graph, root);
    await evidenceJson(info, '00-native-observation.json', { input: 'Native Playwright mouse', viewport: size, initialDrag });
    assertScaledDrag(initialDrag, root.id);
    await expect(page.getByRole('dialog')).toHaveCount(0); await expect(saveFor(graph)).toBeEnabled(); expect(writes).toEqual([]);
    expect(await readLayout(f)).toEqual(seeded);
    const saveResponse = page.waitForResponse(r => apiCall(r, 'PUT', layoutPath(f)));
    await saveFor(graph).click(); expect((await saveResponse).status()).toBe(200); await expect(saveFor(graph)).toBeDisabled();
    const saved = await readLayout(f);
    expect(saved.positions).toHaveLength(3);
    expect(saved.positions.filter(row => row.taskId !== root.id)).toEqual(seeded.positions.filter(row => row.taskId !== root.id));
    const savedRoot = saved.positions.find(row => row.taskId === root.id); if (!savedRoot) throw Error('The explicitly saved root position is required.');
    expect(initialDrag.after).toEqual(await browserPoint(page, savedRoot));
    expect(JSON.parse(writes[0]?.body ?? 'null')).toEqual({ expectedRevision: seeded.revision, positions: saved.positions });
    await page.reload(); graph = await openGraph(page, f, root, 2, false);
    expect(await point(nodeFor(graph, root))).toEqual(initialDrag.after); expect(await readLayout(f)).toEqual(saved);
    await nonUnitZoom(graph);
    const reopenedScreenshot = info.outputPath(`graph-saved-reopened-${name}.png`);
    await graph.getByRole('region', { name: 'Dependency graph', exact: true }).screenshot({ path: reopenedScreenshot });
    await info.attach('saved-reopened-diagram', { path: reopenedScreenshot, contentType: 'image/png' });
    await evidenceJson(info, '01-native-save-reload.json', { reopenedViewport: await viewport(graph), rootSelectionPersisted: false, input: 'Playwright mouse, not physical touch', viewport: size, initialDrag, seeded, saved, writes: [...writes], edge });

    const discarded = await drag(page, graph, root);
    await graph.getByRole('button', { name: 'Discard moves', exact: true }).click();
    await expect.poll(() => point(nodeFor(graph, root))).toEqual(initialDrag.after);
    const retained = await drag(page, graph, root), originalUrl = page.url();
    await nodeFor(graph, neighbor).getByRole('button', { name: neighbor.title, exact: true }).click();
    const guard = page.getByRole('dialog', { name: 'Leave this page?', exact: true }); await expect(guard).toContainText('You have an unsaved draft on this page.');
    await guard.getByRole('button', { name: 'Stay', exact: true }).click(); await expect(guard).toHaveCount(0);
    expect(page.url()).toBe(originalUrl); expect(await point(nodeFor(graph, root))).toEqual(retained.after);
    await graph.getByRole('button', { name: 'Discard moves', exact: true }).click(); await expect(saveFor(graph)).toBeDisabled();
    expect(await readLayout(f)).toEqual(saved); expect(writes).toHaveLength(1);
    await evidenceJson(info, '02-discard-stay.json', { discarded, retained, originalUrl, savedUnchanged: await readLayout(f), writes: [...writes] });

    await nonUnitZoom(graph); const submitted = await drag(page, graph, root);
    const releaseAck = gate(), sent: { body: string | null; key?: string }[] = [];
    let committedLayout: Awaited<ReturnType<typeof readLayout>> | undefined;
    await page.route(`**${layoutPath(f)}`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      sent.push({ body: route.request().postData(), key: route.request().headers()['idempotency-key'] });
      const response = await route.fetch(); expect(response.status()).toBe(200);
      if (sent.length === 1) { committedLayout = graphLayoutResponseSchema.parse(await response.json()).data; await releaseAck.wait; await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    try {
      await saveFor(graph).click(); await expect.poll(() => committedLayout !== undefined).toBe(true);
      await expect(nodeFor(graph, root)).not.toHaveClass(/\bdraggable\b/);
      const pendingDrag = await drag(page, graph, root); expect(pendingDrag.after).toEqual(submitted.after); expect(pendingDrag.activeAnchor).toBeNull(); expect(pendingDrag.draggingAfter).toBe(false); expect(sent).toHaveLength(1);
      expect(await readLayout(f)).toEqual(committedLayout);
      await evidenceJson(info, '03-pending-lock.json', { submitted, pendingDrag, sent: [...sent], committedLayout });
      releaseAck.release();
      const retry = page.getByRole('button', { name: 'Retry original submission', exact: true }); await expect(retry).toBeVisible();
      const unknownDrag = await drag(page, graph, root); expect(unknownDrag.after).toEqual(submitted.after); expect(unknownDrag.activeAnchor).toBeNull(); expect(unknownDrag.draggingAfter).toBe(false); expect(sent).toHaveLength(1);
      await evidenceJson(info, '04-unknown-lock.json', { unknownDrag, sent: [...sent], committedLayout });
      const replay = page.waitForResponse(r => apiCall(r, 'PUT', layoutPath(f))); await retry.click(); expect((await replay).status()).toBe(200); await expect(retry).toHaveCount(0);
      expect(sent).toHaveLength(2); expect(sent[0]?.key).toBeTruthy(); expect(sent[1]).toEqual(sent[0]); expect(await readLayout(f)).toEqual(committedLayout);
      await expect(saveFor(graph)).toBeDisabled(); expect(await point(nodeFor(graph, root))).toEqual(submitted.after);
      expect(committedLayout?.positions).toEqual(expect.arrayContaining([{ taskId: hidden.id, x: 700, y: 300 }]));
      await evidenceJson(info, '05-exact-replay.json', { sent, committedLayout, writes: [...writes] });
    } finally { releaseAck.release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }

    await nonUnitZoom(graph); const abandoned = await drag(page, graph, root);
    await nodeFor(graph, neighbor).getByRole('button', { name: neighbor.title, exact: true }).click();
    await guard.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await expect(page.getByRole('dialog', { name: neighbor.title, exact: true })).toBeVisible(); expect(new URL(page.url()).pathname).toBe(external.path);
    expect(await readLayout(f)).toEqual(committedLayout); expect(writes).toHaveLength(3);
    await evidenceJson(info, '06-leave-without-saving.json', { abandoned, destination: page.url(), savedUnchanged: await readLayout(f), writes: [...writes] });

    // Separate supported boundary fixture; never replace coordinates to hide the actual native result.
    const boundary = await dailyFixture(request, baseURL, 'Native graph coordinate boundary');
    const boundaryTask = await boundary.createTask(`${boundary.token} near coordinate limit`);
    const boundarySeed = (await mutate(boundary, 'PUT', `/projects/${boundary.project.id}/graph-layout`, { expectedRevision: 0, positions: [{ taskId: boundaryTask.id, x: 99990, y: -99990 }] }, graphLayoutResponseSchema)).data;
    graph = await openGraph(page, boundary, boundaryTask, 1); await nonUnitZoom(graph);
    const boundaryDrag = await drag(page, graph, boundaryTask, 40, -40), boundaryCanSave = await saveFor(graph).isEnabled();
    await evidenceJson(info, '07-boundary-observation.json', { boundarySeed, boundaryDrag, boundaryCanSave, server: await readLayout(boundary) });
    const boundaryScreenshot = info.outputPath(`graph-boundary-${name}.png`);
    await graph.getByRole('region', { name: 'Dependency graph', exact: true }).screenshot({ path: boundaryScreenshot });
    await info.attach('coordinate-boundary-diagram', { path: boundaryScreenshot, contentType: 'image/png' });
    expect(boundaryDrag.draggingAfter).toBe(false);
    expect(Number.isFinite(boundaryDrag.after.x) && Number.isFinite(boundaryDrag.after.y)).toBe(true);
    expect(Math.abs(boundaryDrag.after.x)).toBeLessThanOrEqual(100000); expect(Math.abs(boundaryDrag.after.y)).toBeLessThanOrEqual(100000);
    if (boundaryCanSave) {
      const response = page.waitForResponse(r => apiCall(r, 'PUT', layoutPath(boundary))); await saveFor(graph).click(); expect((await response).status()).toBe(200);
      const stored = await readLayout(boundary); expect(stored.positions).toHaveLength(1);
      expect(JSON.parse(writes.at(-1)?.body ?? 'null')).toEqual({ expectedRevision: boundarySeed.revision, positions: stored.positions });
      const storedPoint = stored.positions[0]; if (!storedPoint) throw Error('The saved boundary position is required.');
      expect(storedPoint.taskId).toBe(boundaryTask.id); expect(boundaryDrag.after).toEqual(await browserPoint(page, storedPoint));
    } else { expect(boundaryDrag.after).toEqual({ x: 99990, y: -99990 }); expect(await readLayout(boundary)).toEqual(boundarySeed); }
    expect(await f.task(root.id)).toEqual(root); expect(await f.task(hidden.id)).toEqual(hidden); expect(await external.task(neighbor.id)).toEqual(neighbor); expect(await boundary.task(boundaryTask.id)).toEqual(boundaryTask);
    expect(projectDependencyPolicyResponseSchema.parse(await (await request.get(policyPath)).json()).data).toEqual(policy);
    expect(writes.every(write => write.method === 'PUT' && [layoutPath(f), layoutPath(boundary)].includes(write.path))).toBe(true);
    expect(writes).toHaveLength(boundaryCanSave ? 4 : 3); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await evidenceJson(info, '08-final-invariants.json', { input: 'Native Playwright mouse at stated viewport; no physical-touch, actor-switch or arbitrary stored-layout claim', writes, errors, boundarySaved: await readLayout(boundary), taskDtosUnchanged: true, policyUnchanged: true });
  });
});
