import { availabilityReadRoutes, isAvailabilityRead } from './test/availability';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TaskDto, TaskScheduleBatchInput, TaskScheduleContextDto } from '@workloom/contracts';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, alphaMembers, anna, deferred, installFakeApi, ok, project, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { baseline, period } from '../planning/test/fixtures';
import { GanttView } from './GanttView';
import { ScheduleDialog, ScheduleNotices } from './ScheduleDialog';
import { BASELINE_ID, PERIOD_A, PROJECT_ID, STAMP, rootPath, scheduleContext, scheduledTask, schedulePath, schedulePreview } from './test/fixtures';
import { useScheduleWorkspace, type ScheduleWorkspace } from './useScheduleWorkspace';

// Production GanttView, move wrapper, controller, dialog and notices; fetch and pointer geometry are the only seams.
const clients: QueryClient[] = [];
beforeEach(() => {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init); this.pointerId = init.pointerId ?? 1; this.isPrimary = init.isPrimary ?? true;
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventStub);
});
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const previewPath = `${schedulePath}/schedule-preview`, applyPath = `${schedulePath}/schedule-apply`;
const writes = (calls: FakeRequest[]) => calls.filter(call => call.method !== 'GET' && !isAvailabilityRead(call));
/** The authorized context reports a newer revision than the loaded task: the move must use the context's. */
const CONTEXT_REVISION = 7;

interface HostProps { shown?: boolean; writable?: boolean }
function mount(tasks: TaskDto[], options: { context?: (dto: TaskScheduleContextDto) => TaskScheduleContextDto; routes?: RouteTable } = {}) {
  let current = tasks.map(task => ({ ...task, revision: CONTEXT_REVISION }));
  const { calls } = installFakeApi({
    ...availabilityReadRoutes,
    [`GET ${schedulePath}/schedule-context`]: request => {
      const ids = new Set(request.searchParams.get('taskIds')?.split(','));
      // The context echoes the requested baseline, exactly as the strict client read requires.
      const dto = scheduleContext(current.filter(task => ids.has(task.id)), request.searchParams.get('baselineId') === BASELINE_ID);
      return ok(options.context ? options.context(dto) : dto);
    },
    [`POST ${previewPath}`]: request => ok(schedulePreview(request.body as TaskScheduleBatchInput, current)),
    [`POST ${applyPath}`]: request => {
      const input = request.body as TaskScheduleBatchInput;
      current = current.map(task => { const row = input.rows.find(item => item.taskId === task.id); return row ? { ...task, startDate: row.startDate, dueDate: row.dueDate, revision: task.revision + 1 } : task; });
      return ok({ projectId: PROJECT_ID, tasks: current.filter(task => input.rows.some(row => row.taskId === task.id)), asOfChangeSeq: '2' });
    },
    ...options.routes,
  });
  const client = createQueryClient({ retry: false }); clients.push(client);
  let latest: ScheduleWorkspace | undefined;
  // Mirrors ProjectPage: the controller, dialog and notices outlive the Gantt view.
  function Host({ shown = true, writable = true }: HostProps) {
    const controller = useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone); latest = controller;
    return <>
      <ScheduleNotices controller={controller} />
      <ScheduleDialog controller={controller} workspaceId={alpha.id} projectId={PROJECT_ID} periods={[period()]} writable={writable} />
      {shown ? <GanttView actorId={anna.id} workspace={alpha} project={project(alpha.id, PROJECT_ID, 'Project')} tasks={tasks} tasksSettled selectedIds={[]} onSelect={() => undefined} periods={[period()]} members={alphaMembers} controller={controller} writable={writable} hasMore={false} loadingMore={false} onLoadMore={() => undefined} onOpen={() => undefined} /> : <p>{'table'}</p>}
    </>;
  }
  const wrap = (props: HostProps) => <QueryClientProvider client={client}><MemoryRouter><Host {...props} /></MemoryRouter></QueryClientProvider>;
  const view = render(wrap({}));
  return { calls, client, update: (props: HostProps) => view.rerender(wrap(props)), unmount: () => view.unmount(),
    controller: () => { if (!latest) throw new Error('Expected controller'); return latest; },
    drafts: () => protectedDraftsFor(client).protecting };
}
/** Records every protectedDrafts transition from now on; the registry emits only when `protecting` flips. */
function watchProtection(client: QueryClient) {
  const registry = protectedDraftsFor(client), log: boolean[] = [];
  const stop = registry.subscribe(() => log.push(registry.protecting));
  return { log, stop };
}
const contextRows = (tasks: TaskDto[]) => new Map(scheduleContext(tasks.map(task => ({ ...task, revision: CONTEXT_REVISION }))).rows.map(row => [row.taskId, row]));
const ghostOf = (row: HTMLElement) => within(row).queryByTestId('gantt-date-move-ghost');
async function rowOf(task: TaskDto) { return screen.findByRole('group', { name: `Calendar dates: ${task.title}` }); }
/** jsdom has no layout or pointer capture: give the track a stable box and the saved body a capture slot. */
function arm(body: HTMLElement) {
  const track = body.closest<HTMLElement>('[data-gantt-track]');
  if (!track) throw new Error('Expected track');
  track.getBoundingClientRect = () => ({ left: 40, width: 1008, right: 1048, top: 0, bottom: 36, height: 36, x: 40, y: 0, toJSON: () => ({}) });
  let captured = false;
  body.setPointerCapture = () => { captured = true; };
  body.hasPointerCapture = () => captured;
  body.releasePointerCapture = () => { captured = false; };
  return track;
}
const down = (body: HTMLElement, x = 100) => fireEvent.pointerDown(body, { pointerId: 1, isPrimary: true, button: 0, clientX: x });
const move = (x: number) => fireEvent.pointerMove(document, { pointerId: 1, clientX: x, cancelable: true });
const up = (x: number) => fireEvent.pointerUp(document, { pointerId: 1, clientX: x });

