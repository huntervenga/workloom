import type { TaskDto } from '@workloom/contracts';
import type * as Layout from './layout';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, anna, installFakeApi, ok, project } from '../../test/fakeApi';
import { createQueryClient } from '../../lib/queryClient';
import { GraphView } from './GraphView';
import { arrangeGraph } from './layout';
import { graph, layout, PROJECT_ID, rootPath, taskAt } from './test/fixtures';
import { useDependencyWorkspace, type DependencyWorkspace } from './useDependencyWorkspace';
const compute = vi.hoisted(() => ({ hold: null as null | Promise<Record<string, { x: number; y: number }>> }));
vi.mock('./layout', async importOriginal => {
  const actual = await importOriginal<typeof Layout>();
  return { ...actual, arrangeGraph: (...args: Parameters<typeof actual.arrangeGraph>) => compute.hold ?? actual.arrangeGraph(...args) };
});
afterEach(() => { compute.hold = null; vi.restoreAllMocks(); });
function harness(height = 250, savedPositions = true, canvas = false) {
  const tasks: [TaskDto, TaskDto] = [{ ...taskAt(1), title: 'Full long title '.repeat(20) }, taskAt(2)];
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-graph-measure-node') ? new DOMRect(0, 0, 240, height) : original.call(this); });
  let controller: DependencyWorkspace | undefined;
  const saved = savedPositions ? [{ taskId: tasks[0].id, x: 0, y: 0 }, { taskId: tasks[1].id, x: 0, y: 164 }, { taskId: taskAt(99).id, x: 800, y: 900 }] : [];
  const path = `${rootPath}/projects/${PROJECT_ID}`;
  const { calls } = installFakeApi({ [`GET ${path}/graph`]: () => ok(graph(tasks)), [`GET ${path}/graph-layout`]: () => ok(layout(saved, 1)), [`GET ${path}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }) });
  const client = createQueryClient({ retry: false });
  function Host({ owner = anna.id }: { owner?: string }) { controller = useDependencyWorkspace(owner, alpha.id, PROJECT_ID); return <GraphView actorId={owner} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Full project context')} controller={{ ...controller, roots: tasks.map(task => task.id), canvas }} loadedTasks={tasks} onOpen={() => undefined} />; }
  const wrap = (owner = anna.id) => <QueryClientProvider client={client}><Host owner={owner} /></QueryClientProvider>;
  const view = render(wrap());
  return { ...view, client, tasks, saved, calls, user: userEvent.setup({ pointerEventsCheck: 0 }), owner: (owner: string) => view.rerender(wrap(owner)), current: () => { if (!controller) throw new Error('Missing graph controller'); return controller; } };
}

describe('measured GraphView automatic arrangement from the task list', () => {
  it('uses measured default positions before any personal layout exists and keeps full Canvas titles', async () => {
    const h = harness(250, false, true);
    try {
      const sizes = Object.fromEntries(h.tasks.map(task => [task.id, { width: 240, height: 250 }]));
      const expected = await arrangeGraph(h.tasks.map(task => task.id), [], sizes);
      await waitFor(() => {
        for (const task of h.tasks) {
          const node = h.container.querySelector(`[data-id="${task.id}"].react-flow__node`);
          const point = expected[task.id]; if (!point) throw new Error('Missing default position');
          expect((node as HTMLElement | null)?.style.transform.replace(/\s/g, '')).toBe(`translate(${point.x}px,${point.y}px)`);
          expect(node?.querySelector('button')).toHaveTextContent(task.title.trim());
          expect(node?.querySelector('button')).not.toHaveClass('line-clamp-2');
        }
      });
      expect(h.current().layout.moves).toEqual({}); expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { h.unmount(); h.client.clear(); }
  });
  it('keeps saved positions until explicit Arrange, uses measured sizes and retains hidden positions without saving', async () => {
    const h = harness();
    try {
      await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
      const arrange = screen.getByRole('button', { name: 'Apply automatic layout' }); await waitFor(() => expect(arrange).toBeEnabled());
      expect(h.current().layout.base?.positions).toEqual(h.saved); expect(h.current().layout.moves).toEqual({});
      expect(screen.queryByRole('region', { name: 'Dependency graph' })).not.toBeInTheDocument();
      await h.user.click(arrange); await waitFor(() => expect(screen.getByRole('button', { name: 'Save my layout' })).toBeEnabled());
      const sizes = Object.fromEntries(h.tasks.map(task => [task.id, { width: 240, height: 250 }]));
      const positions = await arrangeGraph(h.tasks.map(task => task.id), [], sizes);
      expect(h.current().layout.moves).toEqual(positions);
      expect(h.current().layout.base?.positions).toEqual(h.saved);
      expect(h.current().layoutInput?.positions).toContainEqual(h.saved[2]);
      const list = screen.getByRole('list', { name: 'Graph tasks and dependencies' });
      expect(within(list).getByRole('button', { name: h.tasks[0].title.trim() })).toHaveTextContent(h.tasks[0].title.trim());
      expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { h.unmount(); h.client.clear(); }
  });
  it('ignores delayed Arrange after an actor/scope change', async () => {
    const h = harness();
    try {
      const arrange = await screen.findByRole('button', { name: 'Apply automatic layout' }); await waitFor(() => expect(arrange).toBeEnabled());
      let resolve: (positions: Record<string, { x: number; y: number }>) => void = () => undefined;
      compute.hold = new Promise(done => { resolve = done; });
      await h.user.click(arrange); expect(arrange).toBeDisabled();
      h.owner('22222222-2222-4222-8222-222222222222');
      await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
      await act(async () => resolve(Object.fromEntries(h.tasks.map(task => [task.id, { x: 555, y: 777 }]))));
      expect(h.current().layout.moves).toEqual({}); expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { h.unmount(); h.client.clear(); }
  });
  it('reports oversized geometry without changing the existing saved positions or draft', async () => {
    const h = harness(200001);
    try {
      const arrange = await screen.findByRole('button', { name: 'Apply automatic layout' }); await waitFor(() => expect(arrange).toBeEnabled());
      await h.user.click(arrange);
      await screen.findByRole('alert');
      expect(screen.getByRole('alert')).toHaveTextContent('cannot fit the graph layout limits without overlapping');
      expect(h.current().layout.base?.positions).toEqual(h.saved); expect(h.current().layout.moves).toEqual({});
      expect(screen.getByRole('button', { name: 'Save my layout' })).toBeDisabled();
      expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { h.unmount(); h.client.clear(); }
  });
});
