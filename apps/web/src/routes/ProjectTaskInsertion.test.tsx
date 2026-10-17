import type { CreateTaskInput, TaskDto } from '@workloom/contracts';
import { screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, created, deferred, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });
const taskA: TaskDto = { ...task, title: 'Alpha row', position: 0 };
const taskB: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-0000000000b1', workPackageId: 'f1000000-0000-4000-8000-0000000000b1', title: 'Bravo row', position: 1 };
const taskC: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-0000000000c1', workPackageId: 'f1000000-0000-4000-8000-0000000000c1', title: 'Charlie row', position: 2 };
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: true }] };
const page = (rows: TaskDto[]) => json(200, { data: rows, meta: { requestId: 'insertion-fixture', nextCursor: null } });
type Calls = ReturnType<typeof installFakeApi>['calls'];
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const posts = (calls: Calls) => calls.filter(call => call.method === 'POST');
const patches = (calls: Calls) => calls.filter(call => call.method === 'PATCH');
const keyOf = (call: Calls[number] | undefined) => call?.headers.get('Idempotency-Key') ?? null;
const rowOf = (node: HTMLElement) => node.closest('tr') as HTMLTableRowElement;
/** The unsaved draft is the only open task name editor once B's unchanged title editor closes. */
const draftInput = () => screen.getByRole('textbox', { name: 'Task name' });
/** The next-task buffer is the focused task name editor; submitted rows may still show their own. */
function focusedTaskName(): HTMLInputElement {
  const input = screen.getAllByRole('textbox', { name: 'Task name' }).find(node => node === document.activeElement);
  if (!input) throw new Error('No focused task name editor');
  return input as HTMLInputElement;
}
const following = (first: Node, second: Node) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
function expectRowOrder(titles: string[]) {
  const rows = titles.map(title => rowOf(screen.getByRole('button', { name: title })));
  rows.slice(1).forEach((row, index) => expect(following(rows[index] as HTMLElement, row), `${titles[index]} before ${titles[index + 1]}`).toBe(true));
}

/** Server-side anchor placement: renumbers each sibling list, appends when the anchor is unknown. */
function insertAfter(rows: TaskDto[], anchorTaskId: string | undefined, row: TaskDto): TaskDto[] {
  const index = rows.findIndex(item => item.id === anchorTaskId);
  const next = index < 0 ? [...rows, row] : [...rows.slice(0, index + 1), row, ...rows.slice(index + 1)];
  const counters = new Map<string | null, number>();
  return next.map(item => {
    const position = counters.get(item.parentTaskId) ?? 0;
    counters.set(item.parentTaskId, position + 1);
    return { ...item, position };
  });
}

function routes(rows: () => TaskDto[], extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => page(rows()),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference),
    ...extra,
  };
}

