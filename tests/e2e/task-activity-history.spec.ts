// Private compiled BFF only. The root owns API/PG lifecycle; this starts only the in-memory Auth fixture.
import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  taskCommentResponseSchema, taskCommentsResponseSchema, taskFieldDefinitionResponseSchema, taskFieldValueHistoryListResponseSchema,
  taskFieldValueListResponseSchema, taskFieldValueResponseSchema, taskResponseSchema, taskTimelineResponseSchema,
  type TaskActivityChangeDto, type TaskFieldData, type TaskTimelineItemDto,
} from '@workloom/contracts';
import { startFakeSharedAuth, type FakeSharedAuth } from './support/fake-shared-auth.js';
import {
  PRIVATE_APP as APP, apiRead, apiWrite, createFixtureTask, freshProject, observeCommands, openTable, requireValue, savedRow,
  type DailyProject,
} from './support/asana-private-project.js';

type Item = TaskTimelineItemDto;
type ActivityItem = Extract<Item, { type: 'activity' }>;
type Change = TaskActivityChangeDto;
let provider: FakeSharedAuth;

/** Server order: `changeSeq` is a bigint string, `eventOrdinal` breaks ties inside one change. */
const compare = (a: Item, b: Item) => {
  const x = BigInt(a.changeSeq), y = BigInt(b.changeSeq);
  return x === y ? a.eventOrdinal - b.eventOrdinal : x < y ? -1 : 1;
};
const chronological = (items: readonly Item[]) => [...items].sort(compare);
const activityItems = (items: readonly Item[]) => items.filter((item): item is ActivityItem => item.type === 'activity');
const changesAfter = (items: readonly Item[], pivot: Item) => activityItems(items).filter(item => compare(item, pivot) > 0).flatMap(item => item.changes);
const rowKey = (item: Item) => item.type === 'comment' ? `comment:${item.comment.id}` : `activity:${item.id}`;
const timelinePath = (f: DailyProject, taskId: string, query: string) => `${f.prefix}/tasks/${taskId}/timeline?${query}`;

function only<F extends Change['field']>(changes: readonly Change[], field: F): Extract<Change, { field: F }> {
  const found = changes.filter((change): change is Extract<Change, { field: F }> => change.field === field);
  expect(found).toHaveLength(1); return requireValue(found[0]);
}
async function boundedTimeline(f: DailyProject, taskId: string) {
  const response = await apiRead(f.page, timelinePath(f, taskId, 'limit=50'), taskTimelineResponseSchema);
  expect(response.data.length).toBeLessThanOrEqual(50); expect(response.meta.nextCursor).toBeNull();
  const keys = response.data.map(item => `${item.changeSeq}:${item.eventOrdinal}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(response.data.every(item => item.taskId === taskId && item.workspaceId === f.workspaceId)).toBe(true);
  return chronological(response.data);
}
async function pagedTimeline(f: DailyProject, taskId: string) {
  const seen: Item[] = []; let cursor: string | null = null; let pages = 0;
  do {
    const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${encodeURIComponent(cursor)}`;
    const response = await apiRead(f.page, timelinePath(f, taskId, query), taskTimelineResponseSchema);
    expect(response.data.length).toBeLessThanOrEqual(2);
    seen.push(...response.data); cursor = response.meta.nextCursor; pages += 1;
  } while (cursor !== null && pages < 10);
  expect(cursor).toBeNull();
  return { seen, pages };
}
async function renderedOrder(activity: Locator) {
  return activity.getByRole('list', { name: 'Activity', exact: true }).locator(':scope > li').evaluateAll(rows => rows.map(row => {
    const data = (row as HTMLElement).dataset;
    return data.taskCommentId ? `comment:${data.taskCommentId}` : `activity:${data.taskActivityId ?? ''}`;
  }));
}
async function openActivity(f: DailyProject, task: { id: string; title: string }) {
  await openTable(f);
  await savedRow(f.page, task.id).getByRole('button', { name: `Open task “${task.title}”`, exact: true }).click();
  const activity = f.page.getByRole('region', { name: 'Activity', exact: true });
  await expect(activity).toBeVisible();
  return activity;
}
async function putValue(page: Page, path: string, data: object) {
  const response = await page.request.fetch(`${APP}${path}`, { method: 'PUT', data, headers: { Origin: APP, 'Idempotency-Key': randomUUID() } });
  expect(response.status()).toBe(200); return taskFieldValueResponseSchema.parse(await response.json()).data;
}
const isPost = (path: string) => (response: { request(): { method(): string }; url(): string }) =>
  response.request().method() === 'POST' && new URL(response.url()).pathname === path;
