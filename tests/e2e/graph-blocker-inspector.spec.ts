import { expect, test } from '@playwright/test';
import { graphLayoutResponseSchema, projectDependencyPolicyResponseSchema, taskBlockingResponseSchema, taskDependencyResponseSchema } from '@workloom/contracts';
import { apiCall, dailyFixture } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { mutate, sizes } from './support/next-ux.js';

for (const [name, viewport] of sizes) test.describe(`Graph blocker inspector ${name}`, () => {
  test.use({ viewport });
  test('reads outside-root and cross-project blockers on demand with current task policy, layered focus and protected navigation; measured diagram controls do not overlap or write layouts', async ({ page, request, baseURL }, info) => {
    test.setTimeout(80_000);
    const f = await dailyFixture(request, baseURL, 'Synthetic graph primary with deliberately wrapped project context for representative node geometry');
    const external = await dailyFixture(request, baseURL, 'Synthetic graph external with deliberately wrapped project context for representative node geometry');
    const root = await f.createTask(`${f.token} successor with a deliberately long title that wraps in the graph card`);
    const local = await f.createTask(`${f.token} local predecessor with a deliberately long title that wraps in the graph card`);
    const outside = await external.createTask(`${external.token} external predecessor with a deliberately long title that wraps in the graph card`);
    const deeper = await external.createTask(`${external.token} outside depth predecessor with a deliberately long title that wraps in the graph card`);
    const edges = [];
    for (const [predecessor, successor] of [[local, root], [outside, root], [deeper, outside]] as const) {
      edges.push((await f.post('/dependencies', { predecessorTaskId: predecessor.id, successorTaskId: successor.id, type: 'finish_to_start', expectedAbsent: true }, taskDependencyResponseSchema)).data);
    }
    const policyPath = `/projects/${f.project.id}/dependency-policy`;
    const policyHead = projectDependencyPolicyResponseSchema.parse(await (await request.get(f.prefix + policyPath)).json()).data;
    const policy = (await mutate(f, 'PATCH', policyPath, { expectedRevision: policyHead.revision, mode: 'enforce' }, projectDependencyPolicyResponseSchema)).data;
    const layoutPath = `/projects/${f.project.id}/graph-layout`;
    const layout = (await mutate(f, 'PUT', layoutPath, { expectedRevision: 0, positions: [{ taskId: outside.id, x: 0, y: 0 }, { taskId: local.id, x: 0, y: 164 }, { taskId: root.id, x: 340, y: 0 }] }, graphLayoutResponseSchema)).data;
    const blockingRequests: string[] = [], writes: string[] = [], reads: { url: string; taskId: string; response: unknown }[] = [], errors: string[] = [];
    page.on('request', q => { if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push(`${q.method()} ${q.url()}`); });
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', q => { if (q.method() === 'GET' && /\/tasks\/[^/]+\/blocking$/.test(new URL(q.url()).pathname)) blockingRequests.push(q.url()); });
    let inspectorReads = 0;
    page.on('request', q => { if (q.method() === 'GET' && new URL(q.url()).pathname === `${f.prefix}/tasks/${root.id}/blocking`) inspectorReads++; });
    await page.goto(f.path);
    await page.getByRole('checkbox', { name: `Select for graph: ${root.title}`, exact: true }).check();
    await page.getByRole('button', { name: 'Selected graph (1)', exact: true }).click();
    const graph = page.getByRole('region', { name: 'Project dependencies', exact: true });
    // Desktop defaults to Diagram; mobile defaults to List. Select the intended action context explicitly.
    const initialCanvasMounted = await graph.getByRole('region', { name: 'Dependency graph', exact: true }).count() > 0;
    await graph.getByRole('button', { name: 'Dependency list', exact: true }).click();
    const depth = graph.getByLabel('Neighbor depth', { exact: true });
    await depth.selectOption('0');
    const list = graph.getByRole('list', { name: 'Graph tasks and dependencies', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(1);
    // Record only inspector reads: task drawers later perform their own legitimate blocking read.
    expect(inspectorReads).toBe(0); expect(blockingRequests).toEqual([]);
    const opener = list.getByRole('button', { name: `View blockers (2): ${root.title}`, exact: true });
    const firstRead = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/tasks/${root.id}/blocking`));
    await opener.focus(); await opener.press('Enter');
    const firstResponse = await firstRead;
    expect(firstResponse.status()).toBe(200); expect(new URL(firstResponse.url()).searchParams.get('limit')).toBe('10');
    const blocking = taskBlockingResponseSchema.parse(await firstResponse.json());
    expect(blocking.data.summary).toMatchObject({ taskId: root.id, unresolvedCount: 2, canStart: false, canComplete: false, policy: { projectId: f.project.id, mode: 'enforce' } });
    reads.push({ url: firstResponse.url(), taskId: root.id, response: blocking });
    const inspector = page.getByRole('dialog', { name: `Blockers for ${root.title}`, exact: true });
    await expect(inspector.getByText('Outside this graph', { exact: true })).toHaveCount(2);
    await expect(inspector).toContainText('Showing 2 of 2 unfinished predecessors.');
    await expect(inspector).toContainText('Starting and completion are blocked until these predecessors finish. Other fields remain editable.');
    expect(inspectorReads).toBe(1);
    const refreshRead = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/tasks/${root.id}/blocking`));
    await inspector.getByRole('button', { name: 'Refresh blockers', exact: true }).click();
    const refreshed = await refreshRead; expect(refreshed.status()).toBe(200);
    reads.push({ url: refreshed.url(), taskId: root.id, response: taskBlockingResponseSchema.parse(await refreshed.json()) });
    await expect(inspector.getByRole('button', { name: `Open task: ${local.title}`, exact: true })).toBeVisible();
    const openLocal = inspector.getByRole('button', { name: `Open task: ${local.title}`, exact: true });
    await openLocal.click();
    const drawer = page.getByRole('dialog', { name: local.title, exact: true }); await expect(drawer).toBeVisible();
    await expect(page.getByRole('dialog', { name: `Blockers for ${root.title}`, exact: true, includeHidden: true })).toHaveAttribute('aria-hidden', 'true');
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0); await expect(openLocal).toBeFocused();
    await page.keyboard.press('Escape'); await expect(inspector).toHaveCount(0); await expect(opener).toBeFocused();
    await depth.selectOption('1'); await expect(list.getByRole('listitem')).toHaveCount(3);
    // Preserve the original y0/y164 saved coordinates; only explicit automatic placement creates local moves.
    expect(graphLayoutResponseSchema.parse(await (await request.get(f.prefix + layoutPath)).json()).data).toEqual(layout);
    const saveLayout = graph.getByRole('button', { name: 'Save my layout', exact: true });
    await expect(saveLayout).toBeDisabled();
    await expect(graph.getByRole('region', { name: 'Dependency graph', exact: true })).toHaveCount(0);
    const arrange = graph.getByRole('button', { name: 'Apply automatic layout', exact: true });
    await expect(arrange).toBeEnabled(); await arrange.focus(); await arrange.press('Enter');
    await expect(saveLayout).toBeEnabled();
    expect(writes).toEqual([]);
    expect(graphLayoutResponseSchema.parse(await (await request.get(f.prefix + layoutPath)).json()).data).toEqual(layout);
    await graph.getByRole('button', { name: 'Diagram', exact: true }).click();
    const canvas = graph.getByRole('region', { name: 'Dependency graph', exact: true });
    const nodes = canvas.locator('.react-flow__node'); await expect(nodes).toHaveCount(3);
    await graph.getByRole('button', { name: 'Fit selected graph', exact: true }).click();
    const measure = () => nodes.evaluateAll(elements => elements.map(node => {
      const rect = node.getBoundingClientRect(), button = node.querySelector<HTMLButtonElement>('button[aria-label^="View blockers ("]');
      if (!button) throw Error('Measured node must expose its native blocker control.');
      const control = button.getBoundingClientRect();
      const text = [...node.querySelectorAll<HTMLElement>('button, p')].map(element => {
        const range = document.createRange(); range.selectNodeContents(element);
        return { tag: element.tagName, text: element.textContent, lineClamp: getComputedStyle(element).webkitLineClamp, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, rectangles: [...range.getClientRects()].map(r => ({ left: r.left - rect.left, right: r.right - rect.left, top: r.top - rect.top, bottom: r.bottom - rect.top })) };
      });
      return { text, id: node.getAttribute('data-id'), transform: (node as HTMLElement).style.transform, x: rect.x, y: rect.y, width: rect.width, height: rect.height, button: { x: control.x, y: control.y, width: control.width, height: control.height, minHeightCss: getComputedStyle(button).minHeight } };
    }));
    await expect.poll(async () => (await measure()).every(n => n.width > 0 && n.height > 0)).toBe(true);
    const geometry = await measure();
    await evidenceJson(info, 'graph-node-geometry.json', { geometry, initialSavedSpacing: { nodeHeight: 128, gap: 36 }, layoutAction: 'Apply automatic layout from selected Dependency list using measured content', initialCanvasMounted, initialCanvasPositionRenderingCovered: false, arbitrarySavedLayoutsCovered: false });
    await page.screenshot({ path: info.outputPath(`graph-nodes-${name}.png`), fullPage: true });
    // Inspect full content and actual fit-scaled rectangles after real measured automatic placement.
    // CSS min-height is not a claim of 24 screen pixels; arbitrary saved positions may overlap.
    const expectedNodes = [{ task: root, project: f.project, status: f.todo }, { task: local, project: f.project, status: f.todo }, { task: outside, project: external.project, status: external.todo }];
    for (const node of geometry) {
      const expectedNode = expectedNodes.find(row => row.task.id === node.id); if (!expectedNode) throw Error('Unexpected graph node.');
      expect(node.text[0]?.text).toBe(expectedNode.task.title);
      expect(node.text.find(row => row.tag === 'P')?.text).toBe(`${expectedNode.project.name} · ${expectedNode.status.name}`);
      for (const text of node.text) {
        expect(text.lineClamp).toBe('none'); expect(text.scrollHeight).toBeLessThanOrEqual(text.clientHeight + 1);
        expect(text.rectangles.every(r => r.left >= -1 && r.right <= node.width + 1 && r.top >= -1 && r.bottom <= node.height + 1)).toBe(true);
      }
      expect(parseFloat(node.button.minHeightCss)).toBeGreaterThanOrEqual(24);
      expect(node.button.x).toBeGreaterThanOrEqual(node.x - 1); expect(node.button.y).toBeGreaterThanOrEqual(node.y - 1);
      expect(node.button.x + node.button.width).toBeLessThanOrEqual(node.x + node.width + 1);
      expect(node.button.y + node.button.height).toBeLessThanOrEqual(node.y + node.height + 1);
      for (const other of geometry.filter(n => n.id !== node.id)) expect(node.x + node.width <= other.x + 1 || other.x + other.width <= node.x + 1 || node.y + node.height <= other.y + 1 || other.y + other.height <= node.y + 1).toBe(true);
    }
    const canvasRoot = canvas.getByRole('button', { name: `View blockers (2): ${root.title}`, exact: true });
    await canvasRoot.focus(); await canvasRoot.press('Enter'); await expect(inspector).toBeVisible();
    await inspector.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(inspector).toHaveCount(0); await expect(canvasRoot).toBeFocused();
    expect((await measure()).map(n => [n.id, n.transform])).toEqual(geometry.map(n => [n.id, n.transform]));
    const outsideRead = page.waitForResponse(r => apiCall(r, 'GET', `${f.prefix}/tasks/${outside.id}/blocking`));
    await canvas.getByRole('button', { name: `View blockers (1): ${outside.title}`, exact: true }).click();
    const outsideResponse = await outsideRead; expect(outsideResponse.status()).toBe(200);
    const externalBlocking = taskBlockingResponseSchema.parse(await outsideResponse.json());
    expect(externalBlocking.data.summary).toMatchObject({ unresolvedCount: 1, canStart: true, canComplete: true, policy: { projectId: external.project.id, mode: 'warn' } });
    reads.push({ url: outsideResponse.url(), taskId: outside.id, response: externalBlocking });
    const externalInspector = page.getByRole('dialog', { name: `Blockers for ${outside.title}`, exact: true });
    await expect(externalInspector).toContainText('Warning mode allows status changes while these predecessors are unfinished.');
    await expect(externalInspector.getByText('Outside this graph', { exact: true })).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`graph-blockers-${name}.png`), fullPage: true });
    const originalUrl = page.url(), openExternal = externalInspector.getByRole('button', { name: `Open task: ${deeper.title}`, exact: true });
    await openExternal.click(); const guard = page.getByRole('dialog', { name: 'Leave this page?', exact: true });
    await expect(guard).toContainText('You have an unsaved draft on this page.');
    await guard.getByRole('button', { name: 'Stay', exact: true }).click(); await expect(guard).toHaveCount(0); expect(page.url()).toBe(originalUrl); await expect(externalInspector).toBeVisible();
    await openExternal.click(); await guard.getByRole('button', { name: 'Leave without saving', exact: true }).click();
    await expect(page.getByRole('dialog', { name: deeper.title, exact: true })).toBeVisible(); expect(new URL(page.url()).pathname).toBe(external.path); expect(new URL(page.url()).searchParams.get('task')).toBe(deeper.id);
    await expect(externalInspector).toHaveCount(0);
    expect(graphLayoutResponseSchema.parse(await (await request.get(f.prefix + layoutPath)).json()).data).toEqual(layout);
    expect(projectDependencyPolicyResponseSchema.parse(await (await request.get(f.prefix + policyPath)).json()).data).toEqual(policy);
    expect(await f.task(root.id)).toEqual(root); expect(await f.task(local.id)).toEqual(local); expect(await external.task(outside.id)).toEqual(outside); expect(await external.task(deeper.id)).toEqual(deeper);
    expect(writes).toEqual([]); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await evidenceJson(info, 'graph-inspector-proof.json', { geometry, reads, blockingRequests, writes, errors, edges, layout, initialSavedSpacing: { nodeHeight: 128, gap: 36 }, layoutAction: 'Apply automatic layout from selected Dependency list using measured content', initialCanvasMounted, initialCanvasPositionRenderingCovered: false, arbitrarySavedLayoutsCovered: false, browserActorSwitchCovered: false });
  });
});
