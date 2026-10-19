import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TaskDto, TaskScheduleBatchInput } from '@workloom/contracts';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, alphaMembers, anna, installFakeApi, ok, project, type FakeRequest } from '../../test/fakeApi';
import { period } from '../planning/test/fixtures';
import { GanttView } from './GanttView';
import { ScheduleDialog, ScheduleNotices } from './ScheduleDialog';
import { PROJECT_ID, scheduleContext, scheduledTask, schedulePath, schedulePreview } from './test/fixtures';
import { useScheduleWorkspace } from './useScheduleWorkspace';

// Production GanttView, move wrapper, controller, dialog and notices; fetch and pointer geometry are the only seams.
const clients: QueryClient[] = [];
beforeEach(() => {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true; }
  }
  vi.stubGlobal('PointerEvent', PointerEventStub);
});
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const previewPath = `${schedulePath}/schedule-preview`, applyPath = `${schedulePath}/schedule-apply`;
const writes = (calls: FakeRequest[]) => calls.filter(call => call.method !== 'GET' && call.path !== previewPath && !call.path.endsWith('/time-off/availability'));

function mount(tasks: TaskDto[], writable = true) {
  let current = tasks.map(task => ({ ...task, revision: 7 }));
  const onOpen = vi.fn();
  const { calls } = installFakeApi({
    [`POST /api/v1/workspaces/${alpha.id}/time-off/availability`]: request => { const range = request.body as { startDate: string; endDate: string }; return ok({ ...range, settingsConfigured: false, sourceVersion: 'a'.repeat(64), days: [], members: [], totals: { scheduledMinutes: 0, holidayMinutes: 0, absenceMinutes: 0, availableMinutes: 0, unconfiguredMembers: 0 }, intervals: [], companyHolidays: [], inputVersions: { settingsRevision: 0, profiles: [], requests: [] } }); },
    [`GET ${schedulePath}/schedule-context`]: request => { const ids = new Set(request.searchParams.get('taskIds')?.split(',')); return ok(scheduleContext(current.filter(task => ids.has(task.id)))); },
    [`POST ${previewPath}`]: request => ok(schedulePreview(request.body as TaskScheduleBatchInput, current)),
    [`POST ${applyPath}`]: request => {
      const input = request.body as TaskScheduleBatchInput;
      current = current.map(task => { const row = input.rows.find(item => item.taskId === task.id); return row ? { ...task, startDate: row.startDate, dueDate: row.dueDate, revision: task.revision + 1 } : task; });
      return ok({ projectId: PROJECT_ID, tasks: current.filter(task => input.rows.some(row => row.taskId === task.id)), asOfChangeSeq: '2' });
    },
  });
  const client = createQueryClient({ retry: false }); clients.push(client);
  function Host() {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone);
    return <>
      <ScheduleNotices controller={controller} />
      <ScheduleDialog controller={controller} workspaceId={alpha.id} projectId={PROJECT_ID} periods={[period()]} writable={writable} />
      <GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} tasks={tasks} tasksSettled selectedIds={[]} onSelect={() => undefined} periods={[period()]} members={alphaMembers} controller={controller} writable={writable} hasMore={false} loadingMore={false} onLoadMore={() => undefined} onOpen={onOpen} />
    </>;
  }
  render(<QueryClientProvider client={client}><MemoryRouter><Host /></MemoryRouter></QueryClientProvider>);
  return { calls, onOpen };
}
const barOf = (task: TaskDto) => screen.findByRole('button', { name: (name: string) => name.startsWith(`Open ${task.title} · `) });
/** jsdom has no layout or pointer capture: give the track a stable box and the saved body a capture slot. */
function arm(body: HTMLElement) {
  const track = body.closest<HTMLElement>('[data-gantt-track]');
  if (!track) throw new Error('Expected track');
  track.getBoundingClientRect = () => ({ left: 40, width: 1008, right: 1048, top: 0, bottom: 36, height: 36, x: 40, y: 0, toJSON: () => ({}) });
  let captured = false;
  body.setPointerCapture = () => { captured = true; };
  body.hasPointerCapture = () => captured;
  body.releasePointerCapture = () => { captured = false; };
}
async function movableBar(task: TaskDto) {
  await waitFor(() => expect(document.querySelector(`[data-gantt-movable="${task.id}"]`)).not.toBeNull());
  const body = await barOf(task);
  arm(body);
  return body;
}
const drag = (body: HTMLElement, to: number) => {
  fireEvent.pointerDown(body, { pointerId: 1, isPrimary: true, button: 0, clientX: 100 });
  fireEvent.pointerMove(document, { pointerId: 1, clientX: to, cancelable: true });
};

describe('direct Gantt move', () => {
  it('a drop saves through preview then apply with no dialog, and the drag does not open the task', async () => {
    const task = scheduledTask(1, '2026-10-20', '2026-10-22');
    const s = mount([task]);
    const body = await movableBar(task);
    drag(body, 100 + 3 * 36);
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 100 + 3 * 36 });
    fireEvent.click(body);
    expect(s.onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(writes(s.calls)).toHaveLength(1));
    expect(writes(s.calls)[0]?.path).toBe(applyPath);
    expect(s.calls.filter(call => call.path === previewPath)).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a click below the threshold and Enter open the task; Escape after a drag cancels without opening or writing', async () => {
    const task = scheduledTask(1, '2026-10-20', '2026-10-22');
    const s = mount([task]);
    const body = await movableBar(task);
    fireEvent.pointerDown(body, { pointerId: 1, isPrimary: true, button: 0, clientX: 100 });
    fireEvent.pointerUp(document, { pointerId: 1, clientX: 101 });
    fireEvent.click(body);
    expect(s.onOpen).toHaveBeenCalledWith(task.id);
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(s.onOpen).toHaveBeenCalledTimes(2);
    drag(body, 260);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(body);
    expect(s.onOpen).toHaveBeenCalledTimes(2);
    expect(writes(s.calls)).toHaveLength(0);
    expect(s.calls.filter(call => call.path === previewPath)).toHaveLength(0);
  });

  it('a read-only current bar still opens its task and has no move handle', async () => {
    const task = scheduledTask(1, '2026-10-20', '2026-10-22');
    const s = mount([task], false);
    const body = await barOf(task);
    expect(body.hasAttribute('data-gantt-move-handle')).toBe(false);
    fireEvent.click(body);
    expect(s.onOpen).toHaveBeenCalledWith(task.id);
  });

  it('keeps the compact toolbar and holds the dependency checks behind Details', async () => {
    const task = scheduledTask(1, '2026-10-20', '2026-10-22');
    mount([task]);
    await barOf(task);
    const details = screen.getByRole('button', { name: 'Details' });
    expect(details.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'About timeline' })).toBeNull();
    fireEvent.click(details);
    expect(details.getAttribute('aria-expanded')).toBe('true');
  });
});
