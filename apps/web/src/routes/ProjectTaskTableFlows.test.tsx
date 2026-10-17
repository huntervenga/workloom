import type { TaskDto } from '@workloom/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, created, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';
beforeAll(async () => { await import('./ProjectPage'); });

const row = (suffix: string, position: number, extra: Partial<TaskDto> = {}): TaskDto => ({
  ...task, id: `f2000000-0000-4000-8000-0000000000${suffix}`, workPackageId: `f1000000-0000-4000-8000-0000000000${suffix}`, title: `Row ${suffix}`, position, ...extra,
});
const A = row('a1', 0, { title: 'Alpha row' });
const B = row('b1', 1, { title: 'Bravo row' });
const C = row('c1', 2, { title: 'Charlie row' });
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: true }] };
type Calls = ReturnType<typeof installFakeApi>['calls'];
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const creates = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'));
const moves = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path.endsWith('/move'));
const nameInput = () => screen.getByRole('textbox', { name: 'Task name' });
const rowOf = (node: HTMLElement) => node.closest('tr') as HTMLTableRowElement;
/** Real rows by task ID and draft rows by state, in document order. */
const order = () => [...document.querySelectorAll('tr[data-task-row], tr[data-task-draft-row]')]
  .map(item => item.getAttribute('data-task-row') ?? `draft:${item.getAttribute('data-task-draft-state') ?? ''}`);
const reposition = (rows: TaskDto[]) => rows.map((item, position) => ({ ...item, position }));

function routes(rows: () => TaskDto[], extra: RouteTable = {}): RouteTable {
  return {
    ...tableRoutes(),
    [`GET ${rootPath}/tasks`]: () => json(200, { data: rows(), meta: { requestId: 'flows-fixture', nextCursor: null } }),
    [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok(preference),
    ...extra,
  };
}

/** Stores a create right after its requested anchor, as the server does. */
function insertingCreate(store: { rows: TaskDto[] }, ids: string[]): RouteTable[string] {
  return request => {
    const body = request.body as { title: string; parentTaskId?: string | null; insertion?: { anchorTaskId: string } };
    const createdRow = row(ids.shift() ?? 'ff', 0, { title: body.title, parentTaskId: body.parentTaskId ?? null });
    const at = store.rows.findIndex(item => item.id === body.insertion?.anchorTaskId);
    store.rows = reposition(at < 0 ? [...store.rows, createdRow] : [...store.rows.slice(0, at + 1), createdRow, ...store.rows.slice(at + 1)]);
    return created(store.rows.find(item => item.id === createdRow.id));
  };
}

async function enterOnUnchangedTitle(user: ReturnType<typeof renderApp>['user'], title: string) {
  await user.click(await screen.findByRole('button', { name: title }));
  await waitFor(() => expect(nameInput()).toHaveValue(title));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(nameInput()).toHaveValue(''));
}

describe('continuing with Enter in the middle of a list', () => {
  it('chains each new row right after the previous one and keeps the next input in place', async () => {
    const store = { rows: [A, B, C] };
    const { calls } = installFakeApi(routes(() => store.rows, { [`POST ${rootPath}/tasks`]: insertingCreate(store, ['d1', 'e1']) }));
    const { user } = renderApp(tablePath);

    await enterOnUnchangedTitle(user, B.title);
    expect(order()).toEqual([A.id, B.id, 'draft:draft', C.id]);
    await user.keyboard('First new{Enter}');
    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0]?.body).toMatchObject({ title: 'First new', insertion: { anchorTaskId: B.id, placement: 'after' } });
    expect(creates(calls)[0]?.body).not.toHaveProperty('position');

    // The second create is anchored to the first one's confirmed server ID.
    await user.keyboard('Second new{Enter}');
    await waitFor(() => expect(creates(calls)).toHaveLength(2));
    expect(creates(calls)[1]?.body).toMatchObject({ title: 'Second new', insertion: { anchorTaskId: row('d1', 0).id, placement: 'after' } });
    await screen.findByRole('button', { name: 'Second new' });
    await waitFor(() => expect(order()).toEqual([A.id, B.id, row('d1', 0).id, row('e1', 0).id, 'draft:draft', C.id]));
    expect(nameInput()).toHaveValue('');
    expect(nameInput()).toHaveFocus();
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
  });

  it('keeps a submitted row while Escape drops only the unsent text', async () => {
    const answer = deferred<Response>();
    const store = { rows: [A, B, C] };
    const { calls } = installFakeApi(routes(() => store.rows, {
      [`POST ${rootPath}/tasks`]: async request => {
        await answer.promise;
        return insertingCreate(store, ['d1'])(request);
      },
    }));
    const { user } = renderApp(tablePath);

    await enterOnUnchangedTitle(user, B.title);
    await user.keyboard('Sent title{Enter}');
    await user.keyboard('Unsent title');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task name' })).not.toBeInTheDocument());
    // The waiting row is still shown in place; the unsent text left no row and no request.
    expect(order()).toEqual([A.id, B.id, 'draft:pending', C.id]);
    expect(screen.getByText('Sent title')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Unsent title')).not.toBeInTheDocument();

    answer.resolve(new Response(null));
    await screen.findByRole('button', { name: 'Sent title' });
    await waitFor(() => expect(order()).toEqual([A.id, B.id, row('d1', 0).id, C.id]));
    expect(creates(calls)).toHaveLength(1);
    expect(writes(calls)).toHaveLength(1);
  });

  it('continues a subtask with a sibling right after it, under the same parent', async () => {
    const parent = row('a2', 0, { title: 'Parent row' });
    const first = row('b2', 1, { title: 'First child', parentTaskId: parent.id });
    const second = row('c2', 2, { title: 'Second child', parentTaskId: parent.id });
    const store = { rows: [parent, first, second] };
    const { calls } = installFakeApi(routes(() => store.rows, { [`POST ${rootPath}/tasks`]: insertingCreate(store, ['d2']) }));
    const { user } = renderApp(tablePath);

    await enterOnUnchangedTitle(user, first.title);
    expect(order()).toEqual([parent.id, first.id, 'draft:draft', second.id]);
    await user.keyboard('New sibling{Enter}');
    await waitFor(() => expect(creates(calls)).toHaveLength(1));
    expect(creates(calls)[0]?.body).toMatchObject({ title: 'New sibling', parentTaskId: parent.id, insertion: { anchorTaskId: first.id, placement: 'after' } });
    await screen.findByRole('button', { name: 'New sibling' });
    await waitFor(() => expect(order()).toEqual([parent.id, first.id, row('d2', 0).id, 'draft:draft', second.id]));
  });
});

