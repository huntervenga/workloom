// P1a browser acceptance: React project/task UI → Vite /api proxy → Fastify → PostgreSQL.
// Actor, members and statuses come from the live API (see support/live-api.ts); names are unique
// per run. No route mocks or success fixtures: every asserted DTO is a real response parsed with
// the @workloom/contracts schemas. Request-context setup (no UI) is labelled in the test title.
// This is local dev-identity mode on synthetic data; it does not cover real auth.
import { randomUUID } from 'node:crypto';

import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test';
import {
  createTaskInputSchema,
  projectResponseSchema,
  taskResponseSchema,
  taskStatusListResponseSchema,
  updateTaskInputSchema,
  type CreateTaskInput,
  type MembershipDto,
  type ProjectDto,
  type TaskDto,
} from '@workloom/contracts';

import { loadLiveData, type LiveData } from './support/live-api.js';
import { revealTaskDetails, revealTaskFilters, showAllColumns } from './support/disclosures.js';

const RESPONSE_TIMEOUT = 15_000;

let live: LiveData;

test.beforeAll(async ({ request }) => {
  live = await loadLiveData(request);
});

function shortId(): string {
  return randomUUID().slice(0, 8);
}

function workspaceApi(path: string): string {
  return `/api/v1/workspaces/${live.firstWorkspace.id}${path}`;
}

function isApiCall(response: Response, method: string, pathname: string): boolean {
  return response.request().method() === method && new URL(response.url()).pathname === pathname;
}

async function jsonOf(response: Response, status: number): Promise<unknown> {
  const body = await response.text();
  expect(response.status(), `${response.request().method()} ${response.url()}: ${body}`).toBe(status);
  return JSON.parse(body) as unknown;
}

/** Two active members with names unique in the workspace, so checkbox labels are unambiguous. */
function twoMembers(): [MembershipDto, MembershipDto] {
  const { members, firstWorkspace } = live;
  const [first, second] = members;
  if (!first || !second) {
    throw new Error(
      `Workspace "${firstWorkspace.name}" needs at least two active members, got ${members.length}. Run npm run db:seed:demo.`,
    );
  }
  for (const member of [first, second]) {
    expect(members.filter((candidate) => candidate.displayName === member.displayName), member.displayName).toHaveLength(1);
  }
  return [first, second];
}

function expectWritableWorkspace(): void {
  expect(live.firstWorkspace.role, `dev actor "${live.me.actor.displayName}" must be able to create tasks`).not.toBe(
    'viewer',
  );
}

function activeIds(task: TaskDto): string[] {
  return task.participants.filter((row) => row.active).map((row) => row.membershipId).sort();
}

function inactiveIds(task: TaskDto): string[] {
  return task.participants.filter((row) => !row.active).map((row) => row.membershipId).sort();
}

async function apiGet<T>(request: APIRequestContext, path: string, schema: { parse(value: unknown): T }): Promise<T> {
  const response = await request.get(path, { headers: { accept: 'application/json' } });
  expect(response.status(), `GET ${path}: ${await response.text()}`).toBe(200);
  return schema.parse(await response.json());
}

/** Same-origin JSON create through the Vite proxy, as the browser sends it. */
async function apiCreate<T>(
  request: APIRequestContext,
  origin: string,
  path: string,
  body: unknown,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const response = await request.post(path, {
    headers: { accept: 'application/json', origin, 'idempotency-key': randomUUID() },
    data: body,
  });
  expect(response.status(), `POST ${path}: ${await response.text()}`).toBe(201);
  return schema.parse(await response.json());
}

function webOrigin(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('playwright.config.ts must set use.baseURL (web on 127.0.0.1:4311).');
  return new URL(baseURL).origin;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.documentElement.clientWidth,
  }));
  expect(overflow.document, 'page-level horizontal overflow (px)').toBeLessThanOrEqual(0);
  expect(overflow.body, 'body horizontal overflow (px)').toBeLessThanOrEqual(0);
}

function taskTable(page: Page) {
  return page.getByRole('main').getByRole('table');
}

function taskRow(page: Page, title: string) {
  return taskTable(page)
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: title, exact: true }) });
}

