import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alpha, alphaMembers, deferred, failure, installFakeApi, json, ok, renderApp, type RouteTable } from '../test/fakeApi';
import { lostResponse } from '../features/planning/test/fixtures';
import { PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

// Compile the large lazy route before the first DOM wait; these tests exercise its UI, not module loading.
beforeAll(async () => { await import('./ProjectPage'); });

const NEXT = 'f6000000-0000-4000-8000-000000000002';
const DONE_A = 'f6000000-0000-4000-8000-000000000003';
const DONE_B = 'f6000000-0000-4000-8000-000000000004';
const UNKNOWN = 'f6000000-0000-4000-8000-000000000099';
const other = { ...task, id: 'f2000000-0000-4000-8000-000000000002', title: 'Other loaded task', workPackageId: 'f1000000-0000-4000-8000-000000000002', statusId: NEXT };
const statuses: TaskStatusDto[] = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
  { id: NEXT, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
  { id: DONE_A, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored done A', group: 'done', position: 2, revision: 1 },
  { id: DONE_B, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored done B', group: 'done', position: 3, revision: 1 },
];
const page = (rows: TaskDto[], nextCursor: string | null = null) => json(200, { data: rows, meta: { requestId: 'qa-board-page', nextCursor } });
function routes(extra: RouteTable = {}): RouteTable {
  return { ...tableRoutes(), [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok(statuses), [`GET ${rootPath}/tasks`]: () => page([task]), [`GET ${rootPath}/tasks/${task.id}`]: () => ok(task), [`GET ${rootPath}/tasks/${other.id}`]: () => ok(other), ...extra };
}
function views() { return within(screen.getByRole('navigation', { name: 'Project views' })); }
async function board(user: ReturnType<typeof renderApp>['user']) {
  await user.click(await views().findByRole('button', { name: 'Board' }));
  await screen.findByRole('region', { name: 'Task status lanes' });
}
async function closeDrawer(user: ReturnType<typeof renderApp>['user']) { await user.keyboard('{Escape}'); await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); }

/** Choosing in the open custom status list is the explicit save. */
const choose = (user: ReturnType<typeof renderApp>['user'], option: string) => user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name: option }));
const statusPicker = () => screen.getByRole('combobox', { name: 'Status' });