describe('row title, free area and actions', () => {
  it('renames from the name text, opens details from the free area and keeps every action in the menu', async () => {
    const { calls } = installFakeApi(routes(() => [A, B, C], { [`GET ${rootPath}/tasks/${B.id}`]: () => ok(B) }));
    const { user } = renderApp(tablePath);

    const title = await screen.findByRole('button', { name: B.title });
    const open = screen.getByRole('button', { name: `Open task “${B.title}”` });
    expect(open.contains(title)).toBe(false);
    expect(title.contains(open)).toBe(false);

    await user.click(title);
    await waitFor(() => expect(nameInput()).toHaveValue(B.title));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    // Right click anywhere in the row offers the same menu as its accessible trigger.
    fireEvent.contextMenu(rowOf(screen.getByRole('button', { name: B.title })));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Open details' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Add subtask' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: `Task actions: ${B.title}` })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Open task “${B.title}”` }));
    expect(await screen.findByRole('dialog', { name: B.title })).toBeInTheDocument();
    expect(writes(calls)).toHaveLength(0);
  });
});

describe('manual reorder', () => {
  it('sends one guarded move and shows the order only from the refetched list', async () => {
    const answer = deferred<undefined>();
    let stored = [A, B, C];
    const { calls } = installFakeApi(routes(() => stored, {
      [`POST ${rootPath}/tasks/${A.id}/move`]: async () => {
        await answer.promise;
        stored = reposition([B, C, { ...A, revision: A.revision + 1 }]);
        return ok(stored[2]);
      },
    }));
    const { user } = renderApp(tablePath);

    const handle = await screen.findByRole('button', { name: `Move task: ${A.title}` });
    const target = within(rowOf(screen.getByRole('button', { name: C.title }))).getByRole('button', { name: C.title });
    await user.pointer({ keys: '[MouseLeft>]', target: handle, coords: { clientX: 2, clientY: 2 } });
    await user.pointer({ target, coords: { clientX: 2, clientY: 90 } });
    expect(rowOf(target)).toHaveAttribute('data-task-drop', 'after');
    await user.pointer({ keys: '[/MouseLeft]', target, coords: { clientX: 2, clientY: 90 } });

    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]?.body).toEqual({ expectedRevision: A.revision, anchorTaskId: C.id, placement: 'after' });
    expect(moves(calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    // The pointer position is not persistence: nothing moves before the server answers.
    expect(order()).toEqual([A.id, B.id, C.id]);

    answer.resolve(undefined);
    await waitFor(() => expect(order()).toEqual([B.id, C.id, A.id]));
    expect(writes(calls)).toHaveLength(1);
  });

  it('refuses further moves while a move outcome is unknown', async () => {
    const { calls } = installFakeApi(routes(() => [A, B, C], {
      [`POST ${rootPath}/tasks/${A.id}/move`]: () => failure(503, 'unavailable', 'Temporarily unavailable'),
    }));
    const { user } = renderApp(tablePath);

    (await screen.findByRole('button', { name: `Move task: ${A.title}` })).focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]?.body).toEqual({ expectedRevision: A.revision, anchorTaskId: B.id, placement: 'after' });

    const other = await screen.findByRole('button', { name: `Move task: ${B.title}` });
    await waitFor(() => expect(other).toHaveAttribute('aria-disabled', 'true'));
    other.focus();
    await user.keyboard('{ArrowDown}');
    expect(moves(calls)).toHaveLength(1);
    expect(order()).toEqual([A.id, B.id, C.id]);
  });
});