/** Rounding tolerance for layout geometry (px). */
const LAYOUT_TOLERANCE = 1;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function viewportRect(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const { left, top, right, bottom } = element.getBoundingClientRect();
    return { left, top, right, bottom };
  });
}

/**
 * The task title, the estimate header, the task's estimate cell and the estimate total lie inside
 * the clipping box of the table's scroll container (`table.parentElement`) and the viewport width,
 * while the container is not scrolled horizontally: the estimate is readable without scrolling.
 * Measured geometry, because Playwright's visibility does not account for overflow clipping.
 */
async function expectEstimateInView(page: Page, title: string): Promise<void> {
  const table = taskTable(page);
  const row = taskRow(page, title);
  const targets: [string, Locator][] = [
    [`title of «${title}»`, row.getByRole('button', { name: title, exact: true })],
    ['estimate column header', table.getByRole('columnheader', { name: "Team estimate", exact: true })],
    [`estimate cell of «${title}»`, row.getByRole('cell').nth(await table.getByRole('columnheader', { name: 'Team estimate', exact: true }).evaluate(element => Array.from(element.parentElement?.children ?? []).indexOf(element)))],
    ['estimate total', table.locator('tfoot').getByRole('cell').last()],
  ];
  for (const [name, target] of targets) {
    await expect(target, name).toBeVisible();
    // One evaluate, so the box, the container clip and its scroll offset are read together.
    const geometry = await target.evaluate((element) => {
      const container = element.closest('table')?.parentElement;
      if (!container) throw new Error('task table has no parent element');
      const box = element.getBoundingClientRect();
      const outer = container.getBoundingClientRect();
      // The padding box without scrollbars is what the container shows.
      const clipLeft = outer.left + container.clientLeft;
      const clipTop = outer.top + container.clientTop;
      return {
        box: { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width },
        clip: {
          left: clipLeft,
          top: clipTop,
          right: clipLeft + container.clientWidth,
          bottom: clipTop + container.clientHeight,
        },
        overflowX: getComputedStyle(container).overflowX,
        scrollLeft: container.scrollLeft,
        viewportWidth: window.innerWidth,
      };
    });
    const { box, clip } = geometry;
    expect(geometry.viewportWidth, 'desktop viewport width').toBe(1440);
    expect(geometry.overflowX, 'task table container clips horizontally').not.toBe('visible');
    expect(geometry.scrollLeft, `${name}: table container is not scrolled horizontally`).toBe(0);
    expect(box.width, `${name}: width`).toBeGreaterThan(0);
    expect(box.left, `${name}: left edge inside the table container`).toBeGreaterThanOrEqual(clip.left - LAYOUT_TOLERANCE);
    expect(box.right, `${name}: right edge inside the table container`).toBeLessThanOrEqual(clip.right + LAYOUT_TOLERANCE);
    expect(box.top, `${name}: top edge inside the table container`).toBeGreaterThanOrEqual(clip.top - LAYOUT_TOLERANCE);
    expect(box.bottom, `${name}: bottom edge inside the table container`).toBeLessThanOrEqual(clip.bottom + LAYOUT_TOLERANCE);
    expect(box.left, `${name}: left edge inside the viewport`).toBeGreaterThanOrEqual(-LAYOUT_TOLERANCE);
    expect(box.right, `${name}: right edge inside the viewport`).toBeLessThanOrEqual(
      geometry.viewportWidth + LAYOUT_TOLERANCE,
    );
  }
}

/** Alpha of the first non-transparent background from the element up: the backdrop it paints over content. */
async function backgroundAlpha(locator: Locator): Promise<{ color: string; alpha: number }> {
  return locator.evaluate((element) => {
    const alphaOf = (color: string): number => {
      if (color === 'transparent') return 0;
      // rgb(a), color(), oklch() and friends: either `/ alpha` or a fourth comma-separated value.
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
      if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
      const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/.exec(color);
      return rgba ? Number(rgba[1]) : 1;
    };
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      const alpha = alphaOf(color);
      if (alpha > 0) return { color, alpha };
    }
    return { color: 'transparent', alpha: 0 };
  });
}

