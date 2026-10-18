// Private shared-Auth Chrome acceptance. The root runner owns Workloom/API/PostgreSQL.
// Only the in-memory RS256 provider is started here; no dev identities, main DB or server fallback.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type Request } from '@playwright/test';
import {
  membershipListResponseSchema, periodCommitmentListResponseSchema, planningPeriodResponseSchema,
  projectColumnsResponseSchema, projectListResponseSchema, projectResponseSchema, sectionResponseSchema,
  taskFieldDefinitionResponseSchema, taskFieldValueListResponseSchema, taskListResponseSchema,
  taskResponseSchema, taskStatusListResponseSchema, workspaceListResponseSchema,
  manualPeriodWorkLogListResponseSchema,
  type TaskDto, type TaskFieldDefinitionDto, type MembershipDto,
} from '@workloom/contracts';
import { startFakeSharedAuth } from './support/fake-shared-auth.js';

const APP = 'http://127.0.0.1:49318';
let provider: Awaited<ReturnType<typeof startFakeSharedAuth>>;
type Parser<T> = { parse(value: unknown): T };
type Fixture = { page: Page; workspaceId: string; prefix: string; projectId: string; statusId: string; doneId: string; member: MembershipDto };
type Command = { path: string; method: string; body: string; key: string | undefined };
const realRow = (page: Page, id: string) => page.locator(`tr[data-task-row="${id}"]`);
const draftRow = (page: Page) => page.locator('tr[data-task-draft-row][data-task-draft-state="draft"]');
const titleInput = (page: Page) => draftRow(page).getByRole('textbox', { name: 'Task name', exact: true });
async function setDraftDueDate(page: Page, dueDate: string) {
  await draftRow(page).getByRole('button', { name: 'Edit dates for the new task', exact: true }).click();
  const popup = page.getByRole('dialog', { name: 'Edit dates', exact: true });
  await expect(popup).toBeVisible(); await popup.getByLabel('Due date', { exact: true }).fill(dueDate);
  await popup.getByRole('button', { name: 'Done', exact: true }).click(); await expect(popup).toHaveCount(0);
}

