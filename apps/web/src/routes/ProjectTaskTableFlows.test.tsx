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
const D = row('d1', 3, { title: 'Delta row' });

/**
 * A move as the server makes it: guarded by the task's revision, next to its anchor (a root task takes
 * the anchor's section), the whole order renumbered, and every written row's revision raised and
 * reported in `moveUndo.afterHeads`.
 */
const FIRST = 'f5000000-0000-4000-8000-0000000000f1';
const OTHER = 'f5000000-0000-4000-8000-0000000000f2';
const twoSections = [
  { id: FIRST, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'First section', position: 0, revision: 1, archivedAt: null },
  { id: OTHER, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Other section', position: 1, revision: 1, archivedAt: null },
];
const bulkUpdates = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks/bulk-update'));

/** A guarded bulk section change as the server makes it: every listed row at its next revision. */
function sectionChange(store: { rows: TaskDto[] }): RouteTable[string] {
  return request => {
    const body = request.body as { tasks: { taskId: string; expectedRevision: number }[]; changes: { sectionId: string | null } };
    if (body.tasks.some(target => store.rows.find(item => item.id === target.taskId)?.revision !== target.expectedRevision)) return failure(409, 'conflict', 'A task changed meanwhile');
    const changed = body.tasks.map(target => ({ ...store.rows.find(item => item.id === target.taskId) as TaskDto, sectionId: body.changes.sectionId, revision: target.expectedRevision + 1 }));
    store.rows = store.rows.map(item => changed.find(next => next.id === item.id) ?? item);
    return ok(changed);
  };
}

function moveRoutes(store: { rows: TaskDto[] }): RouteTable {
  const handler = renumberingMove(store);
  return Object.fromEntries(store.rows.map(item => [`POST ${rootPath}/tasks/${item.id}/move`, handler]));
}

function renumberingMove(store: { rows: TaskDto[] }): RouteTable[string] {
  return request => {
    const id = request.path.split('/').at(-2) ?? '';
    const body = request.body as { expectedRevision: number; anchorTaskId: string; placement: 'before' | 'after' };
    const moving = store.rows.find(item => item.id === id);
    const anchorRow = store.rows.find(item => item.id === body.anchorTaskId);
    if (!moving || !anchorRow) return failure(404, 'not_found', 'Missing task');
    if (moving.revision !== body.expectedRevision) return failure(409, 'conflict', 'The task changed meanwhile');
    const rest = store.rows.filter(item => item.id !== id);
    const at = rest.findIndex(item => item.id === anchorRow.id) + (body.placement === 'after' ? 1 : 0);
    const placed = { ...moving, sectionId: moving.parentTaskId === null ? anchorRow.sectionId : moving.sectionId };
    const before = new Map(store.rows.map(item => [item.id, item]));
    store.rows = [...rest.slice(0, at), placed, ...rest.slice(at)].map((item, position) => {
      const was = before.get(item.id);
      return was && (was.position !== position || item.id === id) ? { ...item, position, revision: item.revision + 1 } : item;
    });
    const written = store.rows.filter(item => before.get(item.id)?.revision !== item.revision).sort((x, y) => x.id.localeCompare(y.id));
    const moved = store.rows.find(item => item.id === id);
    return ok({ ...moved, moveUndo: {
      originalKey: request.headers.get('Idempotency-Key') ?? 'missing', orderFingerprint: 'fixture-order',
      beforeHeads: written.map(item => ({ taskId: item.id, revision: before.get(item.id)?.revision ?? 0 })),
      afterHeads: written.map(item => ({ taskId: item.id, revision: item.revision })),
    } });
  };
}
const preference = { workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: true }] };
type Calls = ReturnType<typeof installFakeApi>['calls'];
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const creates = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'));
const moves = (calls: Calls) => calls.filter(call => call.method === 'POST' && call.path.endsWith('/move'));
const nameInput = () => screen.getByRole('textbox', { name: 'Task name' });
const rowOf = (node: HTMLElement) => node.closest('tr') as HTMLTableRowElement;
const handleOf = (task: { title: string }) => screen.getByRole('button', { name: `Move task: ${task.title}` });
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
    // Task trees start collapsed.
    await user.click(await screen.findByRole('button', { name: `Expand subtasks of “${parent.title}”` }));

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
  it('sends one guarded move and shows the row at its drop place before the answer', async () => {
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
    expect(moves(calls)[0]?.body).toEqual({ expectedRevision: A.revision, anchorTaskId: C.id, placement: 'after', captureUndo: true });
    expect(moves(calls)[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    // The row shows at its drop place at once; the stored order still comes from the server.
    await waitFor(() => expect(order()).toEqual([B.id, C.id, A.id]));

    answer.resolve(undefined);
    await waitFor(() => expect(handleOf(A)).not.toHaveAttribute('aria-disabled'));
    expect(order()).toEqual([B.id, C.id, A.id]);
    expect(writes(calls)).toHaveLength(1);
  });

  it('returns a refused move to its stored place and says why the handle waits meanwhile', async () => {
    const answer = deferred<undefined>();
    installFakeApi(routes(() => [A, B, C], {
      [`POST ${rootPath}/tasks/${A.id}/move`]: async () => {
        await answer.promise;
        return failure(409, 'conflict', 'The task changed meanwhile');
      },
    }));
    const { user } = renderApp(tablePath);

    (await screen.findByRole('button', { name: `Move task: ${A.title}` })).focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(order()).toEqual([B.id, A.id, C.id]));
    // A blocked handle says it waits instead of silently not dragging.
    expect(handleOf(B)).toHaveAttribute('aria-disabled', 'true');
    expect(handleOf(B)).toHaveAttribute('title', 'Wait until the current save is confirmed, then move the task again.');

    answer.resolve(undefined);
    await waitFor(() => expect(order()).toEqual([A.id, B.id, C.id]));
  });

  it('moves the selected rows together, guarding each next move with the revision the previous answer reports', async () => {
    const store = { rows: [A, B, C, D] };
    const { calls } = installFakeApi(routes(() => store.rows, { ...moveRoutes(store) }));
    const { user } = renderApp(tablePath);

    await user.click(await screen.findByRole('button', { name: `Select task: ${A.title}` }));
    await user.keyboard('{Control>}'); await user.click(screen.getByRole('button', { name: `Select task: ${B.title}` })); await user.keyboard('{/Control}');
    await waitFor(() => expect(screen.getByRole('button', { name: `Select task: ${B.title}` })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: `Select task: ${A.title}` })).toHaveAttribute('aria-pressed', 'true');

    const target = within(rowOf(screen.getByRole('button', { name: D.title }))).getByRole('button', { name: D.title });
    await user.pointer({ keys: '[MouseLeft>]', target: handleOf(A), coords: { clientX: 2, clientY: 2 } });
    await user.pointer({ target, coords: { clientX: 2, clientY: 90 } });
    // The drag card says the other selected row moves too.
    expect(screen.getByTestId('task-drag-preview')).toHaveTextContent('+1 more');
    await user.pointer({ keys: '[/MouseLeft]', target, coords: { clientX: 2, clientY: 90 } });

    // Both rows show at the drop place at once, in the order they were shown.
    await waitFor(() => expect(order()).toEqual([C.id, D.id, A.id, B.id]));
    await waitFor(() => expect(moves(calls)).toHaveLength(2));
    expect(moves(calls).map(call => [call.path.split('/').at(-2), (call.body as { anchorTaskId: string }).anchorTaskId, (call.body as { placement: string }).placement])).toEqual([
      [A.id, D.id, 'after'], [B.id, A.id, 'after'],
    ]);
    // B was renumbered by the first move: the second move is guarded by the revision that answer reported.
    expect((moves(calls)[1]?.body as { expectedRevision: number }).expectedRevision).toBe(B.revision + 1);
    await waitFor(() => expect(handleOf(A)).not.toHaveAttribute('aria-disabled'));
    expect(order()).toEqual([C.id, D.id, A.id, B.id]);
  });

  it('moves the selected rows into another section next to the row they are dropped on', async () => {
    const other = 'f5000000-0000-4000-8000-0000000000e1';
    const first = 'f5000000-0000-4000-8000-0000000000e2';
    const store = { rows: [{ ...A, sectionId: first }, { ...B, sectionId: first }, { ...C, sectionId: first }, { ...D, sectionId: other }] };
    const sectionRow = (id: string, name: string, position: number) => ({ id, workspaceId: alpha.id, projectId: PROJECT_ID, name, position, revision: 1, archivedAt: null });
    const { calls } = installFakeApi(routes(() => store.rows, {
      [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok([sectionRow(first, 'First section', 0), sectionRow(other, 'Other section', 1)]),
      ...moveRoutes(store),
    }));
    const { user } = renderApp(tablePath);

    await user.click(await screen.findByRole('button', { name: `Select task: ${A.title}` }));
    await user.keyboard('{Control>}'); await user.click(screen.getByRole('button', { name: `Select task: ${C.title}` })); await user.keyboard('{/Control}');
    await waitFor(() => expect(screen.getByRole('button', { name: `Select task: ${C.title}` })).toHaveAttribute('aria-pressed', 'true'));

    const target = within(rowOf(screen.getByRole('button', { name: D.title }))).getByRole('button', { name: D.title });
    await user.pointer({ keys: '[MouseLeft>]', target: handleOf(C), coords: { clientX: 2, clientY: 2 } });
    await user.pointer({ target, coords: { clientX: 2, clientY: 90 } });
    await user.pointer({ keys: '[/MouseLeft]', target, coords: { clientX: 2, clientY: 90 } });

    await waitFor(() => expect(moves(calls)).toHaveLength(2));
    expect(moves(calls).map(call => [call.path.split('/').at(-2), (call.body as { anchorTaskId: string }).anchorTaskId, (call.body as { placement: string }).placement])).toEqual([
      [A.id, D.id, 'after'], [C.id, A.id, 'after'],
    ]);
    await waitFor(() => expect(store.rows.filter(item => item.sectionId === other).map(item => item.id)).toEqual([D.id, A.id, C.id]));
    const otherGroup = rowOf(screen.getByRole('button', { name: D.title })).closest('tbody');
    await waitFor(() => expect(within(otherGroup as HTMLElement).getByRole('button', { name: A.title })).toBeInTheDocument());
    expect(within(otherGroup as HTMLElement).getByRole('button', { name: C.title })).toBeInTheDocument();
  });

  it('moves the selected rows into an empty section with one guarded section change', async () => {
    const store = { rows: [{ ...A, sectionId: FIRST }, { ...B, sectionId: FIRST }, { ...C, sectionId: FIRST }] };
    const { calls } = installFakeApi(routes(() => store.rows, {
      [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(twoSections),
      [`POST ${rootPath}/tasks/bulk-update`]: sectionChange(store),
    }));
    const { user } = renderApp(tablePath);

    await user.click(await screen.findByRole('button', { name: `Select task: ${A.title}` }));
    await user.keyboard('{Control>}'); await user.click(screen.getByRole('button', { name: `Select task: ${C.title}` })); await user.keyboard('{/Control}');
    await waitFor(() => expect(screen.getByRole('button', { name: `Select task: ${C.title}` })).toHaveAttribute('aria-pressed', 'true'));

    const empty = screen.getByText('No tasks yet');
    await user.pointer({ keys: '[MouseLeft>]', target: handleOf(C), coords: { clientX: 2, clientY: 2 } });
    await user.pointer({ target: empty, coords: { clientX: 2, clientY: 90 } });
    expect(rowOf(empty)).toHaveAttribute('data-task-drop', 'after');
    await user.pointer({ keys: '[/MouseLeft]', target: empty, coords: { clientX: 2, clientY: 90 } });

    await waitFor(() => expect(bulkUpdates(calls)).toHaveLength(1));
    expect(bulkUpdates(calls)[0]?.body).toEqual({ projectId: PROJECT_ID, tasks: [{ taskId: A.id, expectedRevision: A.revision }, { taskId: C.id, expectedRevision: C.revision }], changes: { sectionId: OTHER } });
    expect(moves(calls)).toHaveLength(0);
    const otherGroup = () => rowOf(screen.getByRole('button', { name: A.title })).closest('tbody') as HTMLElement;
    await waitFor(() => expect(otherGroup()).toHaveAttribute('data-task-section-group', OTHER));
    expect(within(otherGroup()).getByRole('button', { name: C.title })).toBeInTheDocument();
    expect(within(otherGroup()).queryByRole('button', { name: B.title })).not.toBeInTheDocument();
  });

  it('moves a single row into an empty section too', async () => {
    const store = { rows: [{ ...A, sectionId: FIRST }, { ...B, sectionId: FIRST }] };
    const { calls } = installFakeApi(routes(() => store.rows, {
      [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(twoSections),
      [`POST ${rootPath}/tasks/bulk-update`]: sectionChange(store),
    }));
    const { user } = renderApp(tablePath);

    const empty = await screen.findByText('No tasks yet');
    await user.pointer({ keys: '[MouseLeft>]', target: handleOf(B), coords: { clientX: 2, clientY: 2 } });
    await user.pointer({ target: empty, coords: { clientX: 2, clientY: 90 } });
    await user.pointer({ keys: '[/MouseLeft]', target: empty, coords: { clientX: 2, clientY: 90 } });

    await waitFor(() => expect(bulkUpdates(calls)).toHaveLength(1));
    expect((bulkUpdates(calls)[0]?.body as { tasks: unknown[] }).tasks).toEqual([{ taskId: B.id, expectedRevision: B.revision }]);
    await waitFor(() => expect(rowOf(screen.getByRole('button', { name: B.title })).closest('tbody')).toHaveAttribute('data-task-section-group', OTHER));
  });

  it('puts rows dropped on a section header at the top of that section', async () => {
    const store = { rows: [{ ...A, sectionId: FIRST }, { ...B, sectionId: FIRST }, { ...C, sectionId: OTHER }, { ...D, sectionId: OTHER }] };
    const { calls } = installFakeApi(routes(() => store.rows, {
      [`GET ${rootPath}/projects/${PROJECT_ID}/sections`]: () => ok(twoSections),
      ...moveRoutes(store),
    }));
    const { user } = renderApp(tablePath);

    await user.click(await screen.findByRole('button', { name: `Select task: ${A.title}` }));
    await user.keyboard('{Control>}'); await user.click(screen.getByRole('button', { name: `Select task: ${B.title}` })); await user.keyboard('{/Control}');
    await waitFor(() => expect(screen.getByRole('button', { name: `Select task: ${B.title}` })).toHaveAttribute('aria-pressed', 'true'));

    const header = rowOf(within(rowOf(screen.getByRole('button', { name: C.title })).closest('tbody') as HTMLElement).getAllByRole('rowheader')[0] as HTMLElement);
    await user.pointer({ keys: '[MouseLeft>]', target: handleOf(A), coords: { clientX: 2, clientY: 2 } });
    await user.pointer({ target: header, coords: { clientX: 2, clientY: 90 } });
    await user.pointer({ keys: '[/MouseLeft]', target: header, coords: { clientX: 2, clientY: 90 } });

    await waitFor(() => expect(moves(calls)).toHaveLength(2));
    expect(moves(calls).map(call => [call.path.split('/').at(-2), (call.body as { anchorTaskId: string }).anchorTaskId, (call.body as { placement: string }).placement])).toEqual([
      [A.id, C.id, 'before'], [B.id, A.id, 'after'],
    ]);
    await waitFor(() => expect(store.rows.filter(item => item.sectionId === OTHER).map(item => item.id)).toEqual([A.id, B.id, C.id, D.id]));
  });

  it('refuses further moves while a move outcome is unknown', async () => {
    const { calls } = installFakeApi(routes(() => [A, B, C], {
      [`POST ${rootPath}/tasks/${A.id}/move`]: () => failure(503, 'unavailable', 'Temporarily unavailable'),
    }));
    const { user } = renderApp(tablePath);

    (await screen.findByRole('button', { name: `Move task: ${A.title}` })).focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(moves(calls)).toHaveLength(1));
    expect(moves(calls)[0]?.body).toEqual({ expectedRevision: A.revision, anchorTaskId: B.id, placement: 'after', captureUndo: true });

    const other = await screen.findByRole('button', { name: `Move task: ${B.title}` });
    await waitFor(() => expect(other).toHaveAttribute('aria-disabled', 'true'));
    other.focus();
    await user.keyboard('{ArrowDown}');
    expect(moves(calls)).toHaveLength(1);
    expect(order()).toEqual([A.id, B.id, C.id]);
  });
});