/** The visible box of a field (with its `<label>`s) and of the nearest ancestor that clips it. */
async function fieldGeometry(field: Locator) {
  return field.evaluate((element) => {
    const labels = element instanceof HTMLInputElement && element.labels ? Array.from(element.labels) : [];
    const boxes = [element, ...labels].map((node) => node.getBoundingClientRect());
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    let body = element.parentElement;
    while (body && getComputedStyle(body).overflowY === 'visible') body = body.parentElement;
    if (!body) throw new Error('drawer field has no clipping ancestor');
    const outer = body.getBoundingClientRect();
    const clipTop = outer.top + body.clientTop;
    return {
      top: Math.min(...boxes.map((rect) => rect.top)),
      bottom: Math.max(...boxes.map((rect) => rect.bottom)),
      unobstructed: hit !== null && element.contains(hit),
      body: {
        top: clipTop,
        bottom: clipTop + body.clientHeight,
        scrollTop: body.scrollTop,
        scrollable: body.scrollHeight > body.clientHeight + 1,
      },
    };
  });
}

/**
 * Scrolls a late drawer field into view (this scrolls the form body) and checks that it and its
 * label sit inside the clipped form body, above the anchored action panel, with nothing on top.
 */
async function expectFieldAbovePanel(drawer: Locator, panel: Locator, panelTop: number, name: string, field: Locator) {
  await field.scrollIntoViewIfNeeded();
  await expect(field, name).toBeVisible();
  const geometry = await fieldGeometry(field);
  const dialog = await viewportRect(drawer);
  const shift = Math.abs((await viewportRect(panel)).top - panelTop);
  expect(shift, `${name}: action panel stays anchored while the form scrolls (px)`).toBeLessThanOrEqual(LAYOUT_TOLERANCE);
  expect(geometry.body.bottom, `${name}: form body clips above the action panel`).toBeLessThanOrEqual(
    panelTop + LAYOUT_TOLERANCE,
  );
  expect(geometry.bottom, `${name}: field and label end above the action panel`).toBeLessThanOrEqual(
    panelTop + LAYOUT_TOLERANCE,
  );
  expect(geometry.top, `${name}: field and label start inside the visible form body`).toBeGreaterThanOrEqual(
    Math.max(dialog.top, geometry.body.top) - LAYOUT_TOLERANCE,
  );
  expect(geometry.unobstructed, `${name}: nothing covers the field`).toBe(true);
  return geometry.body;
}

