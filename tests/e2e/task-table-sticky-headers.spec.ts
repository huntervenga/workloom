// Private compiled Chrome only. Actual scrolling and hit tests; no main data or runtime lifecycle.
import { expect, test, type Page } from '@playwright/test';
import { projectColumnsResponseSchema, projectResponseSchema, sectionResponseSchema, taskFieldDefinitionResponseSchema } from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';
import { requirePrivateMembershipDatabase } from './support/private-membership-fixture.js';
import { PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, requireValue, savedRow, showColumns } from './support/asana-private-project.js';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
async function geometry(page: Page) {
  return page.locator('[data-task-table-scroll]').evaluate(port => {
    const table = port.querySelector('table'), head = table?.tHead, shell = document.querySelector('.app-shell-workspace > header');
    if (!table || !head || !shell) throw new Error('Missing actual table or shell headings.');
    const rect = (node: Element) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
    const cells = [...head.querySelectorAll('th')];
    const firstRow = table.querySelector('tr[data-task-row]');
    return { header: rect(head), shell: rect(shell), table: rect(table), port: rect(port), cells: cells.map(rect),
      firstRow: firstRow ? rect(firstRow) : null, sectionLabel: (() => { const label = table.querySelector('[data-task-group-label]'); return label ? rect(label) : null; })(), scrollLeft: port.scrollLeft, scrollY,
      singleHeader: table.querySelectorAll('thead').length,
      firstHit: (() => { const r = requireRect(cells[0]); const hit = document.elementFromPoint(Math.max(r.left + 5, port.getBoundingClientRect().left + 5), r.top + r.height / 2); return Boolean(hit && head.contains(hit)); })(),
      background: getComputedStyle(head).backgroundColor,
    };
    function requireRect(node: Element | undefined) { if (!node) throw new Error('No title header.'); return node.getBoundingClientRect(); }
  });
}
async function expectPinned(page: Page) {
  await expect.poll(async () => { const g = await geometry(page); return Math.abs(g.header.top - g.shell.bottom); }, { message: 'The genuine table header stays directly below the global Topbar' }).toBeLessThanOrEqual(1.5);
  const g = await geometry(page);
  expect(g.singleHeader).toBe(1); expect(g.firstHit).toBe(true); expect(g.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(Math.abs(requireValue(g.cells[0]).left - g.port.left)).toBeLessThanOrEqual(1.5);
  return g;
}
test.describe('task column headings survive page and horizontal scrolling', () => {
  test.use({ viewport: { width: 1600, height: 900 } });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || process.env.WORKLOOM_QA_RUN_AUTHORIZED !== '1' || info.config.workers !== 1) throw new Error('Explicit private compiled49318 and one worker required.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Auth traces/video forbidden.');
    requirePrivateMembershipDatabase(); provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  for (const theme of ['light', 'dark'] as const) test(`${theme}: same real header pins below Topbar, aligns horizontally, keeps menus live and follows a non-modal drawer`, async ({ page }, info) => {
    const f = await freshProject(page, provider, 'Sticky task headings'), projectPath = `${f.prefix}/projects/${f.projectId}`;
    const section = (await apiWrite(page, `${projectPath}/sections`, { name: 'Long delivery section' }, sectionResponseSchema)).data;
    const fields = [];
    for (const name of ['Planned effort', 'Actual effort', 'Delivery score', 'Confidence score']) fields.push((await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name, type: 'number', historyEnabled: false, locked: false, options: [] }, taskFieldDefinitionResponseSchema)).data);
    const columns = (await apiRead(page, `${projectPath}/columns`, projectColumnsResponseSchema)).data;
    await apiWrite(page, `${projectPath}/columns`, { expectedRevision: columns.revision, columns: fields.map((field, position) => ({ fieldId: field.id, visible: true, width: 220, position })) }, projectColumnsResponseSchema, 'PATCH');
    for (let i = 1; i <= 45; i += 1) await createFixtureTask(f, `Delivery ${String(i).padStart(2, '0')}`, { sectionId: section.id });
    const project = (await apiRead(page, projectPath, projectResponseSchema)).data;
    await page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table`);
    await expect(page.getByRole('heading', { level: 1, name: project.name, exact: true })).toBeVisible();
    await expect(page.locator('[data-task-table-scroll]').getByRole('button', { name: 'Delivery 01', exact: true })).toBeVisible();
    await showColumns(page, ['Status', 'Assignee', 'Due date', ...fields.map(field => field.name)]);
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: 'Dark theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const before = await geometry(page);
    await page.locator('[data-task-table-scroll]').evaluate(port => window.scrollTo(0, scrollY + port.getBoundingClientRect().top + 300));
    const pinned = await expectPinned(page); expect(pinned.scrollY).toBeGreaterThan(before.scrollY + 200);
    const port = page.locator('[data-task-table-scroll]');
    await port.evaluate(node => { node.scrollLeft = 360; });
    await expect.poll(async () => (await geometry(page)).scrollLeft).toBeGreaterThan(200);
    const horizontal = await expectPinned(page);
    expect(Math.abs(requireValue(horizontal.cells[1]).left - (requireValue(pinned.cells[1]).left - horizontal.scrollLeft))).toBeLessThanOrEqual(1.5);
    expect(Math.abs(requireValue(horizontal.sectionLabel ?? undefined).left - requireValue(pinned.sectionLabel ?? undefined).left)).toBeLessThanOrEqual(1.5);
    // Click the original custom header menu while pinned; no clone, hidden proxy or forced event.
    const menuButton = page.getByRole('button', { name: 'Column options for Planned effort', exact: true });
    await expect(menuButton).toBeVisible(); await menuButton.click();
    await expect(page.getByRole('menuitem', { name: 'Edit field', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    const targetId = await page.locator('[data-task-table-scroll]').evaluate(node => {
      const head = node.querySelector('thead')?.getBoundingClientRect();
      const row = [...node.querySelectorAll<HTMLElement>('tr[data-task-row]')].find(item => { const r = item.getBoundingClientRect(); return head && r.top > head.bottom + 20 && r.bottom < innerHeight - 20; });
      if (!row) throw new Error('No actual visible row to open beside the scrolled table.'); return row.dataset.taskRow ?? '';
    });
    await savedRow(page, targetId).locator('[data-task-open-area]').click(); await expect(page.locator('[data-task-panel][data-state="open"]')).toBeVisible();
    const narrowed = await expectPinned(page); expect(narrowed.port.width).toBeLessThan(horizontal.port.width - 400);
    expect(Math.abs(requireValue(narrowed.sectionLabel ?? undefined).left - requireValue(horizontal.sectionLabel ?? undefined).left)).toBeLessThanOrEqual(1.5);
    await page.screenshot({ path: info.outputPath(`sticky-headings-drawer-${theme}.png`) });
    await page.locator('[data-task-panel][data-state="open"]').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('[data-task-panel][data-state="open"]')).toHaveCount(0); await expectPinned(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(async () => { const g = await geometry(page); return Math.abs(g.header.top - (g.table.top + 0.5)); }).toBeLessThanOrEqual(1.5);
    await page.screenshot({ path: info.outputPath(`sticky-headings-restored-${theme}.png`) });
  });
});
