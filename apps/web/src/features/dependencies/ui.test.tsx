import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { alpha, failure, installFakeApi, ok, project, renderApp, type RouteTable } from '../../test/fakeApi';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import { dependencyKeys } from './queries';
import { blocking, edge, graph, layout, PROJECT_ID, rootPath, summary, taskAt } from './test/fixtures';
import { anna } from '../../test/fakeApi';

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
    await user.click(screen.getByRole('button', { name: 'Граф' }));
    if (count === 100) {
      await waitFor(() => expect(calls.some(call => call.path.endsWith('/graph'))).toBe(true));
      expect(calls.find(call => call.path.endsWith('/graph'))?.searchParams.get('rootTaskIds')?.split(',')).toHaveLength(100);
      expect(screen.queryByText(/Загружено больше 100 задач/)).not.toBeInTheDocument();
      expect(await screen.findByText(/Исходный набор взят из загруженных задач таблицы/)).toBeInTheDocument();
    } else {
      expect(await screen.findByRole('alert')).toHaveTextContent('Загружено больше 100 задач');
      expect(calls.filter(call => call.path.endsWith('/graph'))).toHaveLength(0);
      await user.click(screen.getByText('Изменить исходные задачи (0)'));
      const roots = screen.getByRole('group', { name: 'Исходные задачи графа' });
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
    await user.click(await screen.findByRole('checkbox', { name: `Выбрать для графа: ${first.title}` }));
    await user.click(screen.getByRole('button', { name: 'Граф выбранных (1)' }));
    await screen.findByText(/Исходный набор взят из выбранных задач/);
    await waitFor(() => expect(calls.some(call => call.path.endsWith('/graph'))).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Задачи' }));
    await user.type(screen.getByLabelText('Поиск задач'), 'новая страница');
    await waitFor(() => expect(screen.getByRole('button', { name: filtered.title })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Граф выбранных (1)' }));
    await screen.findByText(/Исходный набор взят из выбранных задач/);
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
    const list = await screen.findByRole('list', { name: 'Задачи и связи графа' });
    await user.click(within(list).getByText('Положение на моей раскладке'));
    const right = within(list).getByRole('button', { name: `Вправо: ${shown.title}` });
    await waitFor(() => expect(right).toBeEnabled());
    await user.click(right);
    await user.click(screen.getByRole('button', { name: 'Сохранить мою раскладку' }));
    await waitFor(() => expect(calls.some(call => call.method === 'PUT')).toBe(true));
    expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 1, positions: [{ taskId: shown.id, x: 30, y: 20 }, { taskId: hidden.id, x: 900, y: 100 }] });
    deny = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: dependencyKeys.root(anna.id, alpha.id) }); });
    await screen.findByText('Граф и личные координаты скрыты: доступ не подтверждён.');
    expect(screen.queryByRole('list', { name: 'Задачи и связи графа' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Сохранить мою раскладку' })).not.toBeInTheDocument();
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
    const card = await screen.findByRole('region', { name: 'Связи задачи' });
    expect(await within(card).findByText('Незавершённых предшественников: 1')).toBeInTheDocument();
    expect(within(card).getByText(/Начать или завершить задачу можно после завершения всех предшественников/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Добавить связь' }));
    const dialog = await screen.findByRole('dialog', { name: 'Добавить связь задач' });
    const taskSelect = within(dialog).getByLabelText('Связанная задача');
    await waitFor(() => expect(within(taskSelect).getByRole('option', { name: predecessor.title })).toBeInTheDocument());
    await user.selectOptions(taskSelect, predecessor.id);
    await user.click(within(dialog).getByRole('button', { name: 'Добавить связь' }));
    await within(dialog).findByText('Связь создаёт цикл');
    expect(taskSelect).toHaveValue(predecessor.id);
    expect(dialog).not.toHaveTextContent('Sensitive cycle path');
    await user.selectOptions(taskSelect, alternate.id);
    await user.click(within(dialog).getByRole('button', { name: 'Добавить связь' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Добавить связь задач' })).not.toBeInTheDocument());
    await user.click(within(card).getByText('Все связи, включая снятые'));
    await user.click(await within(card).findByRole('button', { name: 'Снять связь' }));
    await user.click(await within(card).findByRole('button', { name: 'Восстановить связь' }));
    await waitFor(() => expect(current.revision).toBe(3));
    expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ expectedRevision: 1, state: 'removed' }, { expectedRevision: 2, state: 'active' }]);
    expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([
      { predecessorTaskId: predecessor.id, successorTaskId: anchor.id, type: 'finish_to_start', expectedAbsent: true },
      { predecessorTaskId: alternate.id, successorTaskId: anchor.id, type: 'finish_to_start', expectedAbsent: true },
    ]);
  });
});