test.describe('desktop 1440', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('real UI: create project and task, edit title/estimate/participants with revision guards, create a detail subtask sharing the parent estimate, persist after reload; filters against an API-created second task', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    expectWritableWorkspace();
    const workspaceId = live.firstWorkspace.id;
    const [responsible, other] = twoMembers();
    const suffix = shortId();
    const projectName = `E2E проект ${suffix}`;
    const title = `E2E задача ${suffix}`;
    const renamed = `E2E задача ${suffix} изменена`;
    const description = `Синтетическое описание ${suffix}`;

    // Project through the Projects route dialog.
    await page.goto(`/w/${workspaceId}/projects`);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: "Projects" })).toBeVisible();
    await main.getByRole('button', { name: "New project" }).click();
    const projectDialog = page.getByRole('dialog', { name: "New project" });
    await projectDialog.getByLabel("Project name", { exact: true }).fill(projectName);
    const projectCreated = page.waitForResponse((response) => isApiCall(response, 'POST', workspaceApi('/projects')), {
      timeout: RESPONSE_TIMEOUT,
    });
    await projectDialog.getByRole('button', { name: "Create project", exact: true }).click();
    const project: ProjectDto = projectResponseSchema.parse(await jsonOf(await projectCreated, 201)).data;
    expect(project.name).toBe(projectName);
    expect(project.workspaceId).toBe(workspaceId);
    await expect(projectDialog).toHaveCount(0);

    // Creating a project does not navigate; open its page by the created ID.
    const projectPath = `/w/${workspaceId}/projects/${project.id}`;
    await page.goto(projectPath);
    await expect(main.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await expect(taskTable(page)).toBeVisible();

    // Task through the table action and the create drawer.
    await taskTable(page).getByRole('button', { name: "Add task without a section", exact: true }).click();
    const createDrawer = page.getByRole('dialog', { name: "New task" });
    await createDrawer.getByLabel("Task name", { exact: true }).fill(title);
    await createDrawer.getByLabel("Description", { exact: true }).fill(description);
    await revealTaskDetails(createDrawer);
    await createDrawer.getByLabel("Team estimate, hours", { exact: true }).fill('1,5');
    await createDrawer.getByLabel("Assignee", { exact: true }).selectOption(responsible.id);
    const createParticipants = createDrawer.getByRole('group', { name: "Participants", exact: true });
    await createParticipants.getByRole('checkbox', { name: responsible.displayName, exact: true }).check();
    await createParticipants.getByRole('checkbox', { name: other.displayName, exact: true }).check();

    const taskCreated = page.waitForResponse((response) => isApiCall(response, 'POST', workspaceApi('/tasks')), {
      timeout: RESPONSE_TIMEOUT,
    });
    await createDrawer.getByRole('button', { name: "Create task", exact: true }).click();
    const createResponse = await taskCreated;
    const createBody = createTaskInputSchema.parse(createResponse.request().postDataJSON());
    expect(createBody.estimateMinutes).toBe(90);
    const created = taskResponseSchema.parse(await jsonOf(createResponse, 201)).data;
    expect(created.projectId).toBe(project.id);
    expect(created.sectionId).toBeNull();
    expect(created.title).toBe(title);
    expect(created.description).toBe(description);
    expect(created.estimateMinutes).toBe(90);
    expect(created.responsibleMembershipId).toBe(responsible.id);
    expect(created.participants).toHaveLength(2);
    expect(activeIds(created)).toEqual([responsible.id, other.id].sort());
    await expect(createDrawer).toHaveCount(0);

    // Edit through the task deep link.
    await page.goto(`${projectPath}?task=${created.id}`);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toHaveAccessibleName(title);
    const titleInput = drawer.getByLabel("Task name", { exact: true });
    await revealTaskDetails(drawer);
    const estimateInput = drawer.getByLabel("Team estimate, hours", { exact: true });
    const editParticipants = drawer.getByRole('group', { name: "Participants", exact: true });
    await expect(titleInput).toHaveValue(title);
    await expect(drawer.getByLabel("Description", { exact: true })).toHaveValue(description);
    await expect(estimateInput).toHaveValue('1:30');
    await expect(drawer.getByLabel("Assignee", { exact: true })).toHaveValue(responsible.id);
    await expect(editParticipants.getByRole('checkbox', { name: responsible.displayName, exact: true })).toBeChecked();
    await expect(editParticipants.getByRole('checkbox', { name: other.displayName, exact: true })).toBeChecked();

    await titleInput.fill(renamed);
    await estimateInput.fill('2:00');
    await editParticipants.getByRole('checkbox', { name: other.displayName, exact: true }).uncheck();
    const taskPatched = page.waitForResponse(
      (response) => isApiCall(response, 'PATCH', workspaceApi(`/tasks/${created.id}`)),
      { timeout: RESPONSE_TIMEOUT },
    );
    await drawer.getByRole('button', { name: "Save", exact: true }).click();
    const patchResponse = await taskPatched;
    const patchBody = updateTaskInputSchema.parse(patchResponse.request().postDataJSON());
    expect(patchBody).toEqual({
      expectedRevision: created.revision,
      title: renamed,
      estimateMinutes: 120,
      expectedWorkPackageRevision: created.workPackageRevision,
      participantMembershipIds: [responsible.id],
      expectedParticipantsRevision: created.participantsRevision,
    });
    const patched = taskResponseSchema.parse(await jsonOf(patchResponse, 200)).data;
    expect(patched.id).toBe(created.id);
    expect(patched.title).toBe(renamed);
    expect(patched.estimateMinutes).toBe(120);
    expect(patched.revision).toBeGreaterThan(created.revision);
    expect(patched.responsibleMembershipId).toBe(responsible.id);
    expect(activeIds(patched)).toEqual([responsible.id]);
    expect(inactiveIds(patched)).toEqual([other.id]);
    await expect(drawer).toHaveAccessibleName(renamed);

    await drawer.getByRole('button', { name: "Close", exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const expectEditedRow = async () => {
      await showAllColumns(page);
      const row = taskRow(page, renamed);
      await expect(row).toHaveCount(1);
      const cells = row.getByRole('cell');
      await expect(cells.nth(2)).toContainText(responsible.displayName);
      await expect(cells.nth(3)).toContainText(responsible.displayName);
      await expect(cells.nth(3)).not.toContainText(other.displayName);
      await expect(cells.nth(7)).toContainText("2h");
      await expectEstimateInView(page, renamed);
    };
    await expectEditedRow();

    // Detail subtask through the row action: it joins the parent's work package and estimate.
    const childTitle = `E2E детализация ${suffix}`;
    await taskTable(page).getByRole('button', { name: `Add subtask to “${renamed}”`, exact: true }).click();
    const childDrawer = page.getByRole('dialog', { name: "New subtask" });
    await childDrawer.getByLabel("Task name", { exact: true }).fill(childTitle);
    const scope = childDrawer.getByRole('group', { name: "Subtask scope", exact: true });
    await expect(
      scope.getByRole('radio', { name: "Detail — included in the parent estimate", exact: true }),
    ).toBeChecked();
    await revealTaskDetails(childDrawer);
    const childEstimate = childDrawer.getByLabel("Team estimate, hours", { exact: true });
    await expect(childEstimate).toHaveAttribute('readonly', '');
    await expect(childEstimate).toHaveValue('2:00');
    const childCreated = page.waitForResponse((response) => isApiCall(response, 'POST', workspaceApi('/tasks')), {
      timeout: RESPONSE_TIMEOUT,
    });
    await childDrawer.getByRole('button', { name: "Create task", exact: true }).click();
    const childResponse = await childCreated;
    const childRawBody: unknown = childResponse.request().postDataJSON();
    expect(childRawBody).not.toHaveProperty('estimateMinutes');
    const childBody = createTaskInputSchema.parse(childRawBody);
    expect(childBody.parentTaskId).toBe(created.id);
    expect(childBody.workScope).toBe('detail');
    expect(childBody.title).toBe(childTitle);
    const child = taskResponseSchema.parse(await jsonOf(childResponse, 201)).data;
    expect(child.title).toBe(childTitle);
    expect(child.parentTaskId).toBe(created.id);
    expect(child.workPackageId).toBe(patched.workPackageId);
    expect(child.workPackageRevision).toBe(patched.workPackageRevision);
    expect(child.estimateMinutes).toBe(120);
    await expect(childDrawer).toHaveCount(0);
    await expect(taskRow(page, childTitle)).toHaveCount(1);

    // Second synthetic task (request setup) for the filters: only the removed participant.
    const filterTitle = `E2E фильтр ${shortId()}`;
    const filterInput: CreateTaskInput = createTaskInputSchema.parse({
      projectId: project.id,
      title: filterTitle,
      statusId: created.statusId,
      participantMembershipIds: [other.id],
    });
    const filterTask = (
      await apiCreate(request, webOrigin(baseURL), workspaceApi('/tasks'), filterInput, taskResponseSchema)
    ).data;
    expect(activeIds(filterTask)).toEqual([other.id]);

    // Persistence: reload the page and read the task back from the real API.
    await page.reload();
    await expect(main.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    await expectEditedRow();
    await expect(taskRow(page, filterTitle)).toHaveCount(1);
    const persisted = (await apiGet(request, workspaceApi(`/tasks/${created.id}`), taskResponseSchema)).data;
    expect(persisted.title).toBe(renamed);
    expect(persisted.description).toBe(description);
    expect(persisted.estimateMinutes).toBe(120);
    expect(persisted.responsibleMembershipId).toBe(responsible.id);
    expect(persisted.revision).toBe(patched.revision);
    expect(persisted.workPackageRevision).toBe(patched.workPackageRevision);
    expect(persisted.participantsRevision).toBe(patched.participantsRevision);
    expect(activeIds(persisted)).toEqual([responsible.id]);
    expect(inactiveIds(persisted)).toEqual([other.id]);
    await expect(taskRow(page, childTitle)).toHaveCount(1);
    const persistedChild = (await apiGet(request, workspaceApi(`/tasks/${child.id}`), taskResponseSchema)).data;
    expect(persistedChild.parentTaskId).toBe(created.id);
    expect(persistedChild.workPackageId).toBe(persisted.workPackageId);
    expect(persistedChild.workPackageRevision).toBe(persisted.workPackageRevision);
    expect(persistedChild.estimateMinutes).toBe(120);
    await page.screenshot({ path: testInfo.outputPath('p1a-desktop-task-table.png'), fullPage: true });

    // Server-side filters through the actual TaskFilters controls.
    const tasksPath = workspaceApi('/tasks');
    const byParticipant = page.waitForResponse(
      (response) =>
        isApiCall(response, 'GET', tasksPath) &&
        new URL(response.url()).searchParams.get('participantMembershipId') === responsible.id,
      { timeout: RESPONSE_TIMEOUT },
    );
    await revealTaskFilters(page);
    await main.getByLabel("Task participant", { exact: true }).selectOption(responsible.id);
    await jsonOf(await byParticipant, 200);
    await expect(taskRow(page, renamed)).toHaveCount(1);
    await expect(taskRow(page, filterTitle)).toHaveCount(0);
    await main.getByRole('button', { name: "Clear filters", exact: true }).click();
    await expect(taskRow(page, renamed)).toHaveCount(1);
    await expect(taskRow(page, filterTitle)).toHaveCount(1);

    const bySearch = page.waitForResponse(
      (response) =>
        isApiCall(response, 'GET', tasksPath) && new URL(response.url()).searchParams.get('search') === filterTitle,
      { timeout: RESPONSE_TIMEOUT },
    );
    await main.getByRole('searchbox', { name: "Search tasks" }).fill(filterTitle);
    await jsonOf(await bySearch, 200);
    await expect(taskRow(page, filterTitle)).toHaveCount(1);
    await expect(taskRow(page, renamed)).toHaveCount(0);
    await main.getByRole('button', { name: "Clear filters", exact: true }).click();
    await expect(taskRow(page, renamed)).toHaveCount(1);

    // Reopen the persisted task from the table title.
    await taskTable(page).getByRole('button', { name: renamed, exact: true }).click();
    const reopened = page.getByRole('dialog');
    await expect(reopened).toHaveAccessibleName(renamed);
    await expect(reopened.getByLabel("Task name", { exact: true })).toHaveValue(renamed);
    await expect(reopened.getByLabel("Description", { exact: true })).toHaveValue(description);
    await revealTaskDetails(reopened);
    await expect(reopened.getByLabel("Team estimate, hours", { exact: true })).toHaveValue('2:00');
    await expect(reopened.getByLabel("Assignee", { exact: true })).toHaveValue(responsible.id);
    const reopenedParticipants = reopened.getByRole('group', { name: "Participants", exact: true });
    await expect(reopenedParticipants.getByRole('checkbox', { name: responsible.displayName, exact: true })).toBeChecked();
    await expect(reopenedParticipants.getByRole('checkbox', { name: other.displayName, exact: true })).not.toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('p1a-desktop-task-detail.png') });
  });
});