function required<T>(value: T | undefined): T { if (value === undefined) throw new Error('Required private acceptance fixture is missing.'); return value; }
async function read<T>(page: Page, path: string, parser: Parser<T>): Promise<T> {
  const response = await page.request.get(`${APP}${path}`); expect(response.status()).toBe(200);
  return parser.parse(await response.json());
}
async function write<T>(page: Page, path: string, data: object, parser: Parser<T>, method: 'POST' | 'PATCH' = 'POST'): Promise<T> {
  const response = await page.request.fetch(`${APP}${path}`, { method, data, headers: { Origin: APP, 'Idempotency-Key': randomUUID() } });
  expect([200, 201].includes(response.status())).toBe(true);
  return parser.parse(await response.json());
}
async function login(page: Page, label: string) {
  const account = provider.registerIdentity(`${label} ${randomUUID()}`);
  await page.goto(`${APP}/app`);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Private test identity', exact: true })).toBeVisible();
  await page.getByRole('button', { name: account.buttonName, exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeAttached();
  const response = await page.request.get(`${APP}/api/v1/me`); expect(response.status()).toBe(200);
  const me = await response.json() as { data: { actor: { id: string; kind: string }; authMode: string } };
  expect(me.data.actor.kind).toBe('real'); expect(me.data.authMode).toBe('shared');
  const workspaces = (await read(page, '/api/v1/workspaces', workspaceListResponseSchema)).data;
  expect(workspaces).toHaveLength(1); expect(workspaces[0]?.role).toBe('owner');
  return { actorId: me.data.actor.id, workspace: required(workspaces[0]) };
}
async function fixture(page: Page, label: string, existing?: { workspaceId: string; actorId: string }): Promise<Fixture> {
  let owner: { workspaceId: string; actorId: string };
  if (existing !== undefined) owner = existing;
  else {
    const signedIn = await login(page, label);
    owner = { workspaceId: signedIn.workspace.id, actorId: signedIn.actorId };
  }
  const prefix = `/api/v1/workspaces/${owner.workspaceId}`;
  const members = (await read(page, `${prefix}/memberships`, membershipListResponseSchema)).data;
  const member = required(members.find(value => value.userId === owner.actorId));
  const project = (await write(page, `${prefix}/projects`, { name: `${label} ${randomUUID()}` }, projectResponseSchema)).data;
  const statuses = (await read(page, `${prefix}/projects/${project.id}/statuses`, taskStatusListResponseSchema)).data;
  return { page, workspaceId: owner.workspaceId, prefix, projectId: project.id, member,
    statusId: required(statuses.find(value => value.group === 'todo')).id,
    doneId: required(statuses.find(value => value.group === 'done')).id };
}
async function create(f: Fixture, title: string, extras: Record<string, unknown> = {}): Promise<TaskDto> {
  return (await write(f.page, `${f.prefix}/tasks`, { projectId: f.projectId, statusId: f.statusId, title, ...extras }, taskResponseSchema)).data;
}
async function tasks(f: Fixture): Promise<TaskDto[]> {
  const response = await read(f.page, `${f.prefix}/tasks?projectId=${f.projectId}&includeArchived=true&limit=200`, taskListResponseSchema);
  expect(response.meta.nextCursor ?? null).toBeNull(); return response.data;
}
const ordered = (rows: readonly TaskDto[]) => [...rows].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
const names = (rows: readonly TaskDto[]) => ordered(rows).map(row => row.title);
async function openProject(f: Fixture, query = '') {
  await f.page.goto(`${APP}/app/w/${f.workspaceId}/projects/${f.projectId}?view=table${query}`);
  await expect(f.page.getByRole('button', { name: 'Add task without a section', exact: true })).toBeVisible();
}
/** Choose an explicit personal view before staging a draft; defaults deliberately hide Priority. */
async function showColumns(page: Page, labels: readonly string[]) {
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'My task columns', exact: true });
  let changed = false;
  for (const label of labels) {
    const choice = dialog.getByRole('checkbox', { name: label, exact: true });
    await expect(choice).toBeEnabled();
    if (!await choice.isChecked()) { await choice.check(); changed = true; }
    await expect(choice).toBeChecked();
  }
  if (changed) {
    await dialog.getByRole('button', { name: 'Save columns', exact: true }).click();
    await expect(dialog.getByText('Columns saved. Current settings refreshed.', { exact: true })).toBeVisible();
  }
  await dialog.press('Escape'); await expect(dialog).toHaveCount(0);
}
async function after(f: Fixture, task: TaskDto) {
  await realRow(f.page, task.id).locator(`button[data-task-cell="${task.id}:title"]`).click();
  const editor = realRow(f.page, task.id).getByRole('textbox', { name: 'Task name', exact: true });
  await expect(editor).toHaveValue(task.title); await editor.press('Enter');
  await expect(titleInput(f.page)).toBeFocused();
}
async function assertBetween(page: Page, before: string, afterId: string) {
  expect(await page.locator('tbody').filter({ has: realRow(page, before) }).evaluate((body, ids) => {
    const rows = Array.from(body.querySelectorAll('tr'));
    const a = rows.findIndex(row => row.getAttribute('data-task-row') === ids[0]);
    const b = rows.findIndex(row => row.getAttribute('data-task-row') === ids[1]);
    const d = rows.findIndex(row => row.getAttribute('data-task-draft-state') === 'draft');
    return a >= 0 && a < d && d < b;
  }, [before, afterId])).toBe(true);
}
async function geometry(saved: Locator, draft: Locator) {
  const measure = (row: Locator) => row.evaluate(element => ({ height: element.getBoundingClientRect().height,
    cells: Array.from(element.querySelectorAll(':scope > td')).map(cell => cell.getBoundingClientRect().width) }));
  const a = await measure(saved), b = await measure(draft);
  expect(Math.abs(a.height - 41)).toBeLessThanOrEqual(1); expect(Math.abs(b.height - 41)).toBeLessThanOrEqual(1);
  expect(b.cells.length).toBe(a.cells.length);
  a.cells.forEach((width, i) => expect(Math.abs(width - required(b.cells[i]))).toBeLessThanOrEqual(1));
}
function commands(page: Page, prefix: string) {
  const found: Command[] = [];
  const listener = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith(prefix) && ['POST', 'PATCH', 'PUT', 'DELETE'].includes(request.method())) {
      found.push({ path, method: request.method(), body: request.postData() ?? '', key: request.headers()['idempotency-key'] });
    }
  };
  page.on('request', listener);
  return { found, close: () => page.off('request', listener) };
}
async function point(locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); const box = await locator.boundingBox();
  if (!box) throw new Error('Actual mouse target is not visible.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
type DropCue = 'valid' | 'none';
type LiveDrop = { hit: boolean; half: 'before' | 'after' | null; drop: string | null; anyDrop: boolean };
async function frames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
function liveDrop(cell: Element, at: { x: number; y: number }): LiveDrop {
  // The real hit under the held pointer, ignoring the ghost, must be the intended row's own element.
  const own = cell.closest('tr[data-task-row]');
  const hit = document.elementsFromPoint(at.x, at.y).find(element => !element.closest('[data-task-drag-preview]'));
  const row = hit?.closest('tr[data-task-row]') ?? null;
  const rect = row?.getBoundingClientRect();
  const marked = own?.matches('[data-task-drop]') ? own : own?.querySelector('[data-task-drop]');
  return { hit: row !== null && row === own, half: rect ? (at.y < rect.top + rect.height / 2 ? 'before' : 'after') : null,
    drop: marked?.getAttribute('data-task-drop') ?? null, anyDrop: document.querySelector('[data-task-drop]') !== null };
}
function settled(live: LiveDrop | undefined, placement: 'before' | 'after', cue: DropCue) {
  return live !== undefined && live.hit && live.half === placement && (cue === 'valid' ? live.drop === placement : !live.anyDrop);
}
async function drag(page: Page, id: string, targetId: string, placement: 'before' | 'after', escape = false, scope: Page | Locator = page, cue: DropCue = 'valid') {
  // Hover reveals the normal move control; drop halves come from the actual saved title cell.
  const target = scope.locator(`tr[data-task-row="${targetId}"] > td:first-child`);
  await target.scrollIntoViewIfNeeded();
  await scope.locator(`tr[data-task-row="${id}"] > td:first-child`).hover();
  const handle = scope.locator(`[data-task-move-handle="${id}"]`);
  await expect(handle).toBeEnabled(); await expect(handle).not.toHaveAttribute('aria-disabled', 'true');
  // Measured after the last pre-drag scroll, so mouse-down lands on the fresh handle center.
  const from = await point(handle);
  const preview = page.getByTestId('task-drag-preview');
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  try {
    await page.mouse.move(from.x + 9, from.y, { steps: 3 }); await frames(page);
    await expect(preview).toBeVisible(); await expect(preview).toHaveAttribute('data-task-drag-preview', id);
    // Edge autoscroll is intentional, so the same held pointer follows the target's live geometry.
    let at = { x: from.x + 9, y: from.y }; let live: LiveDrop | undefined;
    for (let move = 0; move <= 5 && !settled(live, placement, cue); move++) {
      const box = await target.boundingBox();
      if (!box) throw new Error(`Saved title cell ${targetId} is not measurable during the held drag.`);
      at = { x: box.x + box.width / 2, y: box.y + box.height * (placement === 'before' ? 0.25 : 0.75) };
      await page.mouse.move(at.x, at.y, { steps: move === 0 ? 12 : 3 }); await frames(page);
      live = await target.evaluate(liveDrop, at);
    }
    if (!settled(live, placement, cue)) throw new Error(`Held drag did not settle ${placement} ${targetId} after 5 corrections: ${JSON.stringify(live)}`);
    await expect(preview).toBeVisible(); await expect(preview).toHaveAttribute('data-task-drag-preview', id);
    expect(await target.evaluate(liveDrop, at)).toMatchObject(cue === 'valid'
      ? { hit: true, half: placement, drop: placement } : { hit: true, half: placement, drop: null, anyDrop: false });
    if (cue === 'none') { await expect(scope.locator('[data-task-drop]')).toHaveCount(0); await expect(page.locator('[data-task-drop]')).toHaveCount(0); }
    if (escape) await page.keyboard.press('Escape');
  } finally { await page.mouse.up(); }
  await expect(preview).toBeHidden();
}
async function picker(page: Page, row: Locator, label: string, choice: string) {
  await row.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: choice, exact: true }).click();
}
async function extrasFixture(f: Fixture) {
  const field = async (name: string, type: 'text' | 'number') => (await write(f.page, `${f.prefix}/fields`, { projectId: f.projectId, name, type }, taskFieldDefinitionResponseSchema)).data;
  const text = await field('Native note', 'text'), number = await field('Native zero', 'number');
  const columns = (await read(f.page, `${f.prefix}/projects/${f.projectId}/columns`, projectColumnsResponseSchema)).data;
  await write(f.page, `${f.prefix}/projects/${f.projectId}/columns`, { expectedRevision: columns.revision,
    columns: [text, number].map((value, position) => ({ fieldId: value.id, visible: true, width: 160, position })) }, projectColumnsResponseSchema, 'PATCH');
  const date = new Date(); date.setUTCDate(date.getUTCDate() + 28);
  const localStart = date.toISOString().slice(0, 10);
  const cutoff = new Date(date); cutoff.setUTCDate(cutoff.getUTCDate() + 6);
  const period = (await write(f.page, `${f.prefix}/periods`, { projectId: f.projectId, name: 'Native future week', localStart, timezone: 'UTC', cutoffAt: cutoff.toISOString() }, planningPeriodResponseSchema)).data;
  return { text, number, period };
}
async function fillCustom(page: Page, field: TaskFieldDefinitionDto, value: string) {
  const label = `${field.name} for the new task`;
  await draftRow(page).getByRole('button', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: label, exact: true });
  await dialog.getByLabel(field.name, { exact: true }).fill(value);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
}
async function submit(page: Page, title: string) {
  await titleInput(page).fill(title); await titleInput(page).press('Enter');
}