function observe(page: Page) {
  const errors: string[] = [], badApi: number[] = [];
  page.on('pageerror', error => errors.push(error.name));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.status() >= 400 && response.status() !== 401) badApi.push(response.status());
  });
  return (expectedBad: number[] = []) => { expect(errors).toEqual([]); expect(badApi).toEqual(expectedBad); };
}

test.describe('Task activity history on the private compiled app', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.beforeAll(async ({ baseURL }, info) => {
    if (baseURL !== APP || process.env.WORKLOOM_QA_BASE_URL !== APP) throw new Error('Activity history native gate requires explicit private49318.');
    if (info.project.use.trace !== 'off' || info.project.use.video !== 'off') throw new Error('Activity history native gate requires trace/video OFF.');
    provider = await startFakeSharedAuth({ port: 49319, appOrigin: APP });
  });
  test.afterAll(async () => { await provider?.close(); });

  for (const width of [1440, 390]) {
    test(`UI comment, completion and reopen stay in server chronology at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const clean = observe(page);
      const f = await freshProject(page, provider, `History ${width}`);
      const todo = requireValue(f.statuses.find(status => status.id === f.todoId));
      const done = requireValue(f.statuses.find(status => status.id === f.doneId));
      const title = `History task ${width} ${randomUUID()}`;
      const task = await createFixtureTask(f, title, { responsibleMembershipId: f.owner.id, participantMembershipIds: [f.owner.id],
        startDate: '2026-11-02', dueDate: '2026-11-06', priority: 'low', estimateMinutes: 90 });
      expect(task).toMatchObject({ title, statusId: f.todoId, startDate: '2026-11-02', dueDate: '2026-11-06', priority: 'low', estimateMinutes: 90 });

      const activity = await openActivity(f, task);
      const composer = activity.getByRole('textbox', { name: 'Comment', exact: true });
      const body = `History comment ${width} ${randomUUID()}`;
      await composer.fill(body);
      const answer = page.waitForResponse(isPost(`${f.prefix}/tasks/${task.id}/comments`));
      await activity.getByRole('button', { name: 'Add comment', exact: true }).click();
      const posted = await answer;
      expect(posted.status()).toBe(201);
      const comment = taskCommentResponseSchema.parse(await posted.json()).data;
      expect(comment).toMatchObject({ body, taskId: task.id, workspaceId: f.workspaceId, authorUserId: f.actorId, authorMembershipId: f.owner.id });
      await expect(activity.locator(`li[data-task-comment-id="${comment.id}"]`)).toContainText(body);
      await expect(composer).toHaveValue('');

      const completed = (await apiWrite(page, `${f.prefix}/tasks/${task.id}`, {
        expectedRevision: task.revision, statusId: f.doneId, startDate: '2026-11-09', dueDate: '2026-11-13', priority: 'urgent',
        estimateMinutes: 150, expectedWorkPackageRevision: task.workPackageRevision,
      }, taskResponseSchema, 'PATCH')).data;
      expect(completed).toMatchObject({ statusId: f.doneId, startDate: '2026-11-09', dueDate: '2026-11-13', priority: 'urgent', estimateMinutes: 150 });
      expect(completed.revision).toBeGreaterThan(task.revision);

      const saved = await boundedTimeline(f, task.id);
      const created = activityItems(saved).filter(item => item.kind === 'created');
      expect(created).toHaveLength(1);
      const commentItems = saved.filter(item => item.type === 'comment');
      expect(commentItems).toHaveLength(1);
      const commentItem = requireValue(commentItems[0]);
      expect(commentItem.type === 'comment' && commentItem.comment).toMatchObject({ id: comment.id, body });
      expect(compare(requireValue(created[0]), commentItem)).toBeLessThan(0);
      const completion = changesAfter(saved, commentItem);
      expect(only(completion, 'status')).toMatchObject({ from: { id: todo.id, name: todo.name, group: 'todo' }, to: { id: done.id, name: done.name, group: 'done' } });
      expect(only(completion, 'startDate')).toMatchObject({ from: '2026-11-02', to: '2026-11-09' });
      expect(only(completion, 'dueDate')).toMatchObject({ from: '2026-11-06', to: '2026-11-13' });
      expect(only(completion, 'priority')).toEqual({ field: 'priority', from: 'low', to: 'urgent' });
      expect(only(completion, 'estimate')).toEqual({ field: 'estimate', from: 90, to: 150 });
      const completionItem = requireValue(activityItems(saved).find(item => item.changes.some(change => change.field === 'status')));
      expect(completionItem.actorUserId).toBe(f.actorId);

      const paged = await pagedTimeline(f, task.id);
      expect(paged.pages).toBeGreaterThan(1);
      expect(paged.seen.map(item => item.id).sort()).toEqual(saved.map(item => item.id).sort());

      const reloaded = await openActivity(f, task);
      await expect(reloaded.locator(`li[data-task-comment-id="${comment.id}"]`)).toContainText(body);
      const completionRow = reloaded.locator(`li[data-task-activity-id="${completionItem.id}"]`);
      await expect(completionRow).toContainText(todo.name);
      await expect(completionRow).toContainText(done.name);
      await expect(completionRow).toContainText(completionItem.actorDisplayName);
      await expect.poll(() => renderedOrder(reloaded)).toEqual(saved.map(rowKey));

      await reloaded.getByRole('textbox', { name: 'Comment', exact: true }).press('Escape');
      await expect(reloaded).toHaveCount(0);
      const reopened = (await apiWrite(page, `${f.prefix}/tasks/${task.id}`, { expectedRevision: completed.revision, statusId: f.todoId }, taskResponseSchema, 'PATCH')).data;
      expect(reopened.statusId).toBe(f.todoId);
      const oracle = await boundedTimeline(f, task.id);
      expect(only(changesAfter(oracle, completionItem), 'status')).toMatchObject({ from: { id: done.id, name: done.name, group: 'done' }, to: { id: todo.id, name: todo.name, group: 'todo' } });
      const reopenItem = requireValue(activityItems(oracle).find(item => compare(item, completionItem) > 0 && item.changes.some(change => change.field === 'status')));
      const documentOrigin = await page.evaluate(() => performance.timeOrigin);
      // Own a NEW request and consume its body as soon as headers arrive. A response
      // waiter alone can select an older read and lose its CDP body during the click.
      const refreshed = page.waitForRequest(request => request.method() === 'GET'
        && new URL(request.url()).pathname === `${f.prefix}/tasks/${task.id}/timeline`).then(async request => {
        const response = await request.response();
        if (!response) throw new Error('The new timeline request produced no response.');
        expect(response.status()).toBe(200);
        return taskTimelineResponseSchema.parse(await response.json()).data;
      });
      await savedRow(page, task.id).getByRole('button', { name: `Open task “${title}”`, exact: true }).click();
      const live = await refreshed;
      expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentOrigin);
      expect(new URL(page.url()).searchParams.get('task')).toBe(task.id);
      expect(live.map(item => item.id)).toContain(reopenItem.id);
      const stream = page.getByRole('region', { name: 'Activity', exact: true });
      const reopenRow = stream.locator(`li[data-task-activity-id="${reopenItem.id}"]`);
      await expect(reopenRow).toContainText(done.name);
      await expect(reopenRow).toContainText(todo.name);
      await expect.poll(() => renderedOrder(stream)).toEqual(oracle.map(rowKey));
      expect((await apiRead(page, `${f.prefix}/tasks/${task.id}`, taskResponseSchema)).data.statusId).toBe(f.todoId);
      clean();
    });
  }

  test('lost comment acknowledgement retries the original comment once and never attaches it elsewhere at390', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    const clean = observe(page);
    const f = await freshProject(page, provider, 'History held');
    const task = await createFixtureTask(f, `Held task ${randomUUID()}`);
    const foreign = await createFixtureTask(f, `Foreign task ${randomUUID()}`);
    const commentsPath = `${f.prefix}/tasks/${task.id}/comments`;
    let realAck: { status: number; id: string } | undefined;
    await page.route(`${APP}${commentsPath}`, async route => {
      if (route.request().method() !== 'POST' || realAck) { await route.fallback(); return; }
      const real = await route.fetch();
      realAck = { status: real.status(), id: taskCommentResponseSchema.parse(await real.json()).data.id };
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Acknowledgement lost.' } }) });
    });
    const activity = await openActivity(f, task);
    const commands = observeCommands(page, f.prefix);
    const composer = activity.getByRole('textbox', { name: 'Comment', exact: true });
    const body = `Held comment ${randomUUID()}`;
    await composer.fill(body);
    const lost = page.waitForResponse(isPost(commentsPath));
    await activity.getByRole('button', { name: 'Add comment', exact: true }).click();
    expect((await lost).status()).toBe(503);
    const ack = requireValue(realAck);
    expect(ack.status).toBe(201);
    const retry = activity.getByRole('button', { name: 'Retry original comment', exact: true });
    await expect(retry).toBeVisible();
    await expect(composer).toHaveValue(body);
    await expect(composer).toBeDisabled();

    const replay = page.waitForResponse(isPost(commentsPath));
    await retry.click();
    const replayed = await replay;
    expect(replayed.status()).toBe(201);
    expect(taskCommentResponseSchema.parse(await replayed.json()).data).toMatchObject({ id: ack.id, body, taskId: task.id });
    await expect(activity.locator(`li[data-task-comment-id="${ack.id}"]`)).toContainText(body);
    await expect(retry).toHaveCount(0);
    commands.close();

    const posts = commands.commands.filter(command => command.method === 'POST' && command.path === commentsPath);
    expect(posts).toHaveLength(2);
    expect(posts.map(command => JSON.parse(command.body) as unknown)).toEqual([{ body }, { body }]);
    const key = requireValue(posts[0]?.key);
    expect(key.length).toBeGreaterThan(0);
    expect(posts[1]?.key).toBe(key);
    expect(commands.commands.filter(command => command.method === 'PATCH' && command.path.startsWith(`${f.prefix}/tasks/`))).toEqual([]);

    const persisted = (await apiRead(page, `${commentsPath}?limit=50`, taskCommentsResponseSchema)).data.filter(value => value.body === body);
    expect(persisted.map(value => value.id)).toEqual([ack.id]);
    const timeline = await boundedTimeline(f, task.id);
    expect(timeline.filter(item => item.type === 'comment').map(rowKey)).toEqual([`comment:${ack.id}`]);
    expect((await apiRead(page, `${f.prefix}/tasks/${foreign.id}/comments?limit=50`, taskCommentsResponseSchema)).data).toEqual([]);
    const foreignTimeline = await boundedTimeline(f, foreign.id);
    expect(foreignTimeline.filter(item => item.type === 'comment')).toEqual([]);
    expect(JSON.stringify(foreignTimeline)).not.toContain(body);
    const foreignActivity = await openActivity(f, foreign);
    await expect(foreignActivity.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue('');
    await expect(foreignActivity.locator('li[data-task-comment-id]')).toHaveCount(0);
    clean([503]);
  });

  test('custom text history keeps the recorded value after history is disabled and omits the later value', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const clean = observe(page);
    const f = await freshProject(page, provider, 'History field');
    const task = await createFixtureTask(f, `Field task ${randomUUID()}`);
    const original = `Original value ${randomUUID()}`, later = `Later secret ${randomUUID()}`;
    const field = (await apiWrite(page, `${f.prefix}/fields`, { projectId: f.projectId, name: `History text ${randomUUID().slice(0, 8)}`, type: 'text', historyEnabled: true }, taskFieldDefinitionResponseSchema)).data;
    expect(field).toMatchObject({ projectId: f.projectId, type: 'text', historyEnabled: true, locked: false, archivedAt: null });
    const valuePath = `${f.prefix}/tasks/${task.id}/field-values/${field.id}`;
    const originalValue = { type: 'text', value: original } satisfies TaskFieldData;
    const laterValue = { type: 'text', value: later } satisfies TaskFieldData;
    const first = await putValue(page, valuePath, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: originalValue });
    expect(first).toMatchObject({ taskId: task.id, fieldId: field.id, revision: 1, value: originalValue });
    const disabled = (await apiWrite(page, `${f.prefix}/fields/${field.id}`, { expectedRevision: field.revision, historyEnabled: false }, taskFieldDefinitionResponseSchema, 'PATCH')).data;
    expect(disabled.historyEnabled).toBe(false);
    expect(disabled.revision).toBeGreaterThan(field.revision);
    const second = await putValue(page, valuePath, { expectedRevision: first.revision, expectedDefinitionRevision: disabled.revision, value: laterValue });
    expect(second).toMatchObject({ revision: first.revision + 1, value: laterValue });
    const current = (await apiRead(page, `${f.prefix}/tasks/${task.id}/field-values`, taskFieldValueListResponseSchema)).data;
    expect(current.find(value => value.fieldId === field.id)?.value).toEqual(laterValue);

    const history = (await apiRead(page, `${valuePath}/history?limit=50`, taskFieldValueHistoryListResponseSchema)).data;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fieldId: field.id, valueRevision: 1, before: null, after: originalValue, definition: { id: field.id, historyEnabled: true } });
    expect(JSON.stringify(history)).not.toContain(later);

    const timeline = await boundedTimeline(f, task.id);
    const custom = activityItems(timeline).flatMap(item => item.changes)
      .filter((change): change is Extract<Change, { field: 'custom' }> => change.field === 'custom' && change.fieldId === field.id);
    const recorded = custom.filter(change => change.availability === 'history');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ fieldName: field.name, fieldType: 'text', before: null, after: originalValue, definition: { id: field.id, type: 'text', historyEnabled: true } });
    expect(JSON.stringify(timeline)).toContain(original);
    expect(JSON.stringify(timeline)).not.toContain(later);

    const activity = await openActivity(f, task);
    await expect(activity).toContainText(original);
    await expect(activity).not.toContainText(later);
    await expect.poll(() => renderedOrder(activity)).toEqual(timeline.map(rowKey));
    clean();
  });
});
