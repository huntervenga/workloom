import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskBlockingDto, TaskDto } from '@workloom/contracts';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppRoutes } from '../../app/AppRoutes';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { SessionProvider } from '../../app/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, boris, deferred, failure, installFakeApi, json, ok, project, renderApp, type RouteTable } from '../../test/fakeApi';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import GraphCanvas from './GraphCanvas';
import { GraphView } from './GraphView';
import { dependencyKeys } from './queries';
import { blocking, context, edge, graph, layout, PROJECT_B, PROJECT_ID, rootPath, STAMP, summary, taskAt } from './test/fixtures';
import { useDependencyWorkspace } from './useDependencyWorkspace';

const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const anchor = taskAt(1);
const predecessor = taskAt(2);
const outside = { ...taskAt(3, PROJECT_B), archivedAt: STAMP };
const projectPath = `${rootPath}/projects/${PROJECT_ID}`;
const blockerPath = (task: TaskDto) => `${rootPath}/tasks/${task.id}/blocking`;
function routes(tasks = [anchor, predecessor]): RouteTable {
  return {
    [`GET ${projectPath}/graph`]: () => ok(graph(tasks, [anchor.id], [edge(predecessor.id, anchor.id)])),
    [`GET ${projectPath}/graph-layout`]: () => ok(layout(tasks.map((task, index) => ({ taskId: task.id, x: index * 300, y: 0 })))),
    [`GET ${projectPath}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }),
  };
}
function harness({ actorId = anna.id, viewer = false, tasks = [anchor, predecessor], onOpen = vi.fn() } = {}) {
  const client = createQueryClient({ retry: false }); clients.push(client);
  function Harness({ actor = actorId }: { actor?: string }) {
    const c = useDependencyWorkspace(actor, alpha.id, PROJECT_ID);
    return <GraphView actorId={actor} workspace={{ ...alpha, role: viewer ? 'viewer' : 'owner' }} project={project(alpha.id, PROJECT_ID, 'Project')} controller={{ ...c, roots: [anchor.id], canvas: false }} loadedTasks={tasks} onOpen={onOpen} />;
  }
  const wrap = (actor = actorId) => <QueryClientProvider client={client}><Harness actor={actor} /></QueryClientProvider>;
  const view = render(wrap());
  return { ...view, client, user: userEvent.setup({ pointerEventsCheck: 0 }), onOpen, changeActor: (actor: string) => view.rerender(wrap(actor)) };
}
async function openInspector(user: ReturnType<typeof userEvent.setup>, task = anchor) {
  const button = await screen.findByRole('button', { name: new RegExp(`^View blockers \\(.*\\): ${task.title}$`) });
  await user.click(button);
  return screen.findByRole('dialog', { name: `Blockers for ${task.title}` });
}
function completeBlocking(mode: 'warn' | 'enforce' = 'warn'): TaskBlockingDto {
  const result = blocking(anchor, predecessor, mode);
  const outsideRow = blocking(anchor, outside, mode).blockers[0];
  if (!outsideRow) throw new Error('Missing outside fixture');
  outsideRow.dependency = { ...outsideRow.dependency, id: 'd1000000-0000-4000-8000-000000000002' };
  outsideRow.predecessorContext.status = { ...outsideRow.predecessorContext.status, group: 'cancelled', name: 'Cancelled' };
  outsideRow.predecessorContext.project.archivedAt = STAMP;
  return { ...result, blockers: [...result.blockers, outsideRow], summary: summary(anchor.id, 11, mode) };
}

describe('Graph blocker inspector authoritative reads', () => {
  it.each(['warn', 'enforce'] as const)('loads only the selected task, separates full count and paged rows, and explains %s', async mode => {
    const response = completeBlocking(mode);
    const { calls } = installFakeApi({ ...routes(), [ `GET ${blockerPath(anchor)}` ]: request => {
      if (request.searchParams.has('cursor')) {
        const row = blocking(anchor, taskAt(4)).blockers[0];
        if (!row) throw new Error('Missing next-page fixture');
        return ok({ ...response, blockers: [{ ...row, dependency: { ...row.dependency, id: 'd1000000-0000-4000-8000-000000000003' } }] });
      }
      return json(200, { data: response, meta: { requestId: 'req_page', nextCursor: 'opaque-next-page' } });
    } });
    const view = harness({ viewer: true });
    await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
    expect(calls.filter(call => call.path.endsWith('/blocking'))).toHaveLength(0);
    const dialog = await openInspector(view.user);
    expect(await within(dialog).findByText('Unfinished predecessors: 11')).toBeInTheDocument();
    expect(within(dialog).getByText('Showing 2 of 11 unfinished predecessors.')).toBeInTheDocument();
    expect(within(dialog).getByText(mode === 'warn' ? /Warning mode allows status changes/ : /Starting and completion are blocked/)).toBeInTheDocument();
    expect(within(dialog).getByText('Outside this graph')).toBeInTheDocument();
    expect(within(dialog).getByText('Archived task')).toBeInTheDocument();
    expect(within(dialog).getByText('Archived project')).toBeInTheDocument();
    expect(within(dialog).getByText(/Cancelled/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Remove|Add dependency|Save/ })).not.toBeInTheDocument();
    await view.user.click(within(dialog).getByRole('button', { name: `Open task: ${outside.title}` }));
    expect(view.onOpen).toHaveBeenCalledWith(outside);
    await view.user.click(within(dialog).getByRole('button', { name: 'Load more blockers' }));
    await within(dialog).findByText('Showing 3 of 11 unfinished predecessors.');
    expect(within(dialog).getByText('Unfinished predecessors: 11')).toBeInTheDocument();
    expect(calls.filter(call => call.path.endsWith('/blocking')).map(call => call.searchParams.get('cursor'))).toEqual([null, 'opaque-next-page']);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('refreshes to an authoritative zero and returns keyboard focus after Escape and Close', async () => {
    let resolved = false;
    installFakeApi({ ...routes(), [`GET ${blockerPath(anchor)}`]: () => ok(resolved ? blocking(anchor) : blocking(anchor, predecessor, 'enforce')) });
    const view = harness();
    const button = await screen.findByRole('button', { name: `View blockers (1): ${anchor.title}` });
    button.focus();
    await view.user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Unfinished predecessors: 1');
    resolved = true;
    await view.user.click(within(dialog).getByRole('button', { name: 'Refresh blockers' }));
    await within(dialog).findByText('No unfinished predecessors at the latest check.');
    expect(within(dialog).queryByText(/Starting and completion are blocked/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(predecessor.title)).not.toBeInTheDocument();
    await view.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(button).toHaveFocus();
    await view.user.keyboard(' ');
    await screen.findByRole('dialog');
    await view.user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(button).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Save my layout' })).toBeDisabled();
  });

  it('hides all cached rows on a failed later page and explicitly restarts the list', async () => {
    let fail = true;
    installFakeApi({ ...routes(), [`GET ${blockerPath(anchor)}`]: request => request.searchParams.has('cursor') && fail
      ? failure(400, 'VALIDATION_FAILED', 'Sensitive cursor details')
      : json(200, { data: blocking(anchor, predecessor), meta: { requestId: 'req_page', ...(fail ? { nextCursor: 'stale-cursor' } : {}) } }) });
    const view = harness();
    const dialog = await openInspector(view.user);
    await within(dialog).findByText(predecessor.title);
    await view.user.click(within(dialog).getByRole('button', { name: 'Load more blockers' }));
    await within(dialog).findByText(/Blockers are unavailable/);
    expect(within(dialog).queryByText(predecessor.title)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/No unfinished predecessors/)).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Sensitive cursor details');
    fail = false;
    await view.user.click(within(dialog).getByRole('button', { name: 'Restart blocker list' }));
    await within(dialog).findByText(predecessor.title);
    expect(within(dialog).queryByRole('button', { name: 'Load more blockers' })).not.toBeInTheDocument();
  });

  it('holds the Graph access barrier through repeated denial, then reauthorizes the selected blocker read', async () => {
    let denied = false;
    const { calls } = installFakeApi({ ...routes(), [`GET ${blockerPath(anchor)}`]: () => denied ? failure(403, 'FORBIDDEN', 'Hidden predecessor secret') : ok(blocking(anchor, outside)) });
    const view = harness();
    const dialog = await openInspector(view.user);
    await within(dialog).findByText(outside.title);
    denied = true;
    await view.user.click(within(dialog).getByRole('button', { name: 'Refresh blockers' }));
    await screen.findByText('Graph and personal positions are hidden because access is unconfirmed.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Graph tasks and dependencies' })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(outside.title);
    await view.user.keyboard('{Escape}');
    await view.user.click(screen.getByRole('button', { name: 'Check graph access' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check graph access' })).toBeEnabled());
    expect(screen.queryByRole('list', { name: 'Graph tasks and dependencies' })).not.toBeInTheDocument();
    denied = false;
    await view.user.click(screen.getByRole('button', { name: 'Check graph access' }));
    await screen.findByRole('dialog', { name: `Blockers for ${anchor.title}` });
    await screen.findByText(outside.title);
    expect(calls.filter(call => call.path === blockerPath(anchor))).toHaveLength(4);
  });

  it('never presents a missing or mismatched blocking response as ready', async () => {
    const wait = deferred<Response>();
    installFakeApi({ ...routes(), [`GET ${blockerPath(anchor)}`]: () => wait.promise });
    const view = harness();
    const dialog = await openInspector(view.user);
    expect(within(dialog).getByText('Checking unfinished predecessors…')).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('No unfinished predecessors');
    await act(async () => { wait.resolve(ok(blocking(predecessor))); });
    await within(dialog).findByText(/Blockers are unavailable/);
    expect(dialog).not.toHaveTextContent('No unfinished predecessors');
  });

  it('ignores delayed A after closing it and inspecting B', async () => {
    const slow = deferred<Response>();
    installFakeApi({ ...routes(), [`GET ${blockerPath(anchor)}`]: () => slow.promise, [`GET ${blockerPath(predecessor)}`]: () => ok(blocking(predecessor, outside)) });
    const view = harness();
    await openInspector(view.user);
    await view.user.keyboard('{Escape}');
    const dialogB = await openInspector(view.user, predecessor);
    await within(dialogB).findByText(outside.title);
    await act(async () => { slow.resolve(ok(blocking(anchor, taskAt(99)))); });
    expect(screen.getByRole('dialog', { name: `Blockers for ${predecessor.title}` })).toBeInTheDocument();
    expect(dialogB).not.toHaveTextContent(taskAt(99).title);
  });

  it('closes on actor change and on task removal from a refreshed graph without resurrecting the selection', async () => {
    let removed = false;
    installFakeApi({ ...routes(), [`GET ${projectPath}/graph`]: () => ok(graph(removed ? [predecessor] : [anchor, predecessor], [anchor.id])), [`GET ${blockerPath(anchor)}`]: () => ok(blocking(anchor, outside)) });
    const view = harness();
    await openInspector(view.user);
    await screen.findByText(outside.title);
    view.changeActor(boris.id);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    view.changeActor(anna.id);
    await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openInspector(view.user);
    removed = true;
    await act(async () => { await view.client.invalidateQueries({ queryKey: dependencyKeys.graph(anna.id, alpha.id, PROJECT_ID, [anchor.id], 1) }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('Graph canvas blocker control', () => {
  it('uses a keyboard and pointer button without moving or opening the task', async () => {
    const onMove = vi.fn(), onOpen = vi.fn(), onViewBlockers = vi.fn();
    render(<GraphCanvas tasks={[{ id: anchor.id, title: anchor.title, projectName: 'Project', statusName: 'Todo', blocked: true, unresolvedCount: 4, archived: false }]} edges={[]} positions={{ [anchor.id]: { x: 0, y: 0 } }} movable connectable onMove={onMove} onOpen={onOpen} onViewBlockers={onViewBlockers} onConnect={vi.fn()} />);
    const button = screen.getByLabelText(`View blockers (4): ${anchor.title}`);
    // jsdom has no node dimensions: expose the rendered node to exercise its real event handlers.
    const node = button.closest<HTMLElement>('.react-flow__node');
    if (node) node.style.visibility = 'visible';
    expect(button).toHaveClass('nodrag', 'nopan');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    button.focus();
    await user.keyboard('{ArrowRight}{Enter} ');
    fireEvent.pointerDown(button, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(button, { clientX: 150, clientY: 100 });
    fireEvent.pointerUp(button);
    fireEvent.doubleClick(button);
    await user.click(button);
    expect(onViewBlockers).toHaveBeenCalledTimes(3);
    expect(onViewBlockers).toHaveBeenCalledWith(anchor.id);
    expect(onMove).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('Graph blocker task navigation', () => {
  function appRoutes(): RouteTable {
    return { ...tableRoutes(), ...routes(),
      [`GET ${rootPath}/projects`]: () => ok([project(alpha.id, PROJECT_ID, 'Primary'), project(alpha.id, PROJECT_B, 'Other')]),
      [`GET ${rootPath}/projects/${PROJECT_B}`]: () => ok(project(alpha.id, PROJECT_B, 'Other')),
      [`GET ${rootPath}/projects/${PROJECT_B}/statuses`]: () => ok([{ ...context(outside).status, workspaceId: alpha.id, projectId: PROJECT_B, revision: 1, position: 0 }]),
      [`GET ${rootPath}/projects/${PROJECT_B}/sections`]: () => ok([]),
      [`GET ${rootPath}/tasks`]: () => ok([anchor, predecessor]),
      [`GET ${rootPath}/tasks/${predecessor.id}`]: () => ok(predecessor),
      [`GET ${rootPath}/tasks/${outside.id}`]: () => ok(outside),
      [`GET ${blockerPath(anchor)}`]: () => ok({ ...completeBlocking(), summary: summary(anchor.id, 2) }),
      [`GET ${blockerPath(predecessor)}`]: () => ok(blocking(predecessor)),
      [`GET ${blockerPath(outside)}`]: () => ok(blocking(outside)),
    };
  }
  it('opens a same-project drawer above the inspector, then returns focus to its Open task button', async () => {
    installFakeApi(appRoutes());
    const { user } = renderApp(`${tablePath}?view=graph`);
    // List is always available, including when the lazy diagram cannot measure in jsdom.
    const list = await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
    await user.click(within(list).getByRole('button', { name: `View blockers (1): ${anchor.title}` }));
    const inspector = await screen.findByRole('dialog', { name: `Blockers for ${anchor.title}` });
    const open = await within(inspector).findByRole('button', { name: `Open task: ${predecessor.title}` });
    await user.click(open);
    const drawer = await screen.findByRole('dialog', { name: predecessor.title });
    expect(drawer).toBeInTheDocument();
    expect(inspector).toHaveAttribute('aria-hidden', 'true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: predecessor.title })).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: `Blockers for ${anchor.title}` })).toBeInTheDocument();
    expect(open).toHaveFocus();
  });
  it('preserves the unsaved-layout navigation guard for cross-project Open task', async () => {
    installFakeApi(appRoutes());
    const client = createQueryClient({ retry: false }); clients.push(client);
    const router = createMemoryRouter([{ path: '*', element: <SessionProvider><ProtectedNavigationGuard /><AppRoutes /></SessionProvider> }], { initialEntries: [`${tablePath}?view=graph`] });
    try {
      render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      const list = await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
      await user.click(within(list).getAllByText('Position in my layout')[0] as HTMLElement);
      const right = within(list).getByRole('button', { name: `Right: ${anchor.title}` });
      await waitFor(() => expect(right).toBeEnabled());
      await user.click(right);
      await user.click(within(list).getByRole('button', { name: `View blockers (1): ${anchor.title}` }));
      const dialog = await screen.findByRole('dialog', { name: `Blockers for ${anchor.title}` });
      await user.click(await within(dialog).findByRole('button', { name: `Open task: ${outside.title}` }));
      const guard = await screen.findByRole('dialog', { name: 'Leave this page?' });
      expect(guard).toHaveTextContent('You have an unsaved draft on this page.');
      await user.click(within(guard).getByRole('button', { name: 'Stay' }));
      expect(screen.getByRole('dialog', { name: `Blockers for ${anchor.title}` })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save my layout', hidden: true })).toBeEnabled();
      await user.click(within(dialog).getByRole('button', { name: `Open task: ${outside.title}` }));
      await user.click(within(await screen.findByRole('dialog', { name: 'Leave this page?' })).getByRole('button', { name: 'Leave without saving' }));
      await screen.findByRole('dialog', { name: outside.title });
      expect(screen.queryByRole('dialog', { name: `Blockers for ${anchor.title}` })).not.toBeInTheDocument();
    } finally { router.dispose(); }
  });
});
