import type { SectionDto, TaskDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { alpha, anna, installFakeApi, ok, project } from '../../test/fakeApi';
import { createQueryClient } from '../../lib/queryClient';
import type { GraphCanvasProps } from './GraphCanvas';
import { GraphView } from './GraphView';
import { graph, layout, PROJECT_ID, rootPath, taskAt } from './test/fixtures';
import { useDependencyWorkspace, type DependencyWorkspace } from './useDependencyWorkspace';
const canvas = vi.hoisted(() => ({ current: null as GraphCanvasProps | null }));
vi.mock('./GraphCanvas', () => ({ default: (props: GraphCanvasProps) => { canvas.current = props; return <div data-testid="section-canvas" />; } }));
afterEach(() => { vi.restoreAllMocks(); canvas.current = null; });
const sections: SectionDto[] = [{ id: 'a0000000-0000-4000-8000-000000000001', workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Discovery', position: 1, revision: 1, archivedAt: null }, { id: 'a0000000-0000-4000-8000-000000000002', workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Delivery', position: 2, revision: 1, archivedAt: null }];
function harness(saved: boolean) {
  const tasks: [TaskDto, TaskDto, TaskDto] = [{ ...taskAt(1), sectionId: sections[1]?.id ?? null }, { ...taskAt(2), sectionId: sections[0]?.id ?? null }, { ...taskAt(3), sectionId: null }];
  const hidden = { taskId: taskAt(99).id, x: 777, y: 888 };
  const savedPositions = saved ? [{ taskId: tasks[0].id, x: 11, y: 22 }, hidden] : [];
  const rect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) { return this.hasAttribute('data-graph-measure-node') ? new DOMRect(0,0,240,180) : rect.call(this); });
  const path = `${rootPath}/projects/${PROJECT_ID}`;
  const api = installFakeApi({ [`GET ${path}/graph`]: () => ok(graph(tasks)), [`GET ${path}/graph-layout`]: () => ok(layout(savedPositions, 1)), [`GET ${path}/dependency-policy`]: () => ok({ projectId: PROJECT_ID, mode: 'warn', revision: 0, updatedAt: null }) });
  const client = createQueryClient({ retry: false }); let current: DependencyWorkspace | undefined;
  function Host() { current = useDependencyWorkspace(anna.id, alpha.id, PROJECT_ID); return <GraphView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Pilot')} controller={{ ...current, roots: tasks.map(task => task.id), canvas: true }} loadedTasks={tasks} sections={sections} onOpen={() => undefined}/>; }
  const view = render(<QueryClientProvider client={client}><Host/></QueryClientProvider>);
  return { ...view, tasks, hidden, savedPositions, calls: api.calls, client, user: userEvent.setup(), controller: () => { if (!current) throw new Error('Missing controller'); return current; } };
}
it('defaults an unsaved graph to measured section columns without any task/layout write', async () => {
  const h = harness(false);
  try {
    await screen.findByTestId('section-canvas'); await waitFor(() => expect(canvas.current?.columns?.map(item => item.title)).toEqual(['Discovery','Delivery','Unsectioned']));
    expect(screen.getByRole('button', { name: 'Section columns' })).toHaveAttribute('aria-pressed','true');
    expect(canvas.current?.movable).toBe(false); expect(canvas.current?.edges).toEqual([]);
    expect(canvas.current?.positions[h.tasks[1].id]?.x).toBeLessThan(canvas.current?.positions[h.tasks[0].id]?.x ?? 0);
    expect(h.controller().layout.moves).toEqual({}); expect(h.calls.every(call => call.method === 'GET')).toBe(true);
  } finally { h.unmount();h.client.clear(); }
});
it('previews sections without altering saved/manual positions, then explicitly stages only shown tasks and preserves hidden positions', async () => {
  const h = harness(true);
  try {
    await screen.findByTestId('section-canvas'); await waitFor(() => expect(canvas.current?.positions[h.tasks[0].id]).toEqual({x:11,y:22}));
    expect(screen.getByRole('button',{name:'My layout'})).toHaveAttribute('aria-pressed','true'); expect(canvas.current?.movable).toBe(true);
    await h.user.click(screen.getByRole('button',{name:'Section columns'}));
    const use = screen.getByRole('button',{name:'Use section layout'}); await waitFor(() => expect(use).toBeEnabled());
    const preview = structuredClone(canvas.current?.positions);expect(preview).toBeDefined();
    expect(h.controller().layout.base?.positions).toEqual(h.savedPositions);expect(h.controller().layout.moves).toEqual({});
    await h.user.click(screen.getByRole('button',{name:'My layout'})); await waitFor(() => expect(canvas.current?.positions[h.tasks[0].id]).toEqual({x:11,y:22}));
    await h.user.click(screen.getByRole('button',{name:'Section columns'}));await h.user.click(screen.getByRole('button',{name:'Use section layout'}));
    await waitFor(() => expect(h.controller().layout.moves).toEqual(preview));
    expect(canvas.current?.movable).toBe(true);expect(canvas.current?.columns).toBeUndefined();
    expect(h.controller().layoutInput?.positions).toContainEqual(h.hidden);expect(h.controller().layout.base?.positions).toEqual(h.savedPositions);
    expect(screen.getByRole('button',{name:'Save my layout'})).toBeEnabled();expect(h.calls.every(call => call.method === 'GET')).toBe(true);
    await h.user.click(screen.getByRole('button',{name:'Discard moves'}));expect(h.controller().layout.moves).toEqual({});expect(h.controller().layout.base?.positions).toEqual(h.savedPositions);
  } finally {h.unmount();h.client.clear();}
});