// Serial is intentional: one provider key for the API's cached JWKS, no worker restart/new-key cascade.
test.describe('Asana task list insertion on private shared Auth', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP || info.config.workers !== 1) throw new Error('Explicit private QA49318 and one worker are required.');
    if (info.project.use.trace !== 'off') throw new Error('Auth native acceptance requires trace off.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });
  test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 960 }); });

  test('Enter in B creates full rows X,Y exactly between B and C and Escape leaves no ghost', async ({ page }) => {
    const f = await fixture(page, 'Root insertion');
    const a = await create(f, 'A'), b = await create(f, 'B'), c = await create(f, 'C');
    await openProject(f); await showColumns(page, ['Priority']);
    const writes = commands(page, f.prefix);
    await after(f, b); await assertBetween(page, b.id, c.id); await geometry(realRow(page, b.id), draftRow(page));
    expect(writes.found).toEqual([]); expect(names(await tasks(f))).toEqual(['A', 'B', 'C']);
    await picker(page, draftRow(page), 'Status', 'In progress');
    await picker(page, draftRow(page), 'Assignee', f.member.displayName);
    await picker(page, draftRow(page), 'Priority', 'High');
    await setDraftDueDate(page, '2035-04-06');
    await draftRow(page).getByRole('textbox', { name: 'Team estimate (hours)', exact: true }).fill('1.5');
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    await page.route(`**${f.prefix}/tasks`, async route => {
      if (route.request().method() !== 'POST' || held) return route.continue();
      held = true; const response = await route.fetch(); expect(response.status()).toBe(201); await gate; await route.fulfill({ response });
    });
    const scroll = await page.evaluate(() => window.scrollY);
    try {
      await submit(page, 'X');
      await expect(page.locator('tr[data-task-draft-state="pending"]')).toContainText('X');
      await expect(titleInput(page)).toBeFocused(); await titleInput(page).fill('Y');
      await titleInput(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(0, 1));
      expect(await titleInput(page).evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(0);
      await titleInput(page).press('Enter'); await expect(titleInput(page)).toBeFocused();
      expect(Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThanOrEqual(2);
      expect(writes.found.filter(value => value.path === `${f.prefix}/tasks`)).toHaveLength(1);
    } finally { release(); }
    await expect.poll(async () => names(await tasks(f))).toEqual(['A', 'B', 'X', 'Y', 'C']);
    await titleInput(page).press('Escape'); await expect(draftRow(page)).toHaveCount(0);
    const result = await tasks(f), x = required(result.find(value => value.title === 'X'));
    expect(x.responsibleMembershipId).toBe(f.member.id); expect(x.priority).toBe('high'); expect(x.dueDate).toBe('2035-04-06'); expect(x.estimateMinutes).toBe(90);
    expect(result.find(value => value.id === a.id)).toEqual(a); expect(result.find(value => value.id === b.id)?.title).toBe('B');
    expect(writes.found.filter(value => value.path === `${f.prefix}/tasks`)).toHaveLength(2);
    await page.reload(); await expect(realRow(page, x.id)).toBeVisible(); expect(names(await tasks(f))).toEqual(['A', 'B', 'X', 'Y', 'C']); writes.close();
  });

  test('child Enter and primary Add subtask stay inline and preserve the parent package', async ({ page }, testInfo) => {
    const f = await fixture(page, 'Child insertion'); const parent = await create(f, 'Parent', { estimateMinutes: 180 });
    const a = await create(f, 'a', { parentTaskId: parent.id }), b = await create(f, 'b', { parentTaskId: parent.id }), c = await create(f, 'c', { parentTaskId: parent.id });
    const other = await create(f, 'Other root'); await openProject(f);
    await expect(realRow(page, b.id)).toBeVisible();
    await after(f, b); await assertBetween(page, b.id, c.id); await geometry(realRow(page, b.id), draftRow(page));
    const writes = commands(page, f.prefix); await submit(page, 'x'); await submit(page, 'y');
    await expect.poll(async () => names((await tasks(f)).filter(value => value.parentTaskId === parent.id))).toEqual(['a', 'b', 'x', 'y', 'c']);
    await titleInput(page).press('Escape');
    const rows = await tasks(f), children = rows.filter(value => value.parentTaskId === parent.id);
    expect(children.every(value => value.workPackageId === parent.workPackageId && value.estimateMinutes === 180)).toBe(true);
    expect(rows.find(value => value.id === other.id)?.title).toBe(other.title); expect(rows.find(value => value.id === a.id)?.parentTaskId).toBe(parent.id);
    await realRow(page, parent.id).hover();
    await realRow(page, parent.id).getByRole('button', { name: 'Task actions: Parent', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add subtask', exact: true }).click();
    await expect(titleInput(page)).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
    await geometry(realRow(page, b.id), draftRow(page)); await titleInput(page).fill('Discard child'); await titleInput(page).press('Escape');
    await expect(draftRow(page)).toHaveCount(0); expect((await tasks(f)).some(value => value.title === 'Discard child')).toBe(false);
    expect(writes.found.filter(value => value.method === 'POST')).toHaveLength(2);
    // The default right-hand details view uses the same normal rows, not an advanced create form.
    await realRow(page, parent.id).locator(`[data-task-open-area="${parent.id}"]`).click();
    await expect(page).toHaveURL(url => url.searchParams.get('task') === parent.id);
    const drawer = page.getByRole('dialog', { name: 'Parent', exact: true });
    await expect(drawer).toBeVisible();
    const subtasks = drawer.getByRole('region', { name: 'Subtasks', exact: true });
    await expect(subtasks.getByRole('table', { name: 'Subtasks', exact: true })).toBeVisible();
    await subtasks.locator('[data-subtask-add]').click();
    const childDraft = subtasks.locator('tr[data-task-draft-state="draft"]');
    const childInput = childDraft.getByRole('textbox', { name: 'Task name', exact: true });
    await expect(childInput).toBeFocused();
    await geometry(subtasks.locator(`tr[data-task-row="${b.id}"]`), childDraft);
    // Passive fixture-only diagnostics: no actionability waits, product state or command changes.
    const childStarted = performance.now(); let childSequence = 0;
    const childDiagnostic = (kind: string, data: Record<string, unknown> = {}) => console.log(`INSERTION_CHILD ${JSON.stringify({ sequence: ++childSequence, elapsedMs: Math.round(performance.now() - childStarted), kind, ...data })}`);
    const browserPrefix = 'INSERTION_CHILD_BROWSER ';
    page.on('console', message => { if (message.text().startsWith(browserPrefix)) childDiagnostic('browser', { event: JSON.parse(message.text().slice(browserPrefix.length)) as unknown }); });
    const childRequest = (request: Request): Record<string, unknown> | null => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'GET' && path === `${f.prefix}/tasks/${parent.id}`) return { operation: 'parent-read' };
      if (request.method() !== 'POST' || path !== `${f.prefix}/tasks`) return null;
      const body = request.postDataJSON() as Record<string, unknown>;
      if (body.title !== 'd' && body.title !== 'e') return null;
      const insertion = body.insertion as { anchorTaskId?: unknown; placement?: unknown } | undefined;
      return { operation: 'child-create', title: body.title, expectedParent: body.parentTaskId === parent.id,
        expectedParentRevision: typeof body.expectedParentRevision === 'number' ? body.expectedParentRevision : null,
        anchorTaskId: typeof insertion?.anchorTaskId === 'string' ? insertion.anchorTaskId : null,
        placement: insertion?.placement === 'before' || insertion?.placement === 'after' ? insertion.placement : null };
    };
    page.on('request', request => { const data = childRequest(request); if (data) childDiagnostic('request', data); });
    page.on('response', response => { const data = childRequest(response.request()); if (data) childDiagnostic('response', { ...data, status: response.status() }); });
    await subtasks.evaluate(section => {
      const identities = new WeakMap<HTMLInputElement, number>(); let nextIdentity = 0;
      const snapshot = (input: HTMLInputElement | null) => {
        if (!input) return null;
        let identity = identities.get(input); if (identity === undefined) { identity = ++nextIdentity; identities.set(input, identity); }
        return { identity, value: input.value === '' || input.value === 'd' || input.value === 'e' ? input.value : { length: input.value.length },
          connected: input.isConnected, enabled: !input.disabled && !input.readOnly, focused: document.activeElement === input };
      };
      const current = () => section.querySelector<HTMLInputElement>('tr[data-task-draft-state="draft"] input[aria-label="Task name"]');
      const capture = (event: Event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || (!identities.has(target) && target !== current())) return;
        const key = event instanceof KeyboardEvent ? event.key === 'Enter' || event.key === 'Escape' ? event.key : 'other' : null;
        const record = (phase: string) => console.log(`INSERTION_CHILD_BROWSER ${JSON.stringify({ phase, event: event.type, key, target: snapshot(target), current: snapshot(current()) })}`);
        record('capture'); queueMicrotask(() => record('after-event'));
      };
      snapshot(current());
      for (const type of ['input', 'change', 'keydown', 'focusin', 'focusout']) document.addEventListener(type, capture, true);
    });
    childDiagnostic('baseline', { parentRevision: parent.revision, parentWorkPackageRevision: parent.workPackageRevision });
    childDiagnostic('before-d-fill'); await childInput.fill('d'); childDiagnostic('after-d-fill');
    childDiagnostic('before-d-enter'); await childInput.press('Enter'); childDiagnostic('after-d-enter');
    await expect(childInput).toBeFocused();
    childDiagnostic('before-e-fill'); await childInput.fill('e'); childDiagnostic('after-e-fill');
    childDiagnostic('before-e-enter'); await childInput.press('Enter'); childDiagnostic('after-e-enter');
    await expect.poll(async () => names((await tasks(f)).filter(value => value.parentTaskId === parent.id))).toEqual(['a', 'b', 'x', 'y', 'c', 'd', 'e']);
    await childInput.press('Escape'); await expect(childDraft).toHaveCount(0);
    const createdChildren = (await tasks(f)).filter(value => value.parentTaskId === parent.id);
    const d = required(createdChildren.find(value => value.title === 'd')), e = required(createdChildren.find(value => value.title === 'e'));
    await drag(page, e.id, d.id, 'before', false, subtasks);
    await expect.poll(async () => names((await tasks(f)).filter(value => value.parentTaskId === parent.id))).toEqual(['a', 'b', 'x', 'y', 'c', 'e', 'd']);
    const dRow = subtasks.locator(`tr[data-task-row="${d.id}"]`);
    expect(Math.abs(await dRow.evaluate(row => row.getBoundingClientRect().height) - 41)).toBeLessThanOrEqual(1);
    const completeChild = dRow.getByRole('button', { name: 'Mark d complete', exact: true });
    expect(required(await completeChild.boundingBox() ?? undefined).height).toBeLessThanOrEqual(32);
    await completeChild.click(); await expect.poll(async () => (await tasks(f)).find(value => value.id === d.id)?.statusId).toBe(f.doneId);
    expect(Math.abs(await dRow.evaluate(row => row.getBoundingClientRect().height) - 41)).toBeLessThanOrEqual(1);
    const final = (await tasks(f)).filter(value => value.parentTaskId === parent.id);
    expect(final.every(value => value.workPackageId === parent.workPackageId && value.estimateMinutes === 180)).toBe(true);
    expect(writes.found.filter(value => value.path === `${f.prefix}/tasks` && value.method === 'POST')).toHaveLength(4);
    await drawer.screenshot({ path: testInfo.outputPath('drawer-subtasks.png') });
    // Escape outside the desktop nonmodal pane belongs to the task table.
    const parentName = drawer.getByRole('textbox', { name: 'Task name', exact: true });
    await expect(parentName).toBeEnabled();
    await parentName.click(); await expect(parentName).toBeFocused();
    await page.keyboard.press('Escape'); await expect(drawer).toHaveCount(0);
    await page.reload(); expect(names((await tasks(f)).filter(value => value.parentTaskId === parent.id))).toEqual(['a', 'b', 'x', 'y', 'c', 'e', 'd']); writes.close();
  });

  test('continued child rows preserve queued and unsubmitted titles across both real held create acknowledgements', async ({ page }) => {
    const f = await fixture(page, 'Held child continuation');
    const parent = await create(f, 'Parent', { estimateMinutes: 180 });
    const seed = await create(f, 'a', { parentTaskId: parent.id, workScope: 'detail' });
    const other = await create(f, 'Other root'); await openProject(f);
    await realRow(page, parent.id).locator(`[data-task-open-area="${parent.id}"]`).click();
    const drawer = page.getByRole('dialog', { name: 'Parent', exact: true });
    const subtasks = drawer.getByRole('region', { name: 'Subtasks', exact: true });
    await expect(subtasks.getByRole('table', { name: 'Subtasks', exact: true })).toBeVisible();
    await subtasks.locator('[data-subtask-add]').click();
    const childDraft = subtasks.locator('tr[data-task-draft-state="draft"]');
    const input = childDraft.getByRole('textbox', { name: 'Task name', exact: true });
    await expect(input).toBeFocused(); const original = required(await input.elementHandle() ?? undefined);
    let releaseD!: () => void, releaseF!: () => void;
    const dGate = new Promise<void>(resolve => { releaseD = resolve; });
    const fGate = new Promise<void>(resolve => { releaseF = resolve; });
    let committedD: TaskDto | undefined, committedF: TaskDto | undefined;
    let parentReads = 0, siblingReads = 0;
    page.on('response', response => {
      if (response.request().method() !== 'GET' || response.status() !== 200) return;
      const path = new URL(response.url()).pathname;
      if (path === `${f.prefix}/tasks/${parent.id}`) parentReads++;
      if (path === `${f.prefix}/tasks`) siblingReads++;
    });
    await page.route(`**${f.prefix}/tasks`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON() as { title?: string };
      if (body.title !== 'd' && body.title !== 'f') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(201);
      const committed = taskResponseSchema.parse(await response.json()).data;
      if (body.title === 'd') { committedD = committed; await dGate; }
      else { committedF = committed; await fGate; }
      await route.fulfill({ response });
    });
    const writes = commands(page, f.prefix);
    try {
      // D exists on the real server, but its browser ACK remains held while E is submitted.
      await input.fill('d'); await input.press('Enter');
      await expect.poll(() => committedD?.id).not.toBeUndefined();
      await expect(subtasks.locator('tr[data-task-draft-state="pending"]')).toContainText('d');
      await expect(input).toBeFocused(); await expect(input).toHaveValue('');
      await input.fill('e'); await input.press('Enter');
      await expect(input).toBeFocused(); await expect(input).toHaveValue('');
      expect(await input.evaluate((node, first) => node === first, original)).toBe(true);
      expect(writes.found).toHaveLength(1);
      expect(names((await tasks(f)).filter(row => row.parentTaskId === parent.id))).toEqual(['a', 'd']);
      releaseD();
      await expect.poll(async () => names((await tasks(f)).filter(row => row.parentTaskId === parent.id))).toEqual(['a', 'd', 'e']);
      await expect(subtasks.getByRole('button', { name: 'e', exact: true })).toBeVisible();
      const afterE = await tasks(f), e = required(afterE.find(row => row.title === 'e'));
      expect(writes.found).toHaveLength(2);

      // F ACK arrives between typing G and Enter: the same live input must retain G.
      await input.fill('f'); await input.press('Enter');
      await expect.poll(() => committedF?.id).not.toBeUndefined();
      await expect(input).toBeFocused(); await input.fill('g'); await expect(input).toHaveValue('g');
      const beforeAck = { parentReads, siblingReads };
      expect(writes.found).toHaveLength(3); releaseF();
      await expect.poll(() => parentReads).toBeGreaterThan(beforeAck.parentReads);
      await expect.poll(() => siblingReads).toBeGreaterThan(beforeAck.siblingReads);
      await expect(subtasks.getByRole('button', { name: 'f', exact: true })).toBeVisible();
      expect(await input.evaluate((node, first) => node === first, original)).toBe(true);
      await expect(input).toHaveValue('g'); await expect(input).toBeFocused();
      expect(writes.found).toHaveLength(3);
      await input.press('Enter');
      await expect.poll(async () => names((await tasks(f)).filter(row => row.parentTaskId === parent.id))).toEqual(['a', 'd', 'e', 'f', 'g']);
      await expect(subtasks.getByRole('button', { name: 'g', exact: true })).toBeVisible();
      const d = required(committedD), fTask = required(committedF);
      const bodies = ['d', 'e', 'f', 'g'].map((title, index) => ({ projectId: f.projectId, parentTaskId: parent.id, workScope: 'detail', title, statusId: f.statusId,
        ...(index === 0 ? {} : { insertion: { anchorTaskId: required([d.id, e.id, fTask.id][index - 1]), placement: 'after' } }) }));
      expect(writes.found).toHaveLength(4);
      expect(writes.found.map(command => ({ method: command.method, path: command.path, body: JSON.parse(command.body) as unknown })))
        .toEqual(bodies.map(body => ({ method: 'POST', path: `${f.prefix}/tasks`, body })));
      const keys = writes.found.map(command => command.key); expect(keys.every(key => typeof key === 'string' && key.length > 0)).toBe(true);
      expect(new Set(keys).size).toBe(4);
      const confirmed = await tasks(f); expect(confirmed).toHaveLength(7);
      expect(confirmed.find(row => row.id === parent.id)).toEqual(parent);
      expect(confirmed.find(row => row.id === seed.id)).toEqual(seed); expect(confirmed.find(row => row.id === other.id)).toEqual(other);
      const children = confirmed.filter(row => row.parentTaskId === parent.id);
      expect(new Set(children.map(row => row.id)).size).toBe(5);
      expect(children.every(row => row.workPackageId === parent.workPackageId && row.estimateMinutes === 180)).toBe(true);
      await expect(input).toBeFocused(); await input.fill('Discard next child'); await input.press('Escape');
      await expect(childDraft).toHaveCount(0); await expect(drawer).toBeVisible();
      expect(writes.found).toHaveLength(4); expect(await tasks(f)).toEqual(confirmed);
    } finally { releaseD(); releaseF(); writes.close(); }
  });

  test('real mouse root cross-section and child moves persist; cancelled and adjacent moves conserve sources', async ({ page }) => {
    const f = await fixture(page, 'Pointer ordering');
    const section = (await write(page, `${f.prefix}/projects/${f.projectId}/sections`, { name: 'Second section' }, sectionResponseSchema)).data;
    const a = await create(f, 'A', { estimateMinutes: 90, startDate: '2035-01-01', dueDate: '2035-01-03' });
    const b = await create(f, 'B'), c = await create(f, 'C', { sectionId: section.id });
    const parent = await create(f, 'Parent', { estimateMinutes: 120 });
    const x = await create(f, 'x', { parentTaskId: parent.id }), y = await create(f, 'y', { parentTaskId: parent.id });
    await openProject(f); const writes = commands(page, f.prefix);
    await drag(page, b.id, a.id, 'before'); await expect.poll(async () => names((await tasks(f)).filter(value => value.parentTaskId === null))).toEqual(['B', 'A', 'C', 'Parent']);
    await drag(page, a.id, c.id, 'after'); await expect.poll(async () => (await tasks(f)).find(value => value.id === a.id)?.sectionId).toBe(section.id);
    await expect(realRow(page, x.id)).toBeVisible();
    await drag(page, y.id, x.id, 'before'); await expect.poll(async () => names((await tasks(f)).filter(value => value.parentTaskId === parent.id))).toEqual(['y', 'x']);
    const before = ordered(await tasks(f)); const moveCount = writes.found.length;
    await drag(page, b.id, parent.id, 'after', true); await drag(page, b.id, b.id, 'before', false, page, 'none');
    expect(writes.found).toHaveLength(moveCount); expect(ordered(await tasks(f))).toEqual(before);
    // An adjacent command may save a receipt, but cannot change positions or business revisions.
    await drag(page, y.id, x.id, 'before', false, page, 'none'); expect(ordered(await tasks(f))).toEqual(before);
    const moved = required(before.find(value => value.id === a.id));
    expect({ parent: moved.parentTaskId, package: moved.workPackageId, estimate: moved.estimateMinutes, start: moved.startDate, due: moved.dueDate })
      .toEqual({ parent: a.parentTaskId, package: a.workPackageId, estimate: 90, start: '2035-01-01', due: '2035-01-03' });
    expect(before.filter(value => value.parentTaskId === parent.id).every(value => value.workPackageId === parent.workPackageId && value.estimateMinutes === 120)).toBe(true);
    await page.reload(); expect(ordered(await tasks(f))).toEqual(before);
    await page.getByRole('combobox', { name: 'Sort', exact: true }).click(); await page.getByRole('option', { name: 'Due date', exact: true }).click();
    await expect(page.locator('[data-task-move-handle]:enabled')).toHaveCount(0); writes.close();
  });

  test('name text edits in place, right free area opens details, and completion keeps row geometry', async ({ page }) => {
    const f = await fixture(page, 'Row actions'); const task = await create(f, 'Name area'); await openProject(f);
    await realRow(page, task.id).locator(`[data-task-cell="${task.id}:title"]`).click();
    await expect(realRow(page, task.id).getByRole('textbox', { name: 'Task name', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0); await page.keyboard.press('Escape');
    expect((await tasks(f))[0]?.title).toBe(task.title);
    await realRow(page, task.id).locator(`[data-task-open-area="${task.id}"]`).click();
    await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const before = await realRow(page, task.id).evaluate(row => ({ height: row.getBoundingClientRect().height, widths: Array.from(row.children).map(cell => cell.getBoundingClientRect().width) }));
    const complete = realRow(page, task.id).getByRole('button', { name: 'Mark Name area complete', exact: true });
    const buttonBox = await complete.boundingBox(); expect(required(buttonBox ?? undefined).height).toBeLessThanOrEqual(32);
    await complete.click(); await expect.poll(async () => (await tasks(f))[0]?.statusId).toBe(f.doneId);
    const afterGeometry = await realRow(page, task.id).evaluate(row => ({ height: row.getBoundingClientRect().height, widths: Array.from(row.children).map(cell => cell.getBoundingClientRect().width) }));
    expect(Math.abs(afterGeometry.height - 41)).toBeLessThanOrEqual(1); expect(afterGeometry).toEqual(before);
  });

  test('custom fields and explicit weekly zero facts create atomically; lost ACK retries the exact command', async ({ page }) => {
    const f = await fixture(page, 'Atomic row'); const a = await create(f, 'A'), b = await create(f, 'B');
    const extra = await extrasFixture(f); await openProject(f, `&week=${extra.period.id}&worker=${f.member.id}`);
    await showColumns(page, [extra.text.name, extra.number.name, 'Personal weekly plan', 'Personal actual hours']);
    await after(f, a);
    const writes = commands(page, f.prefix);
    await fillCustom(page, extra.text, 'Kept custom text'); await fillCustom(page, extra.number, '0');
    await draftRow(page).getByRole('textbox', { name: `Planned hours for the new task: ${extra.period.name}, ${f.member.displayName}`, exact: true }).fill('1.5');
    await draftRow(page).getByRole('textbox', { name: `Actual hours for the new task: ${extra.period.name}, ${f.member.displayName}`, exact: true }).fill('0');
    // An entirely unsent row can be discarded without any task, field, package or time command.
    await titleInput(page).fill('Discard all values'); await titleInput(page).press('Escape'); await expect(draftRow(page)).toHaveCount(0);
    expect(writes.found).toEqual([]); expect(names(await tasks(f))).toEqual(['A', 'B']);
    await after(f, a); await expect(titleInput(page)).toHaveValue('');
    await fillCustom(page, extra.text, 'Kept custom text'); await fillCustom(page, extra.number, '0');
    await draftRow(page).getByRole('textbox', { name: /^Planned hours for the new task:/ }).fill('1.5');
    await draftRow(page).getByRole('textbox', { name: /^Actual hours for the new task:/ }).fill('0');
    let lost = false, retryHeld = false;
    let releaseRetry!: () => void; const retryGate = new Promise<void>(resolve => { releaseRetry = resolve; });
    await page.route(`**${f.prefix}/tasks/rows`, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(201);
      if (!lost) { lost = true; return route.abort('failed'); }
      retryHeld = true; await retryGate; await route.fulfill({ response });
    });
    await submit(page, 'Atomic X');
    await expect(page.getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    await expect(page.locator('tr[data-task-draft-state="uncertain"]')).toContainText('Atomic X');
    const handles = page.locator('[data-task-move-handle]');
    await expect(handles).toHaveCount(2);
    for (const handle of await handles.all()) await expect(handle).toBeDisabled();
    expect(writes.found).toHaveLength(1); const original = required(writes.found[0]);
    const beforeBlockedDrag = ordered(await tasks(f));
    // aria-disabled handles stay focusable for explanation. Actually try the blocked pointer path;
    // the ordinary drag helper intentionally waits for an enabled handle and cannot probe this.
    await realRow(page, a.id).locator('td:first-child').hover();
    const blockedFrom = await point(page.locator(`[data-task-move-handle="${a.id}"]`));
    const blockedTarget = realRow(page, b.id).locator('td:first-child');
    await blockedTarget.scrollIntoViewIfNeeded();
    const blockedBox = await blockedTarget.boundingBox();
    if (!blockedBox) throw new Error('Saved target row is not visible for the blocked mouse probe.');
    await page.mouse.move(blockedFrom.x, blockedFrom.y); await page.mouse.down();
    try {
      await page.mouse.move(blockedFrom.x + 9, blockedFrom.y, { steps: 3 });
      await page.mouse.move(blockedBox.x + blockedBox.width / 2, blockedBox.y + blockedBox.height * 0.75, { steps: 12 });
    } finally { await page.mouse.up(); }
    expect(writes.found).toHaveLength(1); expect(writes.found[0]).toEqual(original);
    expect(ordered(await tasks(f))).toEqual(beforeBlockedDrag);
    await expect(page.locator('tr[data-task-draft-state="uncertain"]')).toContainText('Atomic X');
    await expect(page.getByRole('button', { name: 'Retry original', exact: true })).toBeVisible();
    expect(original.path).toBe(`${f.prefix}/tasks/rows`); expect(original.key?.length).toBeGreaterThan(0);
    const committed = required((await tasks(f)).find(value => value.title === 'Atomic X'));
    await titleInput(page).fill('Next unsent buffer'); await titleInput(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 6));
    try {
      await page.getByRole('button', { name: 'Retry original', exact: true }).click();
      await expect.poll(() => retryHeld).toBe(true);
      // Explicit Retry owns its click focus. A newer user input then owns the eventual ACK.
      await titleInput(page).focus(); await titleInput(page).evaluate((input: HTMLInputElement) => input.setSelectionRange(2, 6));
    } finally { releaseRetry(); }
    await expect(page.locator('tr[data-task-draft-state="uncertain"]')).toHaveCount(0);
    await expect(titleInput(page)).toHaveValue('Next unsent buffer'); await expect(titleInput(page)).toBeFocused();
    expect(await titleInput(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([2, 6]);
    expect(writes.found).toHaveLength(2); expect(writes.found[1]).toEqual(original);
    const rows = await tasks(f); expect(rows.filter(value => value.title === 'Atomic X')).toHaveLength(1); expect(names(rows)).toEqual(['A', 'Atomic X', 'B']);
    const values = (await read(page, `${f.prefix}/tasks/${committed.id}/field-values`, taskFieldValueListResponseSchema)).data;
    expect(values.find(value => value.fieldId === extra.text.id)?.value).toEqual({ type: 'text', value: 'Kept custom text' });
    expect(values.find(value => value.fieldId === extra.number.id)?.value).toEqual({ type: 'number', value: 0 });
    const plans = (await read(page, `${f.prefix}/periods/${extra.period.id}/commitments`, periodCommitmentListResponseSchema)).data;
    const plan = required(plans.find(value => value.workPackageId === committed.workPackageId && value.membershipId === f.member.id));
    expect(plan.plannedMinutes).toBe(90); expect(plan.allocations).toEqual([]);
    const logs = (await read(page, `${f.prefix}/worklogs?periodId=${extra.period.id}&taskId=${committed.id}&membershipId=${f.member.id}`, manualPeriodWorkLogListResponseSchema)).data;
    expect(logs).toHaveLength(1); expect(logs[0]?.minutes).toBe(0);
    await titleInput(page).press('Escape'); await page.reload(); expect(names(await tasks(f))).toEqual(['A', 'Atomic X', 'B']);
    await expect(realRow(page, committed.id)).toContainText('Kept custom text'); expect((await tasks(f)).find(value => value.id === b.id)?.title).toBe('B'); writes.close();
  });

  test('mobile workspace creation and midlist insertion retain owned rights and table geometry', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); const owner = await login(page, 'Mobile workspace');
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const navigation = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await navigation.getByRole('button', { name: /^Workspace / }).click();
    await page.getByRole('menuitem', { name: 'New workspace', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New workspace', exact: true }); const name = `Mobile owned ${randomUUID()}`;
    await dialog.getByRole('textbox', { name: 'Workspace name', exact: true }).fill(name);
    await dialog.getByLabel('Time zone', { exact: true }).fill('UTC');
    const post = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/workspaces' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create workspace', exact: true }).click(); expect((await post).status()).toBe(201);
    await expect(dialog).toHaveCount(0);
    const workspaces = (await read(page, '/api/v1/workspaces', workspaceListResponseSchema)).data;
    const workspace = required(workspaces.find(value => value.name === name)); expect(workspace.role).toBe('owner'); expect(workspace.timezone).toBe('UTC');
    expect(workspaces.find(value => value.id === owner.workspace.id)?.role).toBe('owner');
    const memberships = (await read(page, `/api/v1/workspaces/${workspace.id}/memberships`, membershipListResponseSchema)).data;
    expect(memberships).toHaveLength(1); expect(memberships[0]?.userId).toBe(owner.actorId);
    expect((await read(page, `/api/v1/workspaces/${workspace.id}/projects`, projectListResponseSchema)).data).toEqual([]);
    const f = await fixture(page, 'Mobile insertion', { workspaceId: workspace.id, actorId: owner.actorId });
    const a = await create(f, 'A'), b = await create(f, 'B'), c = await create(f, 'C');
    await openProject(f); const scroll = await page.evaluate(() => window.scrollY); await after(f, b);
    await assertBetween(page, b.id, c.id); await geometry(realRow(page, b.id), draftRow(page));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await setDraftDueDate(page, '2035-06-02');
    await titleInput(page).scrollIntoViewIfNeeded(); await submit(page, 'X');
    await expect.poll(async () => names(await tasks(f))).toEqual(['A', 'B', 'X', 'C']); await titleInput(page).press('Escape');
    expect(Math.abs(await page.evaluate(() => window.scrollY) - scroll)).toBeLessThanOrEqual(2);
    await page.reload(); expect(names(await tasks(f))).toEqual(['A', 'B', 'X', 'C']);
    expect((await tasks(f)).find(value => value.id === a.id)?.title).toBe('A');
    expect((await tasks(f)).find(value => value.title === 'X')?.dueDate).toBe('2035-06-02');
  });
});
