import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import { projectSchema, sectionResponseSchema, taskListResponseSchema, taskSchema, type TaskDto } from '@workloom/contracts';
import { z } from 'zod';
import { apiCall, dailyFixture, gate, taskResult } from './support/daily-fixture.js';
import { evidenceJson } from './support/evidence.js';
import { sizes } from './support/next-ux.js';

const sharedSchema = z.object({ stage: z.literal('complete'), version: z.literal(1), origin: z.string().url(), workspaceId: z.literal('5eed0000-0000-4000-8000-000000000201'), project: projectSchema, parent: taskSchema, child: taskSchema, fillers: z.array(taskSchema).length(99) });
type SharedFixture = z.infer<typeof sharedSchema>;
let shared: Promise<SharedFixture> | undefined;
/** Minimum real UI page boundary: one new101-task fixture, then read-only at both sizes. */
function paginationFixture(request: APIRequestContext, baseURL: string | undefined) {
  shared ??= preparePagination(request, baseURL); return shared;
}
async function preparePagination(request: APIRequestContext, baseURL: string | undefined): Promise<SharedFixture> {
  if (!baseURL) throw Error('Live browser origin is required.');
  const key = process.env.WORKLOOM_SORT_FIXTURE_KEY ?? 'cycle20261016-v9';
  if (!/^[A-Za-z0-9-]{1,80}$/.test(key)) throw Error('Explicit safe fixture key required.');
  const manifest = resolve('.local/qa', `task-sorting-${key}.json`), origin = new URL(baseURL).origin;
  let previous: string | undefined;
  try { previous = await readFile(manifest, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous !== undefined) { const value = sharedSchema.parse(JSON.parse(previous)); if (value.origin !== origin) throw Error('Fixture origin changed; review the manifest.'); return value; }
  await mkdir(dirname(manifest), { recursive: true, mode: 0o700 });
  const save = async (value: unknown) => { const temporary = `${manifest}.${randomUUID()}.pending`; await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, manifest); };
  // Interrupted setup is retained and refuses silent reseeding on a subsequent worker.
  await save({ stage: 'starting', origin, version: 1, startedAtUtc: new Date().toISOString() });
  const f = await dailyFixture(request, baseURL, 'Read-only task sorting pagination');
  await save({ stage: 'creating-tasks', origin, version: 1, workspaceId: f.workspace.id, projectId: f.project.id });
  const parent = await f.createTask(`${f.token} undated parent`, { estimateMinutes: 120, position: 0 });
  const fillers: TaskDto[] = [];
  for (let index = 1; index <= 99; index++) fillers.push(await f.createTask(`${f.token} dated ${String(index).padStart(3, '0')}`, { estimateMinutes: 0, dueDate: '2027-03-01', position: index }));
  const child = await f.createTask(`${f.token} earliest child created last`, { parentTaskId: parent.id, dueDate: '2027-01-01', position: 100 });
  const value = sharedSchema.parse({ stage: 'complete', version: 1, origin, workspaceId: f.workspace.id, project: f.project, parent, child, fillers });
  const query = new URLSearchParams({ projectId: f.project.id, limit: '100' });
  const manualResponse = await request.get(`${f.prefix}/tasks?${query}`); expect(manualResponse.status()).toBe(200); const manual = taskListResponseSchema.parse(await manualResponse.json());
  expect(manual.data).toHaveLength(100); expect(manual.data.some(t => t.id === child.id)).toBe(false); expect(manual.meta.nextCursor).toBeTruthy();
  query.set('sort', 'due_asc'); const dueResponse = await request.get(`${f.prefix}/tasks?${query}`); expect(dueResponse.status()).toBe(200); const due = taskListResponseSchema.parse(await dueResponse.json());
  expect(due.data.map(t => t.id)).toEqual([child, ...fillers].sort(compareDue).map(t => t.id)); expect(due.meta.nextCursor).toBeTruthy();
  query.set('cursor', due.meta.nextCursor ?? ''); const lastResponse = await request.get(`${f.prefix}/tasks?${query}`); expect(lastResponse.status()).toBe(200); const last = taskListResponseSchema.parse(await lastResponse.json()); expect(last.data.map(t => t.id)).toEqual([parent.id]); expect(last.meta.nextCursor).toBe(null);
  await save(value); return value;
}
function compareDue(a: TaskDto, b: TaskDto) { return a.dueDate === b.dueDate ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate < b.dueDate ? -1 : 1; }
function renderedTaskTitles(table: Locator) { return table.getByRole('checkbox').evaluateAll(inputs => inputs.map(input => input.getAttribute('aria-label')?.replace(/^Select for graph: /, '') ?? '')); }

