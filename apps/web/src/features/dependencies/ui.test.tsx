import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alpha, failure, installFakeApi, ok, project, renderApp, type RouteTable } from '../../test/fakeApi';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import { dependencyKeys } from './queries';
import { blocking, edge, graph, layout, PROJECT_ID, rootPath, summary, taskAt } from './test/fixtures';
import { anna } from '../../test/fakeApi';

// Compile the large lazy route before the first DOM wait; these tests exercise its UI, not module loading.
beforeAll(async () => { await import('../../routes/ProjectPage'); });

const width = window.innerWidth;
beforeEach(() => { Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true }); });
afterEach(() => { Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true }); });
const base = (): RouteTable => ({
  ...tableRoutes(),
  [`GET ${rootPath}/projects`]: () => ok([project(alpha.id, PROJECT_ID, 'Недельный пилот')]),
  [`GET ${rootPath}/projects/${PROJECT_ID}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }),
  [`GET ${rootPath}/projects/${PROJECT_ID}/graph-layout`]: () => ok(layout()),
});

describe('project graph roots and retained layout', () => {
  it.each([100, 101])('opens %i loaded tasks without silently dropping any roots', async count => {
    const tasks = Array.from({ length: count }, (_, index) => taskAt(index + 1));
    const { calls } = installFakeApi({ ...base(),
      [`GET ${rootPath}/tasks`]: () => ok(tasks),
      [`GET ${rootPath}/projects/${PROJECT_ID}/graph`]: request => {
        const roots = request.searchParams.get('rootTaskIds')?.split(',') ?? [];
        return ok(graph(tasks.filter(task => roots.includes(task.id)), roots));
      },
    });
    const { user } = renderApp(tablePath);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: "Graph" }));
    if (count === 100) {
      await waitFor(() => expect(calls.some(call => call.path.endsWith('/graph'))).toBe(true));
      expect(calls.find(call => call.path.endsWith('/graph'))?.searchParams.get('rootTaskIds')?.split(',')).toHaveLength(100);
      expect(screen.queryByText(/More than 100 tasks are loaded/)).not.toBeInTheDocument();
      expect(await screen.findByText(/Starting tasks taken from the loaded task table/)).toBeInTheDocument();
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('More than 100 tasks are loaded');
      expect(calls.filter(call => call.path.endsWith('/graph'))).toHaveLength(0);
      await user.click(screen.getByText('Choose starting tasks (0)'));
      const roots = screen.getByRole('group', { name: "Graph starting tasks" });
      await user.click(within(roots).getByRole('checkbox', { name: 'Задача 101' }));
      await waitFor(() => expect(calls.filter(call => call.path.endsWith('/graph'))).toHaveLength(1));
      expect(calls.find(call => call.path.endsWith('/graph'))?.searchParams.get('rootTaskIds')).toBe(taskAt(101).id);
    }
  });

  it('keeps the explicit root set when a new table filter/page is loaded', async () => {
    const first = taskAt(1); const second = taskAt(2); const filtered = taskAt(3);
    const { calls } = installFakeApi({ ...base(),
      [`GET ${rootPath}/tasks`]: request => ok(request.searchParams.get('search') ? [filtered] : [first, second]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/graph`]: request => ok(graph([first], request.searchParams.get('rootTaskIds')?.split(',') ?? [])),
    });
    const { user } = renderApp(tablePath);
    const select = await screen.findByRole('button', { name: `Select task: ${first.title}` });
    expect(select).toHaveAttribute('aria-pressed', 'false');
    await user.click(select);
    expect(select).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: "Selected graph (1)" }));
    await screen.findByText(/Starting tasks taken from your selection/);
    await waitFor(() => expect(calls.some(call => call.path.endsWith('/graph'))).toBe(true));
    await user.click(screen.getByRole('button', { name: "Tasks" }));
    await user.type(screen.getByLabelText("Search tasks"), 'новая страница');
    await waitFor(() => expect(screen.getByRole('button', { name: filtered.title })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: "Selected graph (1)" }));
    await screen.findByText(/Starting tasks taken from your selection/);
    expect(calls.filter(call => call.path.endsWith('/graph')).every(call => call.searchParams.get('rootTaskIds') === first.id)).toBe(true);
  });

  it('moves a node from its saved coordinate, keeps hidden positions on save and hides cached graph after denial', async () => {
    const shown = taskAt(1); const hidden = taskAt(99);
    let saved = layout([{ taskId: shown.id, x: 10, y: 20 }, { taskId: hidden.id, x: 900, y: 100 }], 1);
    let deny = false;
    const { calls } = installFakeApi({ ...base(),
      [`GET ${rootPath}/tasks`]: () => ok([shown]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/graph`]: () => deny ? failure(403, 'FORBIDDEN', 'Sensitive graph text') : ok(graph([shown])),
      [`GET ${rootPath}/projects/${PROJECT_ID}/graph-layout`]: () => ok(saved),
      [`PUT ${rootPath}/projects/${PROJECT_ID}/graph-layout`]: request => {
        const input = request.body as { expectedRevision: number; positions: typeof saved.positions };
        saved = layout(input.positions, 2); return ok(saved);
      },
    });
    const { user, queryClient } = renderApp(`${tablePath}?view=graph`);
    const list = await screen.findByRole('list', { name: "Graph tasks and dependencies" });
    await user.click(within(list).getByText("Position in my layout"));
    const right = within(list).getByRole('button', { name: `Right: ${shown.title}` });
    await waitFor(() => expect(right).toBeEnabled());
    await user.click(right);
    await user.click(screen.getByRole('button', { name: "Save my layout" }));
    await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
    expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 1, positions: [{ taskId: shown.id, x: 30, y: 20 }, { taskId: hidden.id, x: 900, y: 100 }] });
    deny = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: dependencyKeys.root(anna.id, alpha.id) }); });
    await screen.findByText("Graph and personal positions are hidden because access is unconfirmed.");
    expect(screen.queryByRole('list', { name: "Graph tasks and dependencies" })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Save my layout" })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Sensitive graph text');
  });
});

describe('shared task dependency card', () => {
  it('shows authoritative blockers and completes keyboard create/remove/restore without replacing a cycle draft', async () => {
    const anchor = taskAt(2); const predecessor = taskAt(1); const alternate = taskAt(3);
    let current = edge(alternate.id, anchor.id);
    let created = false; let creates = 0;
    const { calls } = installFakeApi({ ...base(),
      [`GET ${rootPath}/tasks`]: () => ok([predecessor, anchor, alternate]),
      [`GET ${rootPath}/tasks/${anchor.id}`]: () => ok(anchor),
      [`GET ${rootPath}/tasks/${alternate.id}`]: () => ok(alternate),
      [`GET ${rootPath}/tasks/${anchor.id}/blocking`]: () => {
        const result = blocking(anchor, predecessor, 'enforce');
        if (created && current.state === 'active') result.summary = summary(anchor.id, 2, 'enforce');
        return ok(result);
      },
      [`GET ${rootPath}/dependencies`]: () => ok(created ? [current] : []),
      [`POST ${rootPath}/dependencies`]: () => { creates += 1; if (creates === 1) return failure(409, 'DEPENDENCY_CYCLE', 'Sensitive cycle path'); created = true; return ok(current); },
      [`PATCH ${rootPath}/dependencies/${current.id}`]: request => { const input = request.body as { state: 'active' | 'removed' }; current = { ...current, revision: current.revision + 1, state: input.state }; return ok(current); },
    });
    const { user } = renderApp(`${tablePath}?task=${anchor.id}`);
    const card = await screen.findByRole('region', { name: "Task dependencies" });
    expect(await within(card).findByText("Unfinished predecessors: 1")).toBeInTheDocument();
    expect(within(card).getByText(/Complete all predecessors before starting or completing this task/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: "Add dependency" }));
    const dialog = await screen.findByRole('dialog', { name: "Add task dependency" });
    const taskSelect = within(dialog).getByLabelText("Related task");
    await waitFor(() => expect(within(taskSelect).getByRole('option', { name: predecessor.title })).toBeInTheDocument());
    await user.selectOptions(taskSelect, predecessor.id);
    await user.click(within(dialog).getByRole('button', { name: "Add dependency" }));
    await within(dialog).findByText('This dependency creates a cycle');
    expect(taskSelect).toHaveValue(predecessor.id);
    expect(dialog).not.toHaveTextContent('Sensitive cycle path');
    await user.selectOptions(taskSelect, alternate.id);
    await user.click(within(dialog).getByRole('button', { name: "Add dependency" }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: "Add task dependency" })).not.toBeInTheDocument());
    await user.click(within(card).getByText("All dependencies, including removed"));
    await user.click(await within(card).findByRole('button', { name: "Remove dependency" }));
    await user.click(await within(card).findByRole('button', { name: "Restore dependency" }));
    await waitFor(() => expect(current.revision).toBe(3));
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 1, state: 'removed' }, { expectedRevision: 2, state: 'active' }]);
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      { predecessorTaskId: predecessor.id, successorTaskId: anchor.id, type: 'finish_to_start', expectedAbsent: true },
      { predecessorTaskId: alternate.id, successorTaskId: anchor.id, type: 'finish_to_start', expectedAbsent: true },
    ]);
  });
});
