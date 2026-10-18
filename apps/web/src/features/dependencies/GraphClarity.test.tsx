import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskDto, TaskStatusGroup } from '@workloom/contracts';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok, project } from '../../test/fakeApi';
import GraphCanvas, { type GraphCanvasTask } from './GraphCanvas';
import { GraphView } from './GraphView';
import { arrangeGraph } from './layout';
import { edge, graph, layout, PROJECT_ID, rootPath, summary, taskAt } from './test/fixtures';
import { useDependencyWorkspace, type DependencyWorkspace } from './useDependencyWorkspace';

interface FlowNode { id: string; ariaLabel: string; selected?: boolean; style: CSSProperties; data: { label: ReactNode } }
interface FlowEdge { id: string; ariaLabel: string; zIndex: number; style: CSSProperties; markerEnd: { color: string } }
interface FlowProps { nodes: FlowNode[]; edges: FlowEdge[]; onNodesChange: (changes: { type: 'select'; id: string; selected: boolean }[]) => void; onInit?: (instance: { fitView: () => Promise<boolean> }) => void; children: ReactNode }
const flow = vi.hoisted(() => ({ fitView: null as null | (() => void) }));
// jsdom gives React Flow no node dimensions, so its edges never render. This stand-in exposes the exact props.
vi.mock('@xyflow/react', () => ({
  Position: { Left: 'left', Right: 'right' }, MarkerType: { ArrowClosed: 'arrowclosed' }, Background: () => null, Controls: () => null,
  ReactFlow: function MockFlow({ nodes, edges, onNodesChange, onInit, children }: FlowProps) {
    useEffect(() => { onInit?.({ fitView: async () => { flow.fitView?.(); return true; } }); }, [onInit]);
    return <div>
      {nodes.map(node => <div key={node.id} data-testid={`node-${node.id}`} aria-label={node.ariaLabel} data-selected={String(node.selected === true)} style={node.style}>
        <button type="button" data-testid={`select-${node.id}`} onClick={() => onNodesChange([{ type: 'select', id: node.id, selected: true }])} />{node.data.label}
      </div>)}
      {edges.map(item => <span key={item.id} data-testid={`edge-${item.id}`} aria-label={item.ariaLabel} data-dash={String(item.style.strokeDasharray ?? 'solid')} data-width={String(item.style.strokeWidth)} data-opacity={String(item.style.opacity)} data-layer={String(item.zIndex)} data-marker={item.markerEnd.color} />)}
      {children}
    </div>;
  },
}));
afterEach(() => { flow.fitView = null; vi.restoreAllMocks(); });

const node = (id: string, statusGroup: TaskStatusGroup, extra: Partial<GraphCanvasTask> = {}): GraphCanvasTask => ({ id, title: `Task-${id}`, projectName: 'Pilot', statusName: statusGroup, statusGroup, blocked: false, unresolvedCount: 0, archived: false, violatesCurrentStatus: false, ...extra });
// b waits for done a, cancelled d and one predecessor outside this diagram; c violates enforce while blocked by b.
const canvasTasks = [node('a', 'done'), node('b', 'todo', { blocked: true, unresolvedCount: 2 }), node('c', 'in_progress', { blocked: true, unresolvedCount: 1, violatesCurrentStatus: true }), node('d', 'cancelled'), node('e', 'todo')];
const canvasEdges = [{ id: 'ab', source: 'a', target: 'b' }, { id: 'db', source: 'd', target: 'b' }, { id: 'bc', source: 'b', target: 'c' }, { id: 'ea', source: 'e', target: 'a' }];
function renderCanvas(fitRequest?: number) {
  const handlers = { onMove: vi.fn(), onOpen: vi.fn(), onConnect: vi.fn(), onViewBlockers: vi.fn() };
  const positions = Object.fromEntries(canvasTasks.map((task, index) => [task.id, { x: index * 300, y: 0 }]));
  const element = (request?: number) => <GraphCanvas tasks={canvasTasks} edges={canvasEdges} positions={positions} movable connectable {...(request === undefined ? {} : { fitRequest: request })} {...handlers} />;
  const view = render(element(fitRequest));
  return { ...view, handlers, rerenderWith: (request?: number) => view.rerender(element(request)) };
}