for (const [name, viewport] of sizes) test.describe(`Project task sorting ${name}`, () => {
  test.use({ viewport });
  test('real due pages cross the manual boundary and join a later parent; native group/sibling/lane order, URL, filters, hidden drafts and late acknowledgement preserve current intent', async ({ page, request, baseURL }, info) => {
    test.setTimeout(100_000);
    const shared = await paginationFixture(request, baseURL), prefix = `/api/v1/workspaces/${shared.workspaceId}`, sharedPath = `/w/${shared.workspaceId}/projects/${shared.project.id}`;
    const writes: { method: string; path: string; body: string | null; key: string | undefined }[] = [], reads: string[] = [], errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', q => { const url = new URL(q.url()); if (!['GET', 'HEAD', 'OPTIONS'].includes(q.method())) writes.push({ method: q.method(), path: url.pathname, body: q.postData(), key: q.headers()['idempotency-key'] }); else if (url.pathname === `${prefix}/tasks`) reads.push(url.href); });
    const manualRead = page.waitForResponse(r => apiCall(r, 'GET', `${prefix}/tasks`) && new URL(r.url()).searchParams.get('projectId') === shared.project.id && !new URL(r.url()).searchParams.has('sort'));
    await page.goto(sharedPath); const manualResponse = await manualRead, manual = taskListResponseSchema.parse(await manualResponse.json()); expect(manualResponse.status()).toBe(200); expect(new URL(manualResponse.url()).searchParams.get('limit')).toBe('100'); expect(manual.data).toHaveLength(100); expect(manual.data.some(t => t.id === shared.child.id)).toBe(false);
    const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Task', exact: true }) });
    const sort = page.getByRole('combobox', { name: 'Sort', exact: true }); await expect(sort).toHaveValue('manual');
    const footer = table.getByRole('row').filter({ has: page.getByText('Loaded team budget', { exact: true }) }), budget = footer.locator('td > span').first();
    await expect(table.getByRole('checkbox')).toHaveCount(100); await expect(budget).toHaveText('2h');
    const dueRead = page.waitForResponse(r => apiCall(r, 'GET', `${prefix}/tasks`) && new URL(r.url()).searchParams.get('projectId') === shared.project.id && new URL(r.url()).searchParams.get('sort') === 'due_asc' && !new URL(r.url()).searchParams.has('cursor'));
    await sort.selectOption('due_asc'); const dueResponse = await dueRead, due = taskListResponseSchema.parse(await dueResponse.json()); expect(dueResponse.status()).toBe(200); expect(due.data.map(t => t.id)).toEqual([shared.child, ...shared.fillers].sort(compareDue).map(t => t.id)); expect(due.meta.nextCursor).toBeTruthy();
    await expect(table.getByRole('checkbox', { name: `Select for graph: ${shared.parent.title}`, exact: true })).toHaveCount(0);
    const detached = table.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `Select for graph: ${shared.child.title}`, exact: true }) }); await expect(detached.getByTitle('Parent task is outside the loaded set', { exact: true })).toBeVisible(); await expect(budget).toHaveText('2h');
    const nextRead = page.waitForResponse(r => apiCall(r, 'GET', `${prefix}/tasks`) && new URL(r.url()).searchParams.get('projectId') === shared.project.id && new URL(r.url()).searchParams.get('cursor') === due.meta.nextCursor && new URL(r.url()).searchParams.get('sort') === 'due_asc');
    await page.getByRole('button', { name: 'Load more tasks', exact: true }).click(); const nextResponse = await nextRead, next = taskListResponseSchema.parse(await nextResponse.json()); expect(nextResponse.status()).toBe(200); expect(next.data.map(t => t.id)).toEqual([shared.parent.id]); expect(next.meta.nextCursor).toBe(null);
    await expect(table.getByRole('checkbox')).toHaveCount(101); await expect(detached.getByTitle('Parent task is outside the loaded set', { exact: true })).toHaveCount(0);
    await expect.poll(() => renderedTaskTitles(table)).toEqual([...shared.fillers].sort(compareDue).map(t => t.title).concat(shared.parent.title, shared.child.title)); await expect(budget).toHaveText('2h'); expect(writes).toEqual([]);
    await evidenceJson(info, 'sorting-pagination.json', { fixtureProjectId: shared.project.id, sharedAcrossViewports: true, browserLimit: 100, manual, due, next, footer: await footer.innerText(), browserWrites: writes });
    // Independent small writable project; the101-task fixture stays read-only for the other viewport.
    const f = await dailyFixture(request, baseURL, 'Project sorting interaction'); const second = (await f.post(`/projects/${f.project.id}/sections`, { name: 'Later section', position: 1 }, sectionResponseSchema)).data;
    const root = await f.createTask(`${f.token} parent`, { dueDate: '2027-04-20', estimateMinutes: 120, position: 1 });
    const peer = await f.createTask(`${f.token} peer`, { dueDate: '2027-04-10', estimateMinutes: 60, position: 0, statusId: f.progress.id });
    const childA = await f.createTask(`${f.token} child A`, { parentTaskId: root.id, dueDate: '2027-04-01', position: 3 }); const childB = await f.createTask(`${f.token} child B`, { parentTaskId: root.id, dueDate: '2027-04-01', position: 2 });
    const nullA = await f.createTask(`${f.token} undated A`, { sectionId: second.id, estimateMinutes: 0, position: 4 }), nullB = await f.createTask(`${f.token} undated B`, { sectionId: second.id, estimateMinutes: 0, position: 5 }); const all = [root, peer, childA, childB, nullA, nullB];
    const contextPath = `${f.path}?worker=${f.other.id}&marker=sorting#sort-context`; await page.goto(contextPath); await expect(sort).toHaveValue('manual'); await expect.poll(() => renderedTaskTitles(table)).toEqual([peer, root, childB, childA, nullA, nullB].map(t => t.title));
    await page.getByRole('button', { name: `Collapse subtasks of “${root.title}”`, exact: true }).click(); await page.getByRole('button', { name: 'Collapse section “Later section”', exact: true }).click();
    await sort.selectOption('due_asc'); await expect(page.getByRole('button', { name: `Expand subtasks of “${root.title}”`, exact: true })).toHaveAttribute('aria-expanded', 'false'); await expect(page.getByRole('button', { name: 'Expand section “Later section”', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: 'Board', exact: true }).click(); const lanes = page.getByRole('region', { name: 'Task status lanes', exact: true }); await expect(lanes.getByRole('listitem')).toHaveCount(6);
    for (const status of f.statuses) { const lane = lanes.locator('section').filter({ has: page.getByRole('heading', { name: status.name, exact: true }) }); const expected = all.filter(t => t.statusId === status.id).sort(compareDue).map(t => t.title); await expect.poll(() => lane.getByRole('listitem').evaluateAll(items => items.map(item => item.querySelector('button[id$="-title"]')?.textContent ?? ''))).toEqual(expected); }
    await page.getByRole('button', { name: 'Tasks', exact: true }).click(); await expect(page.getByRole('button', { name: `Expand subtasks of “${root.title}”`, exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Expand section “Later section”', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Expand subtasks of “${root.title}”`, exact: true }).click(); await page.getByRole('button', { name: 'Expand section “Later section”', exact: true }).click(); const dueTitles = [peer, root, ...[childA, childB].sort(compareDue), ...[nullA, nullB].sort(compareDue)].map(t => t.title); await expect.poll(() => renderedTaskTitles(table)).toEqual(dueTitles); await expect(budget).toHaveText('3h');
    const filterSummary = page.locator('summary').filter({ hasText: /^Filters(?: \(\d+\))?$/ }); await filterSummary.click(); await page.getByLabel('Task status', { exact: true }).selectOption(f.progress.id); await filterSummary.click(); await expect(table.getByRole('checkbox')).toHaveCount(1); await expect.poll(() => reads.some(value => { const url = new URL(value); return url.searchParams.get('projectId') === f.project.id && url.searchParams.get('statusId') === f.progress.id && url.searchParams.get('sort') === 'due_asc' && !url.searchParams.has('cursor'); })).toBe(true); await expect(filterSummary).toHaveText('Filters (1)'); await expect(sort).toHaveValue('due_asc');
    await sort.selectOption('manual'); await expect(filterSummary).toHaveText('Filters (1)'); await sort.selectOption('due_asc'); const retainedUrl = page.url(); await page.getByRole('button', { name: 'Clear filters', exact: true }).click(); await expect(table.getByRole('checkbox')).toHaveCount(6); await expect(sort).toHaveValue('due_asc'); expect(page.url()).toBe(retainedUrl);
    await page.goBack(); await expect(sort).toHaveValue('manual'); await page.goForward(); await expect(sort).toHaveValue('due_asc'); await page.reload(); await expect(sort).toHaveValue('due_asc'); expect(new URL(page.url()).searchParams.get('worker')).toBe(f.other.id); expect(new URL(page.url()).searchParams.get('marker')).toBe('sorting'); expect(new URL(page.url()).hash).toBe('#sort-context'); await expect.poll(() => renderedTaskTitles(table)).toEqual(dueTitles);
    await page.getByRole('button', { name: childA.title, exact: true }).click(); const drawer = page.getByRole('dialog', { name: childA.title, exact: true }); const rawDescription = 'Unsubmitted detail description survives sorting'; await drawer.getByLabel('Description', { exact: true }).fill(rawDescription); await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
    const committed = gate(), ack = gate(); const taskPath = `${f.prefix}/tasks/${root.id}`; let originalBody: string | null = null;
    await page.route(`**${taskPath}`, async route => { if (route.request().method() !== 'PATCH') return route.continue(); originalBody = route.request().postData(); const actual = await route.fetch(); expect(actual.status()).toBe(200); committed.release(); await ack.wait; await route.fulfill({ response: actual }); });
    try {
      await page.getByRole('button', { name: `Edit due date for ${root.title}`, exact: true }).click(); const editor = page.getByRole('form', { name: `Edit ${root.title} in the task table`, exact: true }); await editor.getByLabel('Due date', { exact: true }).fill('2027-04-05'); const response = page.waitForResponse(r => apiCall(r, 'PATCH', taskPath)); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await committed.wait;
      await sort.selectOption('manual'); await sort.selectOption('due_asc'); await expect(editor.getByLabel('Due date', { exact: true })).toHaveValue('2027-04-05'); await expect(editor.getByLabel('Due date', { exact: true })).toBeDisabled(); const search = page.getByLabel('Search tasks', { exact: true }); await search.click(); await expect(search).toBeFocused(); const currentUrl = page.url(); ack.release(); const saved = await taskResult(await response, 200); expect(JSON.parse(originalBody ?? '{}')).toEqual({ expectedRevision: root.revision, dueDate: '2027-04-05' }); expect(saved.dueDate).toBe('2027-04-05'); await expect(editor.getByLabel('Due date', { exact: true })).toBeEnabled(); await expect(editor.getByLabel('Due date', { exact: true })).toHaveValue('2027-04-05'); await expect(search).toBeFocused(); expect(page.url()).toBe(currentUrl); expect(writes).toHaveLength(1); await editor.getByRole('button', { name: 'Save', exact: true }).click(); await expect(editor).toHaveCount(0); expect(writes).toHaveLength(1);
      await expect.poll(() => renderedTaskTitles(table)).toEqual([root, ...[childA, childB].sort(compareDue), peer, ...[nullA, nullB].sort(compareDue)].map(t => t.title)); await expect(budget).toHaveText('3h');
      await page.getByRole('button', { name: childA.title, exact: true }).click(); await expect(drawer.getByLabel('Description', { exact: true })).toHaveValue(rawDescription); expect((await f.task(childA.id)).description).toBe(''); await drawer.getByRole('button', { name: 'Discard draft', exact: true }).click(); await drawer.getByRole('button', { name: 'Close', exact: true }).first().click(); await expect(drawer).toHaveCount(0);
      expect(writes).toHaveLength(1); expect(writes[0]?.method).toBe('PATCH'); expect(writes[0]?.path).toBe(taskPath); for (const task of all) expect((await f.task(task.id)).position).toBe(task.position); expect(errors).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0); await page.screenshot({ path: info.outputPath(`project-due-sorting-${name}.png`), fullPage: true });
      await evidenceJson(info, 'sorting-interaction.json', { projectId: f.project.id, all, saved, writes, reads, errors, rawDescription, paginationProjectId: shared.project.id, sortMutatesPositions: false, filterPersistenceAcrossReloadClaimed: false });
    } finally { ack.release(); if (!page.isClosed()) await page.unroute(`**${taskPath}`); }
  });
});
