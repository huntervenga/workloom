import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok, project } from '../../test/fakeApi';
import { GraphView } from './GraphView';
import { graph, layout, PROJECT_ID, rootPath, taskAt } from './test/fixtures';
import { useDependencyWorkspace } from './useDependencyWorkspace';

const loaded = vi.hoisted(() => {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { finish = resolve; });
  return { promise, resolve: () => finish(), positions: {} as Record<string, { x: number; y: number }> };
});
vi.mock('./layout', () => ({ arrangeGraph: async () => {
  await loaded.promise;
  return loaded.positions;
} }));

it('cannot save a prior reset while automatic layout is loading, then saves every completed position', async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-graph-measure-node') ? new DOMRect(0, 0, 240, 190) : originalRect.call(this);
  });
  const tasks = [taskAt(1), taskAt(2), taskAt(3)];
  const positions = tasks.map((task, index) => ({ taskId: task.id, x: index * 300, y: 24 }));
  const computed = Object.fromEntries(positions.map(({ taskId, x, y }) => [taskId, { x, y }]));
  loaded.positions = computed;
  const client = createQueryClient({ retry: false });
  const path = `${rootPath}/projects/${PROJECT_ID}`;
  const { calls } = installFakeApi({
    [`GET ${path}/graph`]: () => ok(graph(tasks)),
    [`GET ${path}/graph-layout`]: () => ok(layout([{ taskId: taskAt(1).id, x: 10, y: 20 }], 1)),
    [`GET ${path}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }),
    [`PUT ${path}/graph-layout`]: () => ok(layout(positions, 2)),
  });
  function Host() {
    const controller = useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID);
    const { setRoots, setCanvas } = controller;
    useEffect(() => { setRoots(tasks.map(task => task.id)); setCanvas(false); }, [setRoots, setCanvas]);
    return <GraphView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Пилот')} controller={controller} loadedTasks={tasks} onOpen={() => undefined} />;
  }
  const view = render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
  const user = userEvent.setup();
  try {
    const reset = await screen.findByRole('button', { name: "Reset all my positions" });
    await waitFor(() => expect(reset).toBeEnabled());
    await user.click(reset);
    const save = screen.getByRole('button', { name: "Save my layout" });
    expect(save).toBeEnabled();
    const arrange = screen.getByRole('button', { name: "Apply automatic layout" });
    await waitFor(() => expect(arrange).toBeEnabled());
    await user.click(arrange);
    expect(arrange).toBeDisabled();
    expect(save).toBeDisabled();
    expect(reset).toBeDisabled();
    expect(screen.getByRole('button', { name: "Discard moves" })).toBeDisabled();
    await user.click(save);
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0);
    await act(async () => { loaded.resolve(); });
    await waitFor(() => expect(arrange).toBeEnabled());
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() => expect(calls.filter(call => call.method === 'PUT')).toHaveLength(1));
    expect(calls.find(call => call.method === 'PUT')?.body).toEqual({ expectedRevision: 1, positions });
    await waitFor(() => expect(save).toBeDisabled());
  } finally {
    loaded.resolve();
    view.unmount(); client.clear(); measure.mockRestore();
  }
});