describe('project Board integration', () => {
  it('switches the same filtered loaded set between Table and Board and uses the existing task drawer', async () => {
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => page(request.searchParams.get('statusId') === NEXT ? [other] : [task, other]) }));
    const { user } = renderApp(tablePath);
    await screen.findByRole('table');
    await screen.findByRole('button', { name: task.title });
    await user.click(screen.getByText('Filters', { selector: 'summary' })); await user.selectOptions(screen.getByLabelText('Task status'), NEXT);
    await waitFor(() => expect(screen.queryByRole('button', { name: task.title })).not.toBeInTheDocument());
    await board(user);
    expect(screen.getByLabelText('Task status')).toHaveValue(NEXT);
    expect(screen.getByText('1 loaded task in this view.')).toBeVisible();
    expect(screen.queryByText('More matching tasks may be available. Counts cover only the loaded tasks in this view.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: other.title }));
    const drawer = await screen.findByRole('dialog', { name: other.title }); expect(within(drawer).getByLabelText('Task name')).toHaveValue(other.title);
    await closeDrawer(user); await user.click(views().getByRole('button', { name: 'Tasks' }));
    expect(screen.getByRole('table')).toBeInTheDocument(); expect(screen.getByLabelText('Task status')).toHaveValue(NEXT);
    expect(screen.queryByRole('button', { name: task.title })).not.toBeInTheDocument();
    expect(calls.filter(call => call.path.endsWith('/tasks') && call.method === 'GET').at(-1)?.searchParams.get('statusId')).toBe(NEXT);
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
  });

  it('passes one optional tag alongside the other filters and preserves it across Table and Board', async () => {
    const tag = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Stored task tag', color: null, revision: 1, archivedAt: null };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tags`]: () => ok([tag]), [`GET ${rootPath}/tasks`]: request => page(request.searchParams.has('tagId') ? [other] : [task, other]) }));
    const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: task.title });
    expect(calls.find(call => call.path.endsWith('/tasks'))?.searchParams.has('tagId')).toBe(false);
    await user.click(screen.getByText('Filters', { selector: 'summary' }));
    await user.selectOptions(screen.getByLabelText('Task status'), NEXT);
    await user.selectOptions(screen.getByLabelText('Task tag'), tag.id);
    await waitFor(() => expect(screen.queryByRole('button', { name: task.title })).not.toBeInTheDocument());
    await board(user); expect(screen.getByLabelText('Task tag')).toHaveValue(tag.id);
    const matching = calls.filter(call => call.path.endsWith('/tasks')).at(-1);
    expect(matching?.searchParams.get('tagId')).toBe(tag.id); expect(matching?.searchParams.get('statusId')).toBe(NEXT);
    await user.click(views().getByRole('button', { name: 'Tasks' })); expect(screen.getByLabelText('Task tag')).toHaveValue(tag.id);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await screen.findByRole('button', { name: task.title });
    expect(screen.getByLabelText('Task tag')).toHaveValue(''); expect(screen.getByLabelText('Task status')).toHaveValue('');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('merges duplicate pages before the board and edits the independently current task revision exactly', async () => {
    const old = { ...task, title: 'Old row title', workPackageRevision: 7, estimateMinutes: 600 };
    let newest: TaskDto = { ...task, title: 'Newest row title', statusId: NEXT, revision: 3, workPackageRevision: 2, estimateMinutes: 60, participantsRevision: 5, participants: [{ membershipId: alphaMembers[1]?.id ?? '', active: true, role: 'assignee', revision: 1 }] };
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => request.searchParams.has('cursor') ? page([newest, other]) : page([old], 'board-next'), [`PATCH ${rootPath}/tasks/${task.id}`]: request => ok(newest = { ...newest, statusId: (request.body as { statusId: string }).statusId, revision: 4 }) }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await screen.findByText('1 loaded task in this view.'); await user.click(screen.getByRole('button', { name: 'Load more tasks' }));
    await screen.findByText('2 loaded tasks in this view.'); expect(screen.queryByRole('button', { name: 'Old row title' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Newest row title' })).toHaveLength(1);
    const card = screen.getByRole('button', { name: 'Newest row title' }).closest('li'); if (!card) throw new Error('Missing card');
    await user.click(within(card).getByRole('button', { name: 'Change status' }));
    expect(statusPicker()).toHaveTextContent('Stored progress');
    await choose(user, 'Stored todo');
    await waitFor(() => expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ expectedRevision: 3, statusId: task.statusId });
    await user.click(views().getByRole('button', { name: 'Tasks' }));
    await screen.findByRole('table'); expect(screen.getByText('Loaded team budget').closest('tr')).toHaveTextContent('30h');
    const row = screen.getByRole('button', { name: 'Newest row title' }).closest('tr'); if (!row) throw new Error('Missing current task row');
    expect(within(row).getByText('10h')).toBeInTheDocument();
  });

  it('retains an unknown status write across Table/Board even when personal table columns hide Status', async () => {
    const first = lostResponse(); let attempt = 0; let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: alphaMembers[0]?.id, revision: 1, columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'status' }, visible: false }] }), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : ok(current = { ...task, statusId: NEXT, revision: 2 }) }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    await choose(user, 'Stored progress');
    await waitFor(() => expect(attempt).toBe(1)); await act(async () => first.lose()); await screen.findByRole('button', { name: 'Retry' });
    await user.click(views().getByRole('button', { name: 'Tasks' })); expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Resume original editor' }); await board(user);
    await user.click(screen.getByRole('button', { name: 'Change status' }));
    expect(statusPicker()).toHaveTextContent('Stored progress'); expect(statusPicker()).toBeDisabled(); expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempt).toBe(2)); await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument());
    const writes = calls.filter(call => call.method === 'PATCH'); expect(writes[0]?.body).toEqual({ expectedRevision: 1, statusId: NEXT });
    expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('preserves pending status recovery while its card is filtered out, then clears only the confirmed session', async () => {
    const gate = deferred<Response>(); let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => page(request.searchParams.has('search') ? [] : [current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Change status' })); await choose(user, 'Stored progress');
    await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
    await user.type(screen.getByLabelText('Search tasks'), 'not matching');
    await screen.findByText('0 loaded tasks in this view.'); await screen.findByRole('button', { name: 'Resume original editor' });
    const search = screen.getByLabelText('Search tasks'); expect(search).toHaveFocus();
    current = { ...task, statusId: NEXT, revision: 2 }; await act(async () => gate.resolve(ok(current)));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resume original editor' })).not.toBeInTheDocument());
    expect(search).toHaveFocus(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.clear(search); await screen.findByRole('button', { name: task.title });
    expect(screen.queryByText('Draft kept')).not.toBeInTheDocument(); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it.each(['quick', 'due'] as const)('keeps a hidden %s draft recoverable when switching to Board', async kind => {
    const { calls } = installFakeApi(routes()); const { user } = renderApp(tablePath);
    await screen.findByRole('button', { name: task.title });
    if (kind === 'quick') {
      await user.click(screen.getByRole('button', { name: 'Add task without a section' })); await user.type(screen.getByLabelText('Task name'), 'Unsent quick title');
    } else {
      await user.click(screen.getByRole('button', { name: `Edit due date for ${task.title}` })); fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-20' } });
    }
    await board(user); expect(screen.queryByLabelText(kind === 'quick' ? 'Task name' : 'Due date')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resume original editor' }));
    const dialog = await screen.findByRole('dialog', { name: kind === 'quick' ? 'New task' : task.title });
    expect(within(dialog).getByLabelText(kind === 'quick' ? 'Task name' : 'Due date')).toHaveValue(kind === 'quick' ? 'Unsent quick title' : '2026-10-20');
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('keeps separate empty done lanes and neutral unknown-status lanes while viewers cannot start status edits', async () => {
    const { calls } = installFakeApi(routes({ 'GET /api/v1/workspaces': () => ok([{ ...alpha, role: 'viewer' }]), [`GET ${rootPath}`]: () => ok({ ...alpha, role: 'viewer' }), [`GET ${rootPath}/memberships`]: () => ok(alphaMembers.map((member, index) => index === 0 ? { ...member, role: 'viewer' } : member)), [`GET ${rootPath}/tasks`]: () => page([{ ...task, statusId: UNKNOWN }, other]) }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await screen.findByRole('heading', { name: 'Stored done A' }); expect(screen.getByRole('heading', { name: 'Stored done B' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Status unavailable (1)' })).toBeVisible(); expect(screen.queryByText(UNKNOWN)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: other.title })); await screen.findByRole('dialog', { name: other.title });
    expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  });

  it('focuses a deliberately opened status list and returns to its card action after Escape or a confirmed choice', async () => {
    let current = task;
    const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => ok(current = { ...task, statusId: NEXT, revision: 2 }) }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Change status' }));
    expect(statusPicker()).toHaveFocus(); expect(screen.getByRole('listbox', { name: 'Status' })).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change status' })).toHaveFocus());
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0);
    await user.keyboard('{Enter}'); expect(statusPicker()).toHaveFocus(); expect(statusPicker()).toHaveTextContent('Stored todo');
    await choose(user, 'Stored progress');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Change status' })).toHaveFocus());
    const lane = screen.getByRole('heading', { name: 'Stored progress' }).closest('section'); if (!lane) throw new Error('Missing current lane');
    expect(within(lane).getByRole('button', { name: task.title })).toBeInTheDocument(); expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('keeps loaded cards after a next-page error and retries that page explicitly', async () => {
    let next = 0;
    installFakeApi(routes({ [`GET ${rootPath}/tasks`]: request => request.searchParams.has('cursor') ? ++next === 1 ? failure(503, 'UNAVAILABLE', 'private page failure') : page([other]) : page([task], 'board-next') }));
    const { user } = renderApp(`${tablePath}?view=board`);
    await user.click(await screen.findByRole('button', { name: 'Load more tasks' }));
    await screen.findByRole('button', { name: 'Try again' }); expect(screen.getByRole('button', { name: task.title })).toBeVisible();
    expect(screen.queryByText('private page failure')).not.toBeInTheDocument(); await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('2 loaded tasks in this view.'); expect(screen.getByRole('button', { name: other.title })).toBeVisible();
  });

  it('matches only exact view=board and leaves other values on the existing table fallback', async () => {
    installFakeApi(routes()); renderApp(`${tablePath}?view=boardwalk`);
    await screen.findByRole('table'); expect(views().getByRole('button', { name: 'Tasks' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('region', { name: 'Task status lanes' })).not.toBeInTheDocument();
  });
});

it('reconciles a pending status session across Board→Table→Board after confirmation without a second update or focus steal', async () => {
  const gate = deferred<Response>(); let current = task;
  const { calls } = installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([current]), [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise }));
  const { user } = renderApp(`${tablePath}?view=board`);
  await user.click(await screen.findByRole('button', { name: 'Change status' })); await choose(user, 'Stored progress');
  await waitFor(() => expect(calls.some(call => call.method === 'PATCH')).toBe(true));
  await user.click(views().getByRole('button', { name: 'Tasks' })); expect(statusPicker()).toBeDisabled();
  await board(user); expect(statusPicker()).toBeDisabled();
  const focus = document.activeElement; current = { ...task, statusId: NEXT, revision: 2 };
  await act(async () => gate.resolve(ok(current)));
  await waitFor(() => expect(statusPicker()).toBeEnabled());
  expect(document.activeElement).toBe(focus); expect(statusPicker()).toHaveTextContent('Stored progress');
  await user.click(statusPicker()); await choose(user, 'Stored progress');
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});

it('keeps a dependency-enforced status rejection in the original lane without claiming completion', async () => {
  const { calls } = installFakeApi(routes({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'DEPENDENCY_BLOCKED', 'private predecessor details') }));
  const { user } = renderApp(`${tablePath}?view=board`);
  await user.click(await screen.findByRole('button', { name: 'Change status' })); await choose(user, 'Stored done A');
  await waitFor(() => expect(screen.getByRole('alert')).toBeVisible()); expect(statusPicker()).toBeDisabled();
  const originalLane = screen.getByRole('heading', { name: 'Stored todo' }).closest('section'); if (!originalLane) throw new Error('Missing status lane');
  expect(within(originalLane).getByRole('button', { name: task.title })).toBeInTheDocument();
  expect(statusPicker()).toHaveTextContent('Stored done A'); expect(screen.queryByText('private predecessor details')).not.toBeInTheDocument();
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
});

it.each(['meeting', 'archived', 'unknown-type'] as const)('does not start a generic Board status edit for %s tasks', async kind => {
  const item = { ...task, meetingId: kind === 'meeting' ? 'fa000000-0000-4000-8000-000000000001' : kind === 'unknown-type' ? undefined : null, archivedAt: kind === 'archived' ? '2026-10-19T12:00:00.000Z' : null };
  installFakeApi(routes({ [`GET ${rootPath}/tasks`]: () => page([item]) })); renderApp(`${tablePath}?view=board`);
  await screen.findByRole('button', { name: task.title });
  expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
});