describe('Gantt bar direct saves and retained recovery', () => {
  it('keeps saved bars/anchors fixed through a held preview and view switch, then saves directly with one release', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const answer = deferred<Response>(); let input: TaskScheduleBatchInput | undefined;
    const h = mount([task], { routes: { [`POST ${previewPath}`]: request => { input = request.body as TaskScheduleBatchInput; return answer.promise; } } });
    const row = await rowOf(task), body = within(row).getByRole('button', { name: /Current: start 2026-10-24, due 2026-10-26/ });
    expect(body).toHaveAttribute('data-gantt-move-handle'); expect(body).toHaveAttribute('data-gantt-movable', task.id);
    expect(row.querySelectorAll('[data-gantt-movable]')).toHaveLength(1); arm(body);
    const saved = { left: body.style.left, width: body.style.width };
    const anchors = () => [...row.querySelectorAll('[data-gantt-anchor]')];
    expect(anchors()).toHaveLength(1); expect(anchors()[0]).toHaveAttribute('data-gantt-anchor', task.id);
    const protection = watchProtection(h.client);
    down(body); expect(h.drafts()).toBe(true); expect(protection.log).toEqual([true]); move(172);
    const ghost = ghostOf(row);
    expect(ghost).toHaveTextContent('Proposed, not applied: 2026-10-26 — 2026-10-28');
    expect(within(row).getAllByTestId('gantt-date-move-ghost')).toHaveLength(1);
    expect(ghost).not.toHaveAttribute('data-gantt-movable'); expect(ghost).not.toHaveAttribute('data-gantt-anchor');
    expect(ghost).toHaveClass('pointer-events-none'); expect(ghost?.closest('[data-gantt-anchor]')).toBeNull();
    expect(ghost?.querySelector('[data-gantt-anchor]')).toBeNull(); expect(anchors()).toHaveLength(1); expect(anchors()[0]).toContainElement(body);
    expect(body).toHaveAccessibleName(/Current: start 2026-10-24, due 2026-10-26/); expect(body.style.left).toBe(saved.left);
    expect(writes(h.calls)).toHaveLength(0); up(172);
    await waitFor(() => expect(input).toEqual({ rows: [{ taskId: task.id, expectedRevision: CONTEXT_REVISION, startDate: '2026-10-26', dueDate: '2026-10-28' }] }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(h.controller().activeId).toBeNull();
    expect(writes(h.calls)).toEqual([expect.objectContaining({ method: 'POST', path: previewPath, body: input })]);
    expect(Object.values(h.controller().drafts)).toHaveLength(1);
    expect(body).toHaveAttribute('aria-label', `Open ${task.title} · Current: start 2026-10-24, due 2026-10-26`);
    expect({ left: body.style.left, width: body.style.width }).toEqual(saved); expect(ghostOf(row)).toHaveTextContent('Proposed, not applied: 2026-10-26 — 2026-10-28');
    expect(protection.log).toEqual([true]);
    h.update({ shown: false }); expect(screen.queryByRole('region', { name: 'Project timeline' })).not.toBeInTheDocument();
    expect(h.drafts()).toBe(true); expect(protection.log).toEqual([true]); h.update({ shown: true });
    const again = await rowOf(task); expect(ghostOf(again)).toHaveTextContent('Proposed, not applied: 2026-10-26 — 2026-10-28');
    expect(writes(h.calls)).toHaveLength(1); expect(protection.log).toEqual([true]);
    await act(async () => { if (!input) throw new Error('Expected preview input'); answer.resolve(ok(schedulePreview(input, [task]))); });
    await waitFor(() => expect(writes(h.calls).filter(call => call.path === applyPath).map(call => call.body)).toEqual([{ rows: [{ taskId: task.id, expectedRevision: CONTEXT_REVISION, startDate: '2026-10-26', dueDate: '2026-10-28' }], previewHash: 'a'.repeat(64) }]));
    await waitFor(() => expect(h.drafts()).toBe(false)); expect(protection.log).toEqual([true, false]); protection.stop();
    const applied = await within(await rowOf(task)).findByRole('button', { name: /Current: start 2026-10-26, due 2026-10-28/ });
    await waitFor(() => expect(applied).toHaveAttribute('data-gantt-movable', task.id));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByTestId('gantt-date-move-ghost')).not.toBeInTheDocument();
  });

  it('directly saves a due-only point with start still null and one continuous lease', async () => {
    const task = scheduledTask(1, null, '2026-10-24'), h = mount([task]);
    const row = await rowOf(task), body = within(row).getByRole('button', { name: /Current: start Not set, due 2026-10-24; only due date/ });
    expect(body).toHaveAttribute('data-gantt-movable', task.id); arm(body); const protection = watchProtection(h.client);
    down(body); move(64);
    const ghost = ghostOf(row); expect(ghost).toHaveAttribute('title', 'Proposed, not applied: Not set — 2026-10-23');
    expect(ghost).toHaveClass('pointer-events-none'); expect(ghost?.querySelector('span[aria-hidden="true"]')).not.toBeNull();
    expect(ghost?.querySelector('[data-gantt-anchor], [data-gantt-movable], [data-gantt-move-handle]')).toBeNull();
    expect(ghost?.closest('[data-gantt-anchor]')).toBeNull(); expect(writes(h.calls)).toHaveLength(0); up(64);
    await waitFor(() => expect(h.controller().drafts).toEqual({}));
    expect(writes(h.calls).map(call => call.body)).toEqual([{ rows: [{ taskId: task.id, expectedRevision: CONTEXT_REVISION, startDate: null, dueDate: '2026-10-23' }] }, { rows: [{ taskId: task.id, expectedRevision: CONTEXT_REVISION, startDate: null, dueDate: '2026-10-23' }], previewHash: 'a'.repeat(64) }]);
    await waitFor(() => expect(h.drafts()).toBe(false)); expect(protection.log).toEqual([true, false]); protection.stop();
    await within(row).findByRole('button', { name: /Current: start Not set, due 2026-10-23; only due date/ });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(ghostOf(row)).toBeNull();
  });

  it('keeps an outside-window proposal unanchored while blocked, opens explicit recovery, and discards without any apply', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const h = mount([task], { routes: { [`POST ${previewPath}`]: request => ok({ ...schedulePreview(request.body as TaskScheduleBatchInput, [task]), protectedTargets: [{ taskId: task.id, reason: 'archived_task' }] }) } });
    const row = await rowOf(task), body = within(row).getByRole('button', { name: /Current: start 2026-10-24, due 2026-10-26/ }); arm(body);
    down(body); move(1180);
    const outside = 'Proposed, not applied: 2026-11-23 — 2026-11-25 (outside this window)', ghost = ghostOf(row);
    expect(ghost).toHaveTextContent(outside); expect(ghost).toHaveAttribute('data-gantt-proposal'); expect(ghost).toHaveClass('pointer-events-none');
    expect(ghost?.closest('[data-gantt-anchor]')).toBeNull(); expect(ghost?.querySelector('[data-gantt-anchor], [data-gantt-movable], button')).toBeNull();
    expect(within(row).getAllByTestId('gantt-date-move-ghost')).toHaveLength(1); up(1180);
    await screen.findByRole('button', { name: 'Review' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(h.calls).map(call => call.body)).toEqual([{ rows: [{ taskId: task.id, expectedRevision: CONTEXT_REVISION, startDate: '2026-11-23', dueDate: '2026-11-25' }] }]);
    expect(ghostOf(row)).toHaveTextContent(outside); expect(body).toHaveAttribute('aria-label', `Open ${task.title} · Current: start 2026-10-24, due 2026-10-26`);
    fireEvent.click(screen.getByRole('button', { name: 'Review' })); const dialog = await screen.findByRole('dialog', { name: 'Edit task dates' });
    expect(within(dialog).getByRole('button', { name: 'Apply dates' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard date draft' }));
    await waitFor(() => expect(ghostOf(row)).toBeNull()); expect(writes(h.calls).filter(call => call.path === applyPath)).toHaveLength(0);
  });

  it('releases the direct preview lease on controller cleanup and never applies its late answer', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26'), answer = deferred<Response>(); let input: TaskScheduleBatchInput | undefined;
    const h = mount([task], { routes: { [`POST ${previewPath}`]: request => { input = request.body as TaskScheduleBatchInput; return answer.promise; } } });
    const body = within(await rowOf(task)).getByRole('button', { name: /Current:/ }); arm(body); const protection = watchProtection(h.client);
    down(body); move(172); up(172); await waitFor(() => expect(input).toBeDefined());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(protection.log).toEqual([true]); h.unmount();
    expect(protection.log).toEqual([true, false]); expect(h.drafts()).toBe(false); protection.stop();
    await act(async () => { if (!input) throw new Error('Expected preview input'); answer.resolve(ok(schedulePreview(input, [task]))); });
    expect(writes(h.calls).filter(call => call.path === applyPath)).toHaveLength(0);
  });
});

describe('move gates', () => {
  it('refuses to start beside a retained date draft without acquiring protection, and leaves Edit dates available', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const h = mount([task]);
    const row = await rowOf(task);
    const body = within(row).getByRole('button', { name: name => name.endsWith('Current: start 2026-10-24, due 2026-10-26') });
    expect(body).toHaveAttribute('data-gantt-movable', task.id);
    fireEvent.click(within(row).getByRole('button', { name: 'Edit dates' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task dates' });
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const retained = h.controller().drafts;
    // Blocked but eligible: the handle stays for guidance on an attempted drag, the movable marker does not.
    expect(body).toHaveAttribute('data-gantt-move-handle');
    expect(body).not.toHaveAttribute('data-gantt-movable');
    expect(document.querySelectorAll('[data-gantt-movable]')).toHaveLength(0);
    const capture = vi.fn(); arm(body); body.setPointerCapture = capture;
    down(body); move(172); up(172);
    expect(capture).not.toHaveBeenCalled();
    expect(h.drafts()).toBe(false);
    expect(screen.getByText('This task has a date draft or a move being saved. Finish or discard it first; other bars can still move. Edit dates is still available.')).toBeInTheDocument();
    expect(h.controller().drafts).toBe(retained);
    expect(screen.queryByText(/^Proposed, not applied/)).not.toBeInTheDocument();
    expect(ghostOf(row)).toBeNull();
    expect(within(row).getByRole('button', { name: 'Edit dates' })).toBeEnabled();
    // Discarding the retained draft reopens the gate and the guidance disappears.
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(screen.queryByText(/This task has a date draft/)).not.toBeInTheDocument());
    expect(body).toHaveAttribute('data-gantt-movable', task.id);
    down(body); move(172); up(172);
    await waitFor(() => expect(writes(h.calls).filter(call => call.path === applyPath)).toHaveLength(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(writes(h.calls)).toHaveLength(2);
  });

  it('refuses a pending/unknown command at start and at drop, but not an unrelated hidden task draft', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const h = mount([task]);
    const row = await rowOf(task);
    const body = within(row).getByRole('button', { name: name => name.endsWith('Current: start 2026-10-24, due 2026-10-26') });
    arm(body);
    expect(body).toHaveAttribute('data-gantt-movable', task.id);
    const command = protectedCommandsFor(h.client).register();
    act(() => command.set(true));
    expect(body).toHaveAttribute('data-gantt-move-handle');
    expect(body).not.toHaveAttribute('data-gantt-movable');
    down(body); move(172); up(172);
    expect(h.drafts()).toBe(false);
    expect(screen.getByText('A change is still being submitted or is unconfirmed. Resolve it before moving a bar. Edit dates is still available.')).toBeInTheDocument();
    act(() => command.set(false));
    await waitFor(() => expect(screen.queryByText(/still being submitted or is unconfirmed/)).not.toBeInTheDocument());
    expect(body).toHaveAttribute('data-gantt-movable', task.id);

    // A command that becomes unknown mid-gesture refuses the drop; its lease is disposed and nothing is staged.
    down(body); move(172);
    expect(h.drafts()).toBe(true);
    act(() => command.set(true));
    up(172);
    expect(h.drafts()).toBe(false);
    expect(h.controller().drafts).toEqual({});
    expect(screen.queryByText(/^Proposed, not applied/)).not.toBeInTheDocument();
    expect(screen.getByText(/still being submitted or is unconfirmed/)).toBeInTheDocument();
    expect(body).not.toHaveAttribute('data-gantt-movable');
    act(() => command.dispose());
    expect(body).toHaveAttribute('data-gantt-movable', task.id);

    // An unrelated retained task draft has its own owner: the move still stages, and that draft stays protected.
    const unrelated = protectedDraftsFor(h.client).register();
    act(() => unrelated.set(true));
    expect(body).toHaveAttribute('data-gantt-movable', task.id);
    down(body); move(172); up(172);
    await waitFor(() => expect(writes(h.calls).filter(call => call.path === applyPath)).toHaveLength(1));
    await waitFor(() => expect(h.controller().drafts).toEqual({}));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(h.drafts()).toBe(true);
    unrelated.dispose();
    expect(h.drafts()).toBe(false);
    expect(writes(h.calls).filter(call => call.path === applyPath)).toHaveLength(1);
  });

  it('offers a handle only for loaded current, nonmeeting, writable, editable task dates', async () => {
    const movable = scheduledTask(1, '2026-10-24', '2026-10-26');
    const locked = scheduledTask(2, '2026-10-25', '2026-10-27');
    const meeting = { ...scheduledTask(3, '2026-10-25', '2026-10-25'), meetingId: 'af000000-0000-4000-8000-000000000001' };
    const undated = scheduledTask(4);
    const archived = { ...scheduledTask(5, '2026-10-25', '2026-10-27'), archivedAt: STAMP };
    const h = mount([movable, locked, meeting, undated, archived], { context: dto => ({ ...dto, rows: dto.rows.map(row => row.taskId === locked.id ? { ...row, editableDates: false } : row) }) });
    const movableBody = within(await rowOf(movable)).getByRole('button', { name: /Current:/ });
    expect(movableBody).toHaveAttribute('data-gantt-move-handle');
    expect(movableBody).toHaveAttribute('data-gantt-movable', movable.id);
    const lockedBody = within(await rowOf(locked)).getByRole('button', { name: /Current:/ });
    expect(lockedBody).not.toHaveAttribute('data-gantt-move-handle');
    expect(lockedBody).not.toHaveAttribute('data-gantt-movable');
    const archivedBody = within(await rowOf(archived)).getByRole('button', { name: /Current:/ });
    expect(archivedBody).not.toHaveAttribute('data-gantt-move-handle');
    expect(archivedBody).not.toHaveAttribute('data-gantt-movable');
    expect(within(await rowOf(meeting)).queryByRole('img')).not.toBeInTheDocument();
    expect((await rowOf(meeting)).querySelector('[data-gantt-movable], [data-gantt-move-handle]')).toBeNull();
    expect((await rowOf(undated)).querySelector('[data-gantt-movable], [data-gantt-move-handle]')).toBeNull();
    // Exactly one enabled body, on the saved bar itself (never its row, track or anchor wrapper).
    expect([...document.querySelectorAll('[data-gantt-movable]')]).toEqual([movableBody]);
    expect(movableBody).toHaveAttribute('role', 'button');
    arm(lockedBody); down(lockedBody); move(172); up(172);
    expect(h.drafts()).toBe(false);
    h.update({ writable: false });
    expect(within(await rowOf(movable)).getByRole('button', { name: /Current:/ })).not.toHaveAttribute('data-gantt-move-handle');
    expect(document.querySelectorAll('[data-gantt-move-handle]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-gantt-movable]')).toHaveLength(0);
    expect(writes(h.calls)).toHaveLength(0);
  });

  it('never marks a frozen baseline bar movable; only the saved current body carries the selector', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const h = mount([task], { routes: { [`GET ${rootPath}/periods/${PERIOD_A}/baselines`]: () => ok([baseline()]) } });
    await rowOf(task);
    // A real selection: the controller requests this baseline and the context answers for exactly it.
    act(() => { h.controller().setBaselinePeriodId(PERIOD_A); h.controller().setBaselineId(BASELINE_ID); });
    const row = await waitFor(() => {
      const found = screen.getByRole('group', { name: `Calendar dates: ${task.title}` });
      expect(within(found).getAllByRole('img')).toHaveLength(1);
      expect(within(found).getByRole('button', { name: /Current:/ })).toBeInTheDocument();
      return found;
    });
    expect(h.calls.some(call => call.method === 'GET' && call.path === `${schedulePath}/schedule-context` && call.searchParams.get('baselineId') === BASELINE_ID)).toBe(true);
    const current = within(row).getByRole('button', { name: name => name.endsWith('Current: start 2026-10-24, due 2026-10-26') });
    await waitFor(() => expect(current).toHaveAttribute('data-gantt-movable', task.id));
    const bodies = [current, ...within(row).getAllByRole('img')];
    expect(bodies).toHaveLength(2);
    const frozen = bodies.find(item => item !== current);
    expect(frozen).toHaveAccessibleName(/^Frozen: /);
    expect(frozen).not.toHaveAttribute('data-gantt-movable');
    expect(frozen).not.toHaveAttribute('data-gantt-move-handle');
    expect([...row.querySelectorAll('[data-gantt-movable]')]).toEqual([current]);
  });

  it('marks nothing movable when the context answer is missing an authorized row', async () => {
    const loaded = scheduledTask(1, '2026-10-24', '2026-10-26');
    const missing = scheduledTask(2, '2026-10-25', '2026-10-27');
    const h = mount([loaded, missing], { context: dto => ({ ...dto, rows: dto.rows.filter(row => row.taskId !== missing.id) }) });
    // The strict client read rejects the incomplete answer: the settled outcome is the retryable error, not a partial calendar.
    const alert = (await screen.findByText('The server returned an unexpected response.')).closest<HTMLElement>('[role="alert"]');
    if (!alert) throw new Error('Expected the context error alert');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: `Calendar dates: ${loaded.title}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Current:/ })).not.toBeInTheDocument();
    expect(document.querySelectorAll('[data-gantt-movable], [data-gantt-move-handle]')).toHaveLength(0);
    expect(h.drafts()).toBe(false);
    expect(ghostOf(document.body)).toBeNull();
    expect(writes(h.calls)).toHaveLength(0);
  });

  it('refuses a drag started in the same tick as a manual open, from synchronous draft refs, before React re-renders', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const h = mount([task]);
    const row = await rowOf(task);
    const body = within(row).getByRole('button', { name: name => name.endsWith('Current: start 2026-10-24, due 2026-10-26') });
    expect(body).toHaveAttribute('data-gantt-movable', task.id);
    const capture = vi.fn(); arm(body); body.setPointerCapture = capture;
    const protection = watchProtection(h.client);
    const rendered = h.controller();
    let unrendered = false;
    // One act stack: the production open() records the draft only in state and refs, then the saved body is pressed.
    act(() => {
      rendered.open([task], contextRows([task]));
      down(body);
      unrendered = h.controller() === rendered && !screen.queryByRole('dialog') && body.hasAttribute('data-gantt-movable');
    });
    expect(unrendered).toBe(true);
    expect(capture).not.toHaveBeenCalled();
    expect(protection.log).toEqual([]);
    expect(h.drafts()).toBe(false);
    move(172); up(172);
    expect(ghostOf(row)).toBeNull();
    expect(protection.log).toEqual([]);
    protection.stop();
    // Only the manual draft exists, unchanged; no move draft and no preview.
    const drafts = Object.values(h.controller().drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.origin).toBeUndefined();
    expect(drafts[0]?.rows[0]).toMatchObject({ taskId: task.id, startDate: '2026-10-24', dueDate: '2026-10-26', expectedRevision: CONTEXT_REVISION });
    expect(writes(h.calls)).toHaveLength(0);
    expect(await screen.findByRole('dialog', { name: 'Edit task dates' })).toBeInTheDocument();
    expect(screen.getByText('This task has a date draft or a move being saved. Finish or discard it first; other bars can still move. Edit dates is still available.')).toBeInTheDocument();
    expect(body).toHaveAttribute('data-gantt-move-handle');
    expect(body).not.toHaveAttribute('data-gantt-movable');
  });

  it('cancels on Escape or a window change without a ghost, draft, preview or retained protection', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const h = mount([task]);
    const row = await rowOf(task);
    const body = within(row).getByRole('button', { name: /Current:/ });
    arm(body);
    down(body); move(172);
    expect(screen.getByText(/^Proposed, not applied/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    up(172);
    expect(screen.queryByText(/^Proposed, not applied/)).not.toBeInTheDocument();
    expect(h.drafts()).toBe(false);

    down(body); move(172);
    act(() => h.controller().setWindowSize(84));
    up(172);
    expect(screen.queryByText(/^Proposed, not applied/)).not.toBeInTheDocument();
    expect(h.drafts()).toBe(false);
    expect(h.controller().drafts).toEqual({});
    expect(writes(h.calls)).toHaveLength(0);
  });

  it('ignores a late manual preview after its explicit draft changed and never applies it', async () => {
    const task = scheduledTask(1, '2026-10-24', '2026-10-26');
    const answer = deferred<Response>();
    let first: TaskScheduleBatchInput | undefined;
    const h = mount([task], { routes: { [`POST ${previewPath}`]: request => { first ??= request.body as TaskScheduleBatchInput; return answer.promise; } } });
    const row = await rowOf(task);
    const body = within(row).getByRole('button', { name: /Current:/ });
    expect(body).toHaveAttribute('data-gantt-movable', task.id);
    fireEvent.click(within(row).getByRole('button', { name: 'Edit dates' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task dates' });
    fireEvent.change(within(dialog).getByLabelText('Start date'), { target: { value: '2026-10-26' } });
    fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: '2026-10-28' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }));
    await waitFor(() => expect(first).toEqual({ rows: [{ taskId: task.id, expectedRevision: CONTEXT_REVISION, startDate: '2026-10-26', dueDate: '2026-10-28' }] }));
    fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: '2026-10-30' } });
    expect(h.controller().previewing).not.toBeNull();
    await act(async () => { if (first) answer.resolve(ok(schedulePreview(first, [task]))); });
    await waitFor(() => expect(h.controller().previewing).toBeNull());
    expect(within(dialog).queryByRole('region', { name: 'Task date change preview' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Apply dates' })).toBeDisabled();
    expect(h.controller().active?.rows[0]).toMatchObject({ startDate: '2026-10-26', dueDate: '2026-10-30', expectedRevision: CONTEXT_REVISION });
    expect(writes(h.calls).filter(call => call.path === applyPath)).toHaveLength(0);
  });
});