describe('dependency diagram semantics', () => {
  it('labels each arrow with the predecessor-done rule and distinguishes done and violating tasks in text', () => {
    const { handlers } = renderCanvas();
    expect(screen.getByRole('list', { name: 'Dependency arrow legend' })).toHaveTextContent('Solid amber arrow: the predecessor is not done, so the dependency is unresolved');
    const resolved = screen.getByTestId('edge-ab');
    expect(resolved).toHaveAttribute('aria-label', 'The next task starts after the previous task finishes. Resolved: Task-a is done, so Task-b no longer waits for it');
    expect(resolved).toHaveAttribute('data-dash', '6 4');
    // A cancelled predecessor is not done, so the dependency still blocks.
    const cancelled = screen.getByTestId('edge-db');
    expect(cancelled).toHaveAttribute('aria-label', 'The next task starts after the previous task finishes. Unresolved: Task-d is not done yet, so Task-b still waits for it');
    expect(cancelled).toHaveAttribute('data-dash', 'solid');
    expect(cancelled.dataset.marker).not.toBe(resolved.dataset.marker);
    expect(screen.getByTestId('node-a')).toHaveAttribute('aria-label', 'Task-a, Pilot, done, done');
    expect(within(screen.getByTestId('node-a')).getByText('Done: dependencies on this task are resolved')).toBeInTheDocument();
    const violating = screen.getByTestId('node-c');
    expect(violating).toHaveAttribute('aria-label', 'Task-c, Pilot, in_progress, has unfinished predecessors, status conflicts with the blocking rule');
    expect(within(violating).getByText('Status conflicts with the blocking rule')).toBeInTheDocument();
    expect(violating).toHaveStyle({ borderColor: 'var(--color-danger-line)', borderWidth: '1px' });
    expect(within(screen.getByTestId('node-b')).queryByText(/Done:|Status conflicts/)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Selected task dependencies' })).toHaveTextContent('Select a task to highlight its direct predecessors and successors in this diagram.');
    expect(Object.values(handlers).every(handler => handler.mock.calls.length === 0)).toBe(true);
  });

  it('focuses a selected task neighborhood with explicit text, dims the rest and clears without moving anything', async () => {
    const user = userEvent.setup();
    const { handlers } = renderCanvas();
    await user.click(screen.getByTestId('select-b'));
    const focus = screen.getByRole('status', { name: 'Selected task dependencies' });
    expect(focus).toHaveTextContent('Focused on Task-b. Unrelated tasks and dependencies are dimmed.');
    expect(focus).toHaveTextContent('2 direct predecessors in this diagram, 1 not done: Task-a (done) and Task-d (not done)');
    expect(focus).toHaveTextContent('1 more unfinished predecessor is outside this diagram and still counts for blocking.');
    expect(focus).toHaveTextContent('1 direct successor in this diagram: Task-c');
    expect(screen.getByTestId('node-b')).toHaveAttribute('data-selected', 'true');
    for (const id of ['ab', 'db', 'bc']) { expect(screen.getByTestId(`edge-${id}`)).toHaveAttribute('data-opacity', '1'); expect(screen.getByTestId(`edge-${id}`)).toHaveAttribute('data-layer', '1'); }
    expect(screen.getByTestId('edge-ea')).toHaveAttribute('data-opacity', '0.2'); expect(screen.getByTestId('edge-ea')).toHaveAttribute('data-layer', '0');
    expect(screen.getByTestId('node-e')).toHaveStyle({ opacity: '0.35' });
    expect(screen.getByTestId('node-a')).toHaveStyle({ opacity: '1' });
    await user.click(screen.getByRole('button', { name: 'Clear focus' }));
    expect(focus).toHaveTextContent('Select a task to highlight its direct predecessors and successors in this diagram.');
    expect(screen.getByTestId('node-b')).toHaveAttribute('data-selected', 'false');
    expect(screen.getByTestId('node-e')).toHaveStyle({ opacity: '1' });
    expect(screen.getByTestId('edge-ea')).toHaveAttribute('data-opacity', '1');
    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('names at most five neighbors and counts the rest, and reports a missing neighbor side', async () => {
    const user = userEvent.setup();
    const hub = node('h', 'todo');
    const leaves = Array.from({ length: 7 }, (_, index) => node(`s${index + 1}`, 'todo', { blocked: true, unresolvedCount: 1 }));
    render(<GraphCanvas tasks={[hub, ...leaves]} edges={leaves.map(leaf => ({ id: `h-${leaf.id}`, source: 'h', target: leaf.id }))} positions={{}} movable={false} connectable={false} onMove={vi.fn()} onOpen={vi.fn()} onConnect={vi.fn()} onViewBlockers={vi.fn()} />);
    await user.click(screen.getByTestId('select-h'));
    const focus = screen.getByRole('status', { name: 'Selected task dependencies' });
    expect(focus).toHaveTextContent('No direct predecessors in this diagram.');
    expect(focus).toHaveTextContent('7 direct successors in this diagram: Task-s1, Task-s2, Task-s3, Task-s4, Task-s5, and 2 more');
    expect(focus).not.toHaveTextContent('outside this diagram');
  });

  it('refits the viewport once per explicit request and never on mount or ordinary rerenders', async () => {
    const fitView = vi.fn(); flow.fitView = fitView;
    const view = renderCanvas(3);
    view.rerenderWith(3);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(fitView).not.toHaveBeenCalled();
    view.rerenderWith(4);
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1));
    view.rerenderWith(4);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(view.handlers.onMove).not.toHaveBeenCalled();
  });
});

function graphHarness(canvas: boolean) {
  const [done, waiting, violating] = [taskAt(1), taskAt(2), taskAt(3)] as [TaskDto, TaskDto, TaskDto];
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-graph-measure-node') ? new DOMRect(0, 0, 240, 160) : original.call(this); });
  const data = graph([done, waiting, violating], [done.id, waiting.id, violating.id], [{ ...edge(done.id, waiting.id), id: 'd1000000-0000-4000-8000-0000000000a1' }, { ...edge(waiting.id, violating.id), id: 'd1000000-0000-4000-8000-0000000000a2' }]);
  for (const item of data.nodes) {
    if (item.task.id === waiting.id) item.blocking = summary(waiting.id, 0, 'enforce');
    if (item.task.id === done.id) item.context.status = { ...item.context.status, name: 'Готово', group: 'done' };
    if (item.task.id === violating.id) { item.context.status = { ...item.context.status, name: 'В работе', group: 'in_progress' }; item.blocking = { ...summary(violating.id, 1, 'enforce'), violatesCurrentStatus: true }; }
  }
  const saved = [done, waiting, violating].map((task, index) => ({ taskId: task.id, x: index * 20, y: 0 }));
  const path = `${rootPath}/projects/${PROJECT_ID}`;
  const { calls } = installFakeApi({ [`GET ${path}/graph`]: () => ok(data), [`GET ${path}/graph-layout`]: () => ok(layout(saved, 1)), [`GET ${path}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'enforce', revision: 0, updatedAt: null }) });
  const client = createQueryClient({ retry: false });
  let controller: DependencyWorkspace | undefined;
  function Host() { controller = useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID); return <GraphView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Pilot')} controller={{ ...controller, roots: [done.id, waiting.id, violating.id], canvas }} loadedTasks={[done, waiting, violating]} onOpen={() => undefined} />; }
  const view = render(<QueryClientProvider client={client}><Host /></QueryClientProvider>);
  return { ...view, client, calls, saved, tasks: [done, waiting, violating], user: userEvent.setup({ pointerEventsCheck: 0 }), current: () => { if (!controller) throw new Error('Missing graph controller'); return controller; } };
}

describe('GraphView diagram companion controls', () => {
  it('collapses only the duplicate cards behind a disclosure, keeps every action reachable and refits after automatic layout without saving', async () => {
    const fitView = vi.fn(); flow.fitView = fitView;
    const h = graphHarness(true);
    try {
      const toggle = await screen.findByRole('button', { name: 'Show task cards and keyboard position controls (3)' });
      await screen.findByTestId(`node-${h.tasks[0].id}`);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('list', { name: 'Graph tasks and dependencies' })).not.toBeInTheDocument();
      // Dependency rows and personal layout actions stay outside the disclosure.
      const dependencies = screen.getByRole('region', { name: 'Dependencies in this selection' });
      expect(within(dependencies).getByText('Resolved: predecessor done')).toBeInTheDocument();
      expect(within(dependencies).getByText('Unresolved: predecessor not done')).toBeInTheDocument();
      expect(within(dependencies).getAllByRole('button', { name: 'Remove dependency' })).toHaveLength(2);
      const arrange = screen.getByRole('button', { name: 'Apply automatic layout' });
      await waitFor(() => expect(arrange).toBeEnabled());
      expect(fitView).not.toHaveBeenCalled();
      toggle.focus(); await h.user.keyboard('{Enter}');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAccessibleName('Hide task cards and keyboard position controls (3)');
      const cards = screen.getByRole('list', { name: 'Graph tasks and dependencies' });
      expect(toggle).toHaveAttribute('aria-controls', cards.parentElement?.id);
      expect(within(cards).getByText('Status conflicts with the blocking rule')).toBeInTheDocument();
      await h.user.click(within(cards).getAllByText('Position in my layout')[0] as HTMLElement);
      expect(within(cards).getByRole('button', { name: `Right: ${h.tasks[0].title}` })).toBeEnabled();
      await h.user.click(arrange);
      await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1));
      const expected = await arrangeGraph(h.tasks.map(task => task.id), [{ id: 'd1000000-0000-4000-8000-0000000000a1', source: h.tasks[0].id, target: h.tasks[1].id }, { id: 'd1000000-0000-4000-8000-0000000000a2', source: h.tasks[1].id, target: h.tasks[2].id }], Object.fromEntries(h.tasks.map(task => [task.id, { width: 240, height: 160 }])));
      expect(h.current().layout.moves).toEqual(expected);
      expect(h.current().layout.base?.positions).toEqual(h.saved);
      expect(h.calls.every(call => call.method === 'GET')).toBe(true);
      expect(screen.getByRole('button', { name: 'Save my layout' })).toBeEnabled();
    } finally { h.unmount(); h.client.clear(); }
  });

  it('keeps the plain card list in List mode with no disclosure', async () => {
    const h = graphHarness(false);
    try {
      const cards = await screen.findByRole('list', { name: 'Graph tasks and dependencies' });
      expect(within(cards).getByText('Status conflicts with the blocking rule')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /task cards and keyboard position controls/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Dependency graph' })).not.toBeInTheDocument();
      expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    } finally { h.unmount(); h.client.clear(); }
  });
});
