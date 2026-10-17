import type { TaskDto, TaskStatusDto, TaskStatusGroup } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../app/AppRoutes';
import { ProtectedNavigationGuard } from '../app/ProtectedNavigationGuard';
import { SessionProvider } from '../app/session';
import { createQueryClient } from '../lib/queryClient';
import { alpha, installFakeApi, json, ok, type RouteTable } from '../test/fakeApi';
import { chooseFilter, filterPicker } from '../features/tasks/test/filterPickers';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, task, tablePath, tableRoutes } from '../features/work-categories/test/fixtures';

beforeAll(async () => { await import('./ProjectPage'); });
const REVIEW = 'f6000000-0000-4000-8000-000000000012';
const DONE = 'f6000000-0000-4000-8000-000000000013';
const DROPPED = 'f6000000-0000-4000-8000-000000000014';
const base: TaskStatusDto = { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored active', group: 'todo', position: 0, revision: 1 };
const statuses: TaskStatusDto[] = [
  base,
  { ...base, id: REVIEW, name: 'Custom review', group: 'in_progress', position: 1 },
  { ...base, id: DONE, name: 'Stored done', group: 'done', position: 2 },
  { ...base, id: DROPPED, name: 'Custom dropped', group: 'cancelled', position: 3 },
];
const row = (n: number, title: string, statusId: string): TaskDto => ({ ...task, id: `f2000000-0000-4000-8000-00000000001${n}`, title, statusId, workPackageId: `f1000000-0000-4000-8000-00000000001${n}` });
const review = row(1, 'Custom review task', REVIEW);
const finished = row(2, 'Finished task', DONE);
const dropped = row(3, 'Dropped task', DROPPED);

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
/**
 * The mocked server applies `completion=open` itself, by status group: todo and in-progress
 * statuses (custom ones included) stay, done and cancelled ones are left out. Every page is the last.
 */
function app(url: string, state: { current: TaskDto } = { current: task }, extra: RouteTable = {}) {
  const group = (statusId: string): TaskStatusGroup | undefined => statuses.find(status => status.id === statusId)?.group;
  const api = installFakeApi({
    ...tableRoutes(),
    [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok(statuses),
    [`GET ${rootPath}/tasks/${task.id}`]: () => ok(state.current),
    [`GET ${rootPath}/tasks`]: request => {
      const rows = [state.current, review, finished, dropped];
      const open = request.searchParams.get('completion') === 'open';
      const data = open ? rows.filter(item => group(item.statusId) === 'todo' || group(item.statusId) === 'in_progress') : rows;
      return json(200, { data, meta: { requestId: 'completion-filter-fixture', nextCursor: null } });
    },
    ...extra,
  });
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [url] });
  const view = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  cleanups.push(() => { view.unmount(); router.dispose(); client.clear(); });
  return { ...view, ...api, client, router, user: userEvent.setup({ pointerEventsCheck: 0 }) };
}
type Calls = ReturnType<typeof installFakeApi>['calls'];
// Only the project list reads; the drawer may read its own subtask scope.
const listCalls = (calls: Calls) => calls.filter(call => call.method === 'GET' && call.path === `${rootPath}/tasks` && !call.searchParams.has('parentTaskId'));
const writes = (calls: Calls) => calls.filter(call => call.method !== 'GET');
const params = (ui: ReturnType<typeof app>) => new URLSearchParams(ui.router.state.location.search);
const openRow = (title: string) => ({ name: `Open task “${title}”` });