test.describe('mobile 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('request setup (API-created project and task): table without page-level overflow, persisted fields in the drawer (view only, no edit)', async ({
    page,
    request,
    baseURL,
  }, testInfo) => {
    expectWritableWorkspace();
    const origin = webOrigin(baseURL);
    const [responsible, other] = twoMembers();
    const suffix = shortId();
    const projectName = `E2E мобильный ${suffix}`;
    const title = `E2E мобильная задача ${suffix}`;
    const description = `Синтетическое описание ${suffix}`;

    const project = (await apiCreate(request, origin, workspaceApi('/projects'), { name: projectName }, projectResponseSchema))
      .data;
    expect(project.name).toBe(projectName);
    const statuses = (
      await apiGet(request, workspaceApi(`/projects/${project.id}/statuses`), taskStatusListResponseSchema)
    ).data;
    const ordered = [...statuses].sort((a, b) => a.position - b.position);
    const status = ordered.find((candidate) => candidate.group === 'todo') ?? ordered[0];
    if (!status) throw new Error(`Project ${project.id} returned no task statuses.`);

    const input: CreateTaskInput = createTaskInputSchema.parse({
      projectId: project.id,
      title,
      description,
      statusId: status.id,
      responsibleMembershipId: responsible.id,
      participantMembershipIds: [responsible.id, other.id],
      estimateMinutes: 90,
    });
    const task = (await apiCreate(request, origin, workspaceApi('/tasks'), input, taskResponseSchema)).data;
    expect(task.title).toBe(title);
    expect(task.estimateMinutes).toBe(90);
    expect(task.responsibleMembershipId).toBe(responsible.id);
    expect(activeIds(task)).toEqual([responsible.id, other.id].sort());

    await page.goto(`/w/${live.firstWorkspace.id}/projects/${project.id}`);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: projectName })).toBeVisible();
    const titleButton = taskTable(page).getByRole('button', { name: title, exact: true });
    await expect(titleButton).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('p1a-mobile-task-table.png'), fullPage: true });

    await titleButton.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toHaveAccessibleName(title);
    await expect(drawer.getByLabel("Task name", { exact: true })).toHaveValue(title);
    await expect(drawer.getByLabel("Description", { exact: true })).toHaveValue(description);
    await revealTaskDetails(drawer);
    await expect(drawer.getByLabel("Team estimate, hours", { exact: true })).toHaveValue('1:30');
    await expect(drawer.getByLabel("Assignee", { exact: true })).toHaveValue(responsible.id);
    const participants = drawer.getByRole('group', { name: "Participants", exact: true });
    await expect(participants.getByRole('checkbox', { name: responsible.displayName, exact: true })).toBeChecked();
    await expect(participants.getByRole('checkbox', { name: other.displayName, exact: true })).toBeChecked();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath('p1a-mobile-task-drawer.png') });

    // Late fields scroll inside the form body, above an anchored opaque action panel with Save.
    const saveButton = drawer.getByRole('button', { name: "Save", exact: true });
    await expect(saveButton).toBeVisible();
    // TaskDrawer's action panel is the Save button's wrapper.
    const actionPanel = saveButton.locator('xpath=..');
    const panel = await viewportRect(actionPanel);
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(panel.bottom, 'action panel ends inside the viewport').toBeLessThanOrEqual(viewportHeight + LAYOUT_TOLERANCE);
    expect(panel.top, 'action panel is anchored in the bottom half of the viewport').toBeGreaterThan(viewportHeight / 2);
    const backdrop = await backgroundAlpha(actionPanel);
    expect(backdrop.alpha, `action panel background ${backdrop.color} is opaque`).toBe(1);
    const lateFields: [string, Locator][] = [
      ["Due date", drawer.getByLabel("Due date", { exact: true })],
      ["Team estimate, hours", drawer.getByLabel("Team estimate, hours", { exact: true })],
      ["Participants", participants],
      ["Tags", drawer.getByRole('group', { name: "Tags", exact: true })],
    ];
    let formBody: { scrollTop: number; scrollable: boolean } | null = null;
    for (const [name, field] of lateFields) {
      formBody = await expectFieldAbovePanel(drawer, actionPanel, panel.top, name, field);
    }
    if (formBody?.scrollable) {
      expect(formBody.scrollTop, 'late fields are reached by scrolling the form body').toBeGreaterThan(0);
    }
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();
    expect((await viewportRect(saveButton)).bottom, 'Сохранить inside the viewport').toBeLessThanOrEqual(
      viewportHeight + LAYOUT_TOLERANCE,
    );
    const saveReachable = await saveButton.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && button.contains(hit);
    });
    expect(saveReachable, 'nothing covers Сохранить').toBe(true);
    await page.screenshot({ path: testInfo.outputPath('p1a-mobile-task-drawer-bottom.png') });
    await expectNoHorizontalOverflow(page);
  });
});