async function enterOnUnchangedTitle(user: ReturnType<typeof renderApp>['user'], title: string) {
  await user.click(await screen.findByRole('button', { name: title }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Task name' })).toHaveValue(title));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(draftInput()).toHaveFocus());
}

describe('plain Enter on an unchanged middle task title', () => {
  it('opens an unsaved full table row right after that task, drops it on Escape and creates only from a nonempty Enter', async () => {
    // The server list is authoritative: a confirmed create is stored right after B, ahead of C.
    let stored: TaskDto[] = [taskA, taskB, taskC];
    const { calls } = installFakeApi(routes(() => stored, {
      [`POST ${rootPath}/tasks`]: request => {
        const row: TaskDto = { ...task, id: 'f2000000-0000-4000-8000-0000000000d1', workPackageId: 'f1000000-0000-4000-8000-0000000000d1', title: (request.body as { title: string }).title };
        stored = [taskA, taskB, row, taskC].map((item, position) => ({ ...item, position }));
        return created(stored[2]);
      },
    }));
    const { user } = renderApp(tablePath);

    await enterOnUnchangedTitle(user, taskB.title);
    const bRow = rowOf(screen.getByRole('button', { name: taskB.title }));
    const cRow = rowOf(screen.getByRole('button', { name: taskC.title }));
    let draftRow = rowOf(draftInput());
    // B is not the bottom task, yet the draft is a normal row placed directly between B and C.
    expect(draftRow).not.toBe(bRow);
    expect(bRow.nextElementSibling).toBe(draftRow);
    expect(draftRow.nextElementSibling).toBe(cRow);
    expect(draftRow.cells.length).toBeGreaterThan(1);
    expect(draftRow.cells).toHaveLength(bRow.cells.length);
    expect(draftInput()).toHaveValue('');
    expect(writes(calls)).toHaveLength(0);

    // Escape discards the unsaved row entirely without any write.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    expect(rowOf(screen.getByRole('button', { name: taskB.title })).nextElementSibling).toBe(rowOf(screen.getByRole('button', { name: taskC.title })));
    expect(writes(calls)).toHaveLength(0);

    // Reopened, an empty Enter keeps the draft without creating anything.
    await enterOnUnchangedTitle(user, taskB.title);
    draftRow = rowOf(draftInput());
    expect(rowOf(screen.getByRole('button', { name: taskB.title })).nextElementSibling).toBe(draftRow);
    await user.keyboard('{Enter}');
    expect(rowOf(draftInput())).toBe(draftRow);
    expect(draftInput()).toHaveFocus();
    expect(writes(calls)).toHaveLength(0);

    // Only a nonempty title Enter sends exactly one create, and no rename of B.
    await user.keyboard('Delta inserted{Enter}');
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]?.body).toMatchObject({ projectId: PROJECT_ID, title: 'Delta inserted' });
    // The server places the task by anchor; the client never sends a list index.
    expect((posts(calls)[0]?.body as CreateTaskInput).insertion).toEqual({ anchorTaskId: taskB.id, placement: 'after' });
    expect(posts(calls)[0]?.body).not.toHaveProperty('position');
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    const saved = await screen.findByRole('button', { name: 'Delta inserted' });
    const savedRow = rowOf(saved);
    expect(rowOf(screen.getByRole('button', { name: taskB.title })).compareDocumentPosition(savedRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(savedRow.compareDocumentPosition(rowOf(screen.getByRole('button', { name: taskC.title }))) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(posts(calls)).toHaveLength(1);
  });
});

describe('rapid Enter queue after a middle task with an unknown first create', () => {
  const ONE_ID = 'f2000000-0000-4000-8000-0000000000e1';
  const TWO_ID = 'f2000000-0000-4000-8000-0000000000e2';
  const lostAcks = [
    { outcome: '503', lostAck: () => json(503, { error: { code: 'UNAVAILABLE', message: 'Response lost upstream', retryable: true }, meta: { requestId: 'insertion-lost-ack' } }) },
    { outcome: 'malformed 201', lostAck: () => json(201, { data: { id: ONE_ID }, meta: { requestId: 'insertion-lost-ack' } }) },
  ];

  it.each(lostAcks)('holds the queued task until the unchanged retry confirms the first one ($outcome), then anchors it on the confirmed ID', async ({ lostAck }) => {
    // The server commits each new Idempotency-Key once, right after the sent anchor, and replays it afterwards.
    let stored: TaskDto[] = [taskA, taskB, taskC];
    const committed = new Map<string, TaskDto>();
    const ids = [ONE_ID, TWO_ID];
    const gates = [deferred<undefined>(), deferred<undefined>(), deferred<undefined>()];
    let attempts = 0;
    const { calls } = installFakeApi(routes(() => stored, {
      [`POST ${rootPath}/tasks`]: async request => {
        const attempt = attempts++;
        const key = keyOf(request) ?? '';
        const body = request.body as CreateTaskInput;
        let row = committed.get(key);
        if (!row) {
          const id = ids[committed.size] ?? 'f2000000-0000-4000-8000-0000000000ef';
          row = { ...task, id, workPackageId: id.replace('f2', 'f1'), title: body.title };
          committed.set(key, row);
          stored = insertAfter(stored, body.insertion?.anchorTaskId, row);
        }
        const rowId = row.id;
        await gates[attempt]?.promise;
        if (attempt === 0) return lostAck();
        return created(stored.find(item => item.id === rowId));
      },
    }));
    const { user } = renderApp(tablePath);

    await enterOnUnchangedTitle(user, taskB.title);
    expect(draftInput()).toHaveValue('');
    expect(writes(calls)).toHaveLength(0);

    // One is sent and held; Two is typed and entered while One is unconfirmed; the next buffer keeps typing.
    await user.keyboard('Queued one{Enter}');
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    await waitFor(() => expect(focusedTaskName()).toHaveValue(''));
    await user.keyboard('Queued two{Enter}');
    await waitFor(() => expect(focusedTaskName()).toHaveValue(''));
    await user.keyboard('Next buffer');
    const next = focusedTaskName();
    expect(next).toHaveValue('Next buffer');
    expect(posts(calls)).toHaveLength(1);
    const oneCall = posts(calls)[0];
    const oneBody = oneCall?.body as CreateTaskInput;
    expect(oneBody).toMatchObject({ projectId: PROJECT_ID, title: 'Queued one' });
    expect(oneBody.insertion).toEqual({ anchorTaskId: taskB.id, placement: 'after' });
    expect(oneBody).not.toHaveProperty('position');
    expect(keyOf(oneCall)).toBeTruthy();

    // The first answer is lost although the server committed One: Two must not be sent on a guess.
    gates[0]?.resolve(undefined);
    const retry = await screen.findByRole('button', { name: 'Retry original' });
    expect(posts(calls)).toHaveLength(1);
    expect(next.isConnected).toBe(true);
    expect(next).toHaveValue('Next buffer');
    expect(stored.filter(item => item.title === 'Queued one')).toHaveLength(1);

    // The deliberate retry repeats the original request exactly and is held.
    await user.click(retry);
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]?.body).toEqual(oneBody);
    expect(keyOf(posts(calls)[1])).toBe(keyOf(oneCall));

    // Before the replay acknowledgement the user returns to the next buffer, types and selects.
    await user.type(next, ' later');
    next.setSelectionRange(5, 11);
    expect(next).toHaveFocus();
    expect(next).toHaveValue('Next buffer later');
    expect(posts(calls)).toHaveLength(2);

    // The replay confirms One; only now is Two sent, anchored on One's confirmed ID with the same defaults.
    gates[1]?.resolve(undefined);
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    const twoCall = posts(calls)[2];
    expect(twoCall?.body).toEqual({ ...oneBody, title: 'Queued two', insertion: { anchorTaskId: ONE_ID, placement: 'after' } });
    expect(keyOf(twoCall)).toBeTruthy();
    expect(keyOf(twoCall)).not.toBe(keyOf(oneCall));
    expect(next).toBe(focusedTaskName());
    expect(next).toHaveValue('Next buffer later');
    expect([next.selectionStart, next.selectionEnd]).toEqual([5, 11]);

    // Two's known acknowledgement and the server list give B, One, Two, C with no duplicate One.
    gates[2]?.resolve(undefined);
    await screen.findByRole('button', { name: 'Queued two' });
    await waitFor(() => expectRowOrder([taskA.title, taskB.title, 'Queued one', 'Queued two', taskC.title]));
    expect(stored.map(item => item.title)).toEqual([taskA.title, taskB.title, 'Queued one', 'Queued two', taskC.title]);
    expect(screen.getAllByRole('button', { name: 'Queued one' })).toHaveLength(1);
    expect(next.isConnected).toBe(true);
    expect(next).toHaveFocus();
    expect(next).toHaveValue('Next buffer later');
    expect([next.selectionStart, next.selectionEnd]).toEqual([5, 11]);
    expect(posts(calls)).toHaveLength(3);
    expect(patches(calls)).toHaveLength(0);

    // Escape cancels the typed, unsent buffer without a third create, and reopening does not bring it back.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByDisplayValue('Next buffer later')).not.toBeInTheDocument());
    expect(posts(calls)).toHaveLength(3);
    await enterOnUnchangedTitle(user, 'Queued two');
    expect(draftInput()).toHaveValue('');
    expect(screen.queryByDisplayValue('Next buffer later')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    expect(posts(calls)).toHaveLength(3);
    expect(patches(calls)).toHaveLength(0);
    expect(stored).toHaveLength(5);
  });
});

describe('plain Enter on an unchanged middle subtask title', () => {
  const PARENT_PACKAGE = 'f1000000-0000-4000-8000-0000000000a0';
  const parent: TaskDto = { ...task, id: 'f3000000-0000-4000-8000-0000000000a0', parentTaskId: null, workPackageId: PARENT_PACKAGE, title: 'Parent row', estimateMinutes: 480, position: 0 };
  // Detail subtasks share the parent's work package and show its estimate.
  const child = (id: string, title: string, position: number): TaskDto => ({ ...task, id, parentTaskId: parent.id, workPackageId: PARENT_PACKAGE, workPackageRevision: parent.workPackageRevision, estimateMinutes: 480, title, position });
  const subA = child('f3000000-0000-4000-8000-0000000000a1', 'Sub alpha', 0);
  const subB = child('f3000000-0000-4000-8000-0000000000b1', 'Sub bravo', 1);
  const subC = child('f3000000-0000-4000-8000-0000000000c1', 'Sub charlie', 2);
  const rootAfter: TaskDto = { ...task, id: 'f3000000-0000-4000-8000-0000000000f0', parentTaskId: null, workPackageId: 'f1000000-0000-4000-8000-0000000000f0', title: 'Root after', position: 1 };
  const SUB_D = 'f3000000-0000-4000-8000-0000000000d1';

  it('opens a sibling row after B, leaves no ghost on Escape and creates a detail sibling of the same parent', async () => {
    let stored: TaskDto[] = [parent, subA, subB, subC, rootAfter];
    const { calls } = installFakeApi(routes(() => stored, {
      [`POST ${rootPath}/tasks`]: request => {
        const body = request.body as CreateTaskInput;
        const row: TaskDto = { ...task, id: SUB_D, parentTaskId: body.parentTaskId ?? null, workPackageId: body.parentTaskId === parent.id && body.workScope === 'detail' ? PARENT_PACKAGE : 'f1000000-0000-4000-8000-0000000000d1', estimateMinutes: 480, title: body.title };
        stored = insertAfter(stored, body.insertion?.anchorTaskId, row);
        return created(stored.find(item => item.id === SUB_D));
      },
    }));
    const { user } = renderApp(tablePath);

    await enterOnUnchangedTitle(user, subB.title);
    const bRow = rowOf(screen.getByRole('button', { name: subB.title }));
    const cRow = rowOf(screen.getByRole('button', { name: subC.title }));
    const draftRow = rowOf(draftInput());
    expect(draftRow).not.toBe(bRow);
    expect(bRow.nextElementSibling).toBe(draftRow);
    expect(draftRow.nextElementSibling).toBe(cRow);
    expect(draftRow.cells.length).toBeGreaterThan(1);
    expect(draftRow.cells).toHaveLength(bRow.cells.length);
    expect(draftInput()).toHaveValue('');
    expect(writes(calls)).toHaveLength(0);

    // A typed but unsent sibling is dropped by Escape: no write, no ghost row, nothing on reopen.
    await user.keyboard('Ghost child');
    expect(draftInput()).toHaveValue('Ghost child');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Ghost child' })).not.toBeInTheDocument();
    expect(rowOf(screen.getByRole('button', { name: subB.title })).nextElementSibling).toBe(rowOf(screen.getByRole('button', { name: subC.title })));
    expect(writes(calls)).toHaveLength(0);
    expect(stored).toHaveLength(5);
    await enterOnUnchangedTitle(user, subB.title);
    expect(draftInput()).toHaveValue('');
    expect(screen.queryByDisplayValue('Ghost child')).not.toBeInTheDocument();

    // A titled Enter creates a detail sibling under P after B, without copying the shared estimate.
    await user.keyboard('Delta child{Enter}');
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    const body = posts(calls)[0]?.body as CreateTaskInput;
    expect(body).toMatchObject({ projectId: PROJECT_ID, title: 'Delta child', parentTaskId: parent.id, workScope: 'detail' });
    expect(body.insertion).toEqual({ anchorTaskId: subB.id, placement: 'after' });
    expect(body).not.toHaveProperty('estimateMinutes');
    expect(body).not.toHaveProperty('position');

    const savedRow = rowOf(await screen.findByRole('button', { name: 'Delta child' }));
    expect(savedRow.cells).toHaveLength(rowOf(screen.getByRole('button', { name: subB.title })).cells.length);
    await waitFor(() => expectRowOrder([parent.title, subA.title, subB.title, 'Delta child', subC.title, rootAfter.title]));
    expect(stored.map(item => item.title)).toEqual([parent.title, subA.title, subB.title, 'Delta child', subC.title, rootAfter.title]);
    expect(stored.find(item => item.id === SUB_D)).toMatchObject({ parentTaskId: parent.id, workPackageId: PARENT_PACKAGE });
    expect(posts(calls)).toHaveLength(1);
    expect(patches(calls)).toHaveLength(0);
  });
});