describe('project task completion filter', () => {
  it('requests open tasks from the server, keeps URL context and hash, and survives Back, Forward and reload', async () => {
    const ui = app(`${tablePath}?sort=due_asc&week=${PERIOD_A}&worker=${MEMBER_ID}&other=kept#anchor`);
    await screen.findByRole('button', openRow(finished.title));
    expect(filterPicker('Task completion')).toHaveTextContent('All tasks');
    expect(listCalls(ui.calls).every(call => !call.searchParams.has('completion'))).toBe(true);

    await chooseFilter(ui.user, 'Task completion', 'Incomplete tasks');
    await waitFor(() => expect(params(ui).get('completion')).toBe('open'));
    expect(Object.fromEntries(params(ui))).toEqual({ sort: 'due_asc', week: PERIOD_A, worker: MEMBER_ID, other: 'kept', completion: 'open' });
    expect(ui.router.state.location.hash).toBe('#anchor');
    await waitFor(() => expect(screen.queryByRole('button', openRow(finished.title))).not.toBeInTheDocument());
    const request = listCalls(ui.calls).at(-1);
    expect(request?.searchParams.get('completion')).toBe('open'); expect(request?.searchParams.get('sort')).toBe('due_asc'); expect(request?.searchParams.has('cursor')).toBe(false);
    // Custom todo/in-progress statuses stay because the server returned them; nothing was filtered locally.
    expect(screen.getByRole('button', openRow(task.title))).toBeInTheDocument();
    expect(screen.getByRole('button', openRow(review.title))).toBeInTheDocument();
    expect(screen.queryByRole('button', openRow(dropped.title))).not.toBeInTheDocument();
    expect(screen.getByText('Filters (1)', { selector: 'summary' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Active filters' })).getByRole('button', { name: 'Show all tasks, including completed' })).toBeInTheDocument();

    await act(async () => ui.router.navigate(-1));
    await waitFor(() => expect(filterPicker('Task completion')).toHaveTextContent('All tasks'));
    expect(params(ui).has('completion')).toBe(false);
    expect(await screen.findByRole('button', openRow(finished.title))).toBeInTheDocument();
    await act(async () => ui.router.navigate(1));
    await waitFor(() => expect(filterPicker('Task completion')).toHaveTextContent('Incomplete tasks'));
    await waitFor(() => expect(screen.queryByRole('button', openRow(finished.title))).not.toBeInTheDocument());
    const reloadUrl = `${ui.router.state.location.pathname}${ui.router.state.location.search}${ui.router.state.location.hash}`;
    expect(writes(ui.calls)).toHaveLength(0);
    cleanups.splice(0).forEach(cleanup => cleanup());

    const reload = app(reloadUrl);
    await screen.findByRole('button', openRow(review.title));
    expect(filterPicker('Task completion')).toHaveTextContent('Incomplete tasks');
    expect(listCalls(reload.calls)[0]?.searchParams.get('completion')).toBe('open');
    expect(screen.queryByRole('button', openRow(finished.title))).not.toBeInTheDocument();
    expect(reload.router.state.location.hash).toBe('#anchor');
    expect(writes(reload.calls)).toHaveLength(0);
  });

  it('All tasks removes only the completion key and Clear filters clears it too', async () => {
    const ui = app(`${tablePath}?completion=open&view=board&other=kept#anchor`);
    await screen.findByRole('region', { name: 'Task status lanes' });
    await chooseFilter(ui.user, 'Task completion', 'All tasks');
    await waitFor(() => expect(params(ui).has('completion')).toBe(false));
    expect(Object.fromEntries(params(ui))).toEqual({ view: 'board', other: 'kept' }); expect(ui.router.state.location.hash).toBe('#anchor');
    await waitFor(() => expect(listCalls(ui.calls).at(-1)?.searchParams.has('completion')).toBe(false));
    await chooseFilter(ui.user, 'Task completion', 'Incomplete tasks');
    await waitFor(() => expect(params(ui).get('completion')).toBe('open'));
    await ui.user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(params(ui).has('completion')).toBe(false));
    expect(Object.fromEntries(params(ui))).toEqual({ view: 'board', other: 'kept' });
    expect(filterPicker('Task completion')).toHaveTextContent('All tasks');
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it.each(['completion=closed', 'completion=OPEN', 'completion=all', 'completion=', 'completion=open&completion=open', 'completion=open&completion=closed'])(
    'shows All tasks for %s without rewriting the URL or sending completion', async query => {
      const ui = app(`${tablePath}?${query}&other=kept#anchor`); const key = ui.router.state.location.key;
      await screen.findByRole('button', openRow(finished.title));
      expect(filterPicker('Task completion')).toHaveTextContent('All tasks');
      expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
      expect(screen.getByText('Filters', { selector: 'summary' })).toBeInTheDocument();
      expect(listCalls(ui.calls).every(call => !call.searchParams.has('completion'))).toBe(true);
      expect(ui.router.state.location.search).toBe(`?${query}&other=kept`); expect(ui.router.state.location.key).toBe(key);
      expect(writes(ui.calls)).toHaveLength(0);
    });

  it('labels a fully loaded filtered Board as partial, but not the same fully loaded unfiltered Board', async () => {
    const partial = 'More matching tasks may be available. Counts cover only the loaded tasks in this view.';
    const ui = app(`${tablePath}?view=board`);
    await screen.findByRole('region', { name: 'Task status lanes' });
    await screen.findByText('4 loaded tasks in this view.');
    expect(screen.queryByText(partial)).not.toBeInTheDocument();
    await chooseFilter(ui.user, 'Task completion', 'Incomplete tasks');
    await screen.findByText('2 loaded tasks in this view.');
    expect(listCalls(ui.calls).at(-1)?.searchParams.get('completion')).toBe('open');
    expect(screen.getByText(partial)).toBeInTheDocument();
    expect(writes(ui.calls)).toHaveLength(0);
  });

  it('drops a completed row only after the server refetch and lets the retained drawer reopen it into the open list', async () => {
    const state = { current: task };
    const ui = app(`${tablePath}?completion=open&other=kept#anchor`, state, {
      [`PATCH ${rootPath}/tasks/${task.id}`]: request => {
        const body = request.body as { statusId?: string };
        state.current = { ...state.current, statusId: body.statusId ?? state.current.statusId, revision: state.current.revision + 1 };
        return ok(state.current);
      },
    });
    await ui.user.click(await screen.findByRole('button', { name: `Mark ${task.title} complete` }));
    await waitFor(() => expect(screen.queryByRole('button', openRow(task.title))).not.toBeInTheDocument());
    expect(writes(ui.calls).map(call => call.body)).toEqual([{ expectedRevision: task.revision, statusId: DONE }]);
    // The refetch is the same server-filtered open read, not a local removal.
    const refetch = listCalls(ui.calls).at(-1);
    expect(refetch?.searchParams.get('completion')).toBe('open'); expect(refetch?.searchParams.has('cursor')).toBe(false);
    expect(screen.getByRole('button', openRow(review.title))).toBeInTheDocument();
    expect(params(ui).get('completion')).toBe('open');

    await act(async () => ui.router.navigate(`${tablePath}?completion=open&other=kept&task=${task.id}#anchor`));
    const drawer = await screen.findByRole('dialog', { name: task.title });
    await chooseDrawerStatus(ui.user, drawer, base.name);
    await ui.user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes(ui.calls)).toHaveLength(2));
    expect(writes(ui.calls)[1]?.body).toMatchObject({ statusId: base.id });
    // Saving keeps the drawer open; it is never closed because the row left the list.
    expect(screen.getByRole('dialog', { name: task.title })).toBeInTheDocument();
    await waitFor(() => expect(listCalls(ui.calls).at(-1)?.searchParams.get('completion')).toBe('open'));
    await ui.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('button', openRow(task.title))).toBeInTheDocument();
    expect(params(ui).get('completion')).toBe('open'); expect(ui.router.state.location.hash).toBe('#anchor');
  });
});

async function chooseDrawerStatus(user: ReturnType<typeof userEvent.setup>, drawer: HTMLElement, name: string) {
  await user.click(within(drawer).getByRole('combobox', { name: 'Status' }));
  await user.click(within(screen.getByRole('listbox', { name: 'Status' })).getByRole('option', { name }));
}
