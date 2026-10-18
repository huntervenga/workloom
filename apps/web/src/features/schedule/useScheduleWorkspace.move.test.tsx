import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TaskDto, TaskScheduleBatchInput } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, failure, installFakeApi, ok, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { context as dependencyContext } from '../dependencies/test/fixtures';
import { moveDateRange, type DateMoveProposal, type DateMoveSource } from './dateGesture';
import { PERIOD_A, PROJECT_ID, scheduleContext, scheduledTask, schedulePath, schedulePreview } from './test/fixtures';
import { useScheduleWorkspace, type ScheduleWorkspace } from './useScheduleWorkspace';

// Production controller and real QueryClient; fetch is the only seam and leases are spies.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const previewPath = `${schedulePath}/schedule-preview`, applyPath = `${schedulePath}/schedule-apply`;
const task = scheduledTask(1, '2026-10-24', null);
const other = scheduledTask(2, '2026-10-20', '2026-10-22');
const tasks = [task, other];
const sourceOf = (item: TaskDto): DateMoveSource => Object.freeze({ taskId: item.id, title: item.title, expectedRevision: 7, startDate: item.startDate ?? null, dueDate: item.dueDate });
const source = sourceOf(task);
function proposal(delta = 2, from: DateMoveSource = source): DateMoveProposal { const value = moveDateRange(from, delta); if (!value) throw new Error('Expected proposal'); return value; }
const lease = () => ({ dispose: vi.fn() });
const scope = { actorId: anna.id, workspaceId: alpha.id, projectId: PROJECT_ID };
/** A gate a route can await; releasing it lets that one answer through. */
function gate() { let release: () => void = () => undefined; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release: () => release() }; }
const applied = (request: FakeRequest) => {
  const input = request.body as TaskScheduleBatchInput;
  return ok({ projectId: PROJECT_ID, tasks: input.rows.flatMap(row => tasks.filter(item => item.id === row.taskId).map(item => ({ ...item, startDate: row.startDate, dueDate: row.dueDate, revision: row.expectedRevision + 1 }))), asOfChangeSeq: '2' });
};

function setup(routes: RouteTable = {}) {
  const { calls } = installFakeApi({ [`POST ${previewPath}`]: request => ok(schedulePreview(request.body as TaskScheduleBatchInput, tasks)), [`POST ${applyPath}`]: applied, ...routes });
  const client = createQueryClient({ retry: false }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone), { wrapper });
  const c = (): ScheduleWorkspace => view.result.current;
  const previews = () => calls.filter(call => call.path === previewPath);
  const applies = () => calls.filter(call => call.path === applyPath);
  return { calls, client, view, c, previews, applies };
}
const exactRow = (from: DateMoveSource, delta: number) => { const next = proposal(delta, from); return { taskId: from.taskId, expectedRevision: 7, startDate: next.startDate, dueDate: next.dueDate }; };

describe('direct move lane', () => {
  it('previews then applies the exact immutable source without opening any dialog, then releases the lease', async () => {
    const s = setup(); const held = lease();
    let staged = false;
    act(() => { staged = s.c().stageMove(proposal(), held, scope); });
    expect(staged).toBe(true);
    const drafts = Object.values(s.c().drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ origin: 'move', rows: [{ taskId: task.id, title: task.title, expectedRevision: 7, startDate: '2026-10-26', dueDate: '', baseStart: '2026-10-24', baseDue: '', editable: true }] });
    expect(s.c().activeId).toBeNull();
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    expect(s.c().activeId).toBeNull();
    expect(s.previews().map(call => call.body)).toEqual([{ rows: [exactRow(source, 2)] }]);
    expect(s.applies().map(call => call.body)).toEqual([{ rows: [exactRow(source, 2)], previewHash: 'a'.repeat(64) }]);
    expect(held.dispose).toHaveBeenCalledTimes(1);
    // The cleared row moves again at once.
    expect(s.c().moveGate()).toBeNull(); expect(s.c().moveGate(task.id)).toBeNull();
    const next = lease();
    act(() => { staged = s.c().stageMove(proposal(-1), next, scope); });
    expect(staged).toBe(true);
    await waitFor(() => expect(s.applies()).toHaveLength(2));
    await waitFor(() => expect(next.dispose).toHaveBeenCalledTimes(1));
  });

  it('a retained manual draft blocks only its own task, never every bar', async () => {
    const s = setup(); const row = scheduleContext([{ ...task, revision: 7 }]).rows[0];
    if (!row) throw new Error('Expected row');
    const first = lease(), second = lease(); let staged = true, unrelated = false;
    act(() => { s.c().open([task], new Map([[task.id, row]])); staged = s.c().stageMove(proposal(), first, scope); });
    expect(staged).toBe(false);
    expect(s.c().moveGate()).toBeNull();
    expect(s.c().moveGate(task.id)).toBe('draft');
    expect(s.c().moveGate(other.id)).toBeNull();
    const manual = Object.values(s.c().drafts)[0];
    expect(manual?.origin).toBeUndefined();
    act(() => { unrelated = s.c().stageMove(proposal(1, sourceOf(other)), second, scope); });
    expect(unrelated).toBe(true);
    await waitFor(() => expect(s.applies()).toHaveLength(1));
    expect(s.applies()[0]?.body).toEqual({ rows: [exactRow(sourceOf(other), 1)], previewHash: 'a'.repeat(64) });
    // The manual draft is untouched, unpreviewed and still the dialog's own.
    expect(s.c().drafts[manual?.id ?? '']).toEqual(manual);
    expect(s.previews().every(call => (call.body as TaskScheduleBatchInput).rows.every(item => item.taskId === other.id))).toBe(true);
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it('serializes different rows and coalesces an unsent same-task proposal only on the exact captured source', async () => {
    const hold = gate(); let previewsSeen = 0;
    const s = setup({ [`POST ${previewPath}`]: async request => { if (++previewsSeen === 1) await hold.promise; return ok(schedulePreview(request.body as TaskScheduleBatchInput, tasks)); } });
    const a = lease(), b1 = lease(), b2 = lease(), stale = lease();
    const otherSource = sourceOf(other);
    let results: boolean[] = [];
    act(() => { results = [s.c().stageMove(proposal(), a, scope), s.c().stageMove(proposal(1, otherSource), b1, scope)]; });
    expect(results).toEqual([true, true]);
    await waitFor(() => expect(s.previews()).toHaveLength(1));
    // Unsent and exact: replaced in place, its old lease released. A different captured revision is refused.
    act(() => { results = [s.c().stageMove(proposal(3, otherSource), b2, scope), s.c().stageMove(proposal(5, { ...otherSource, expectedRevision: 6 }), stale, scope)]; });
    expect(results).toEqual([true, false]);
    expect(b1.dispose).toHaveBeenCalledTimes(1);
    const queued = Object.values(s.c().drafts).find(draft => draft.rows[0]?.taskId === other.id);
    expect(queued).toMatchObject({ moveState: 'queued', preview: null, rows: [{ startDate: '2026-10-23', dueDate: '2026-10-25' }] });
    expect(s.applies()).toHaveLength(0);
    await act(async () => { hold.release(); await hold.promise; });
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    expect(s.previews().map(call => call.body)).toEqual([{ rows: [exactRow(source, 2)] }, { rows: [exactRow(otherSource, 3)] }]);
    expect(s.applies().map(call => (call.body as TaskScheduleBatchInput).rows[0]?.taskId)).toEqual([task.id, other.id]);
    expect(s.applies()[1]?.body).toEqual({ rows: [exactRow(otherSource, 3)], previewHash: 'a'.repeat(64) });
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b2.dispose).toHaveBeenCalledTimes(1);
    expect(stale.dispose).not.toHaveBeenCalled();
  });

  it.each(['answer', 'failure'] as const)('coalesces the first unsent move while its preview is held and ignores the obsolete %s', async result => {
    const hold = gate(); let seen = 0;
    const s = setup({ [`POST ${previewPath}`]: async request => {
      if (++seen === 1) { await hold.promise; if (result === 'failure') return failure(422, 'VALIDATION_FAILED', 'Obsolete preview'); }
      return ok(schedulePreview(request.body as TaskScheduleBatchInput, tasks));
    } });
    const first = lease(), latest = lease(); let accepted = false;
    act(() => { s.c().stageMove(proposal(1), first, scope); });
    await waitFor(() => expect(s.previews()).toHaveLength(1));
    act(() => { accepted = s.c().stageMove(proposal(4), latest, scope); });
    expect(accepted).toBe(true); expect(first.dispose).toHaveBeenCalledTimes(1); expect(s.applies()).toHaveLength(0);
    await act(async () => { hold.release(); await hold.promise; });
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    expect(s.previews().map(call => call.body)).toEqual([{ rows: [exactRow(source, 1)] }, { rows: [exactRow(source, 4)] }]);
    expect(s.applies().map(call => call.body)).toEqual([{ rows: [exactRow(source, 4)], previewHash: 'a'.repeat(64) }]);
    expect(latest.dispose).toHaveBeenCalledTimes(1); expect(s.c().activeId).toBeNull();
  });

  it('a blocked preview, a failed preview and a known apply failure stay for explicit review and release their leases', async () => {
    const third = scheduledTask(3, '2026-11-02', '2026-11-03');
    const s = setup({
      [`POST ${previewPath}`]: request => {
        const input = request.body as TaskScheduleBatchInput, id = input.rows[0]?.taskId;
        if (id === task.id) return ok({ ...schedulePreview(input, tasks), protectedTargets: [{ taskId: task.id, reason: 'archived_task' }] });
        if (id === third.id) return failure(422, 'VALIDATION_FAILED', 'Bad dates');
        return ok(schedulePreview(input, tasks));
      },
      [`POST ${applyPath}`]: () => failure(409, 'PREVIEW_STALE', 'Changed sources'),
    });
    const a = lease(), b = lease(), c3 = lease();
    act(() => { s.c().stageMove(proposal(), a, scope); s.c().stageMove(proposal(1, sourceOf(other)), b, scope); s.c().stageMove(proposal(1, sourceOf(third)), c3, scope); });
    await waitFor(() => expect(Object.values(s.c().drafts).every(draft => draft.moveState === 'failed')).toBe(true));
    const states = Object.values(s.c().drafts).map(draft => [draft.rows[0]?.taskId, draft.moveState, !!draft.error, !!draft.preview]);
    expect(states).toEqual(expect.arrayContaining([[task.id, 'failed', false, true], [other.id, 'failed', true, true], [third.id, 'failed', true, false]]));
    // Only the exact clean preview was applied, once; nothing rebased or resent.
    expect(s.applies()).toHaveLength(1);
    expect(s.applies()[0]?.body).toEqual({ rows: [exactRow(sourceOf(other), 1)], previewHash: 'a'.repeat(64) });
    expect([a, b, c3].map(item => item.dispose.mock.calls.length)).toEqual([1, 1, 1]);
    expect(s.c().activeId).toBeNull();
    // Each retained row blocks only itself; the global gate is open.
    expect(s.c().moveGate()).toBeNull();
    expect(s.c().moveGate(task.id)).toBe('draft');
    const id = Object.values(s.c().drafts).find(draft => draft.rows[0]?.taskId === task.id)?.id ?? '';
    act(() => s.c().discard(id));
    expect(s.c().moveGate(task.id)).toBeNull();
    expect(s.applies()).toHaveLength(1);
  });

  it('auto-applies an exact source-fresh move with a soft dependency date warning, without opening confirmation', async () => {
    const s = setup({ [`POST ${previewPath}`]: request => ok({ ...schedulePreview(request.body as TaskScheduleBatchInput, tasks), comparisons: [{
      dependencyId: 'd1000000-0000-4000-8000-000000000001', predecessorTaskId: other.id, successorTaskId: task.id,
      predecessorDueDate: other.dueDate, successorStartDate: '2026-10-21',
      predecessorContext: dependencyContext(other), successorContext: dependencyContext(task), state: 'conflict',
    }] }) });
    const held = lease(); act(() => { s.c().stageMove(proposal(-3), held, scope); });
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    expect(s.previews().map(call => call.body)).toEqual([{ rows: [exactRow(source, -3)] }]);
    expect(s.applies().map(call => call.body)).toEqual([{ rows: [exactRow(source, -3)], previewHash: 'a'.repeat(64) }]);
    expect(s.applies()[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(s.c().activeId).toBeNull(); expect(held.dispose).toHaveBeenCalledTimes(1);
    expect(s.c().moveGate(task.id)).toBeNull(); expect(s.c().moveGate(other.id)).toBeNull();
  });

  it.each(['recovery', 'changed-before'] as const)('never auto-applies a fresh %s preview and leaves only that task for explicit review', async reason => {
    const s = setup({ [`POST ${previewPath}`]: request => {
      const result = schedulePreview(request.body as TaskScheduleBatchInput, tasks);
      if (reason === 'recovery') result.recoveryPeriodIds = [PERIOD_A];
      if (reason === 'changed-before') {
        const row = result.rows[0]; if (!row) throw new Error('Expected preview row'); row.before.startDate = '2026-10-23';
      }
      return ok(result);
    } });
    const held = lease(); act(() => { s.c().stageMove(proposal(-3), held, scope); });
    await waitFor(() => expect(Object.values(s.c().drafts)[0]?.moveState).toBe('failed'));
    expect(s.applies()).toHaveLength(0); expect(s.previews()).toHaveLength(1); expect(held.dispose).toHaveBeenCalledTimes(1);
    expect(s.c().activeId).toBeNull(); expect(s.c().moveGate(task.id)).toBe('draft'); expect(s.c().moveGate(other.id)).toBeNull();
    const draft = Object.values(s.c().drafts)[0]; expect(draft?.rows[0]?.expectedRevision).toBe(7);
    expect(draft?.rows[0]?.baseStart).toBe('2026-10-24'); expect(draft?.rows[0]?.startDate).toBe('2026-10-21');
  });

  it('an unknown outcome keeps the command, key and lease, pauses the queue and blocks every move until Retry original', async () => {
    let sends = 0;
    const s = setup({ [`POST ${applyPath}`]: async request => { if (++sends === 1) throw new TypeError('Failed to fetch'); return applied(request); } });
    const held = lease(), queued = lease();
    act(() => { s.c().stageMove(proposal(), held, scope); s.c().stageMove(proposal(1, sourceOf(other)), queued, scope); });
    await waitFor(() => expect(s.c().mutation.uncertain).not.toBeNull());
    const draftId = s.c().mutation.uncertain?.variables.draftId ?? '';
    expect(s.c().drafts[draftId]?.moveState).toBe('unknown');
    expect(held.dispose).not.toHaveBeenCalled();
    expect(s.c().moveGate()).toBe('command'); expect(s.c().moveGate(other.id)).toBe('command');
    let staged = true;
    act(() => { staged = s.c().stageMove(proposal(5, sourceOf(scheduledTask(3, '2026-11-02', null))), lease(), scope); });
    expect(staged).toBe(false);
    // The queued row is neither previewed nor sent; discard/change of the held row is refused.
    const rows = s.c().drafts[draftId]?.rows;
    act(() => { s.c().discard(draftId); s.c().change(draftId, task.id, { startDate: '2026-12-01' }); });
    expect(s.c().drafts[draftId]?.rows).toEqual(rows);
    expect(s.previews()).toHaveLength(1);
    expect(s.applies()).toHaveLength(1);
    act(() => s.c().mutation.retryUncertain());
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    const sent = s.applies();
    expect(sent).toHaveLength(3);
    expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(sent[2]?.headers.get('Idempotency-Key')).not.toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(sent.slice(0, 2).map(call => call.body)).toEqual([0, 1].map(() => ({ rows: [exactRow(source, 2)], previewHash: 'a'.repeat(64) })));
    expect(sent[2]?.body).toEqual({ rows: [exactRow(sourceOf(other), 1)], previewHash: 'a'.repeat(64) });
    expect(held.dispose).toHaveBeenCalledTimes(1); expect(queued.dispose).toHaveBeenCalledTimes(1);
  });

  it('allows enqueueing beside its own pending move only; a manual pending command or another hook refuses', async () => {
    const hold = gate();
    const s = setup({ [`POST ${applyPath}`]: async request => { await hold.promise; return applied(request); } });
    act(() => { s.c().stageMove(proposal(), lease(), scope); });
    await waitFor(() => expect(s.c().mutation.pendingCommand).not.toBeNull());
    expect(s.c().mutation.hasOtherProtectedCommands()).toBe(false);
    expect(s.c().moveGate()).toBeNull();
    expect(s.c().moveGate(task.id)).toBe('draft');
    const refused = lease(); let sameSent = true;
    act(() => { sameSent = s.c().stageMove(proposal(4), refused, scope); });
    expect(sameSent).toBe(false); expect(refused.dispose).not.toHaveBeenCalled();
    const command = protectedCommandsFor(s.client).register();
    command.set(true);
    expect(s.c().mutation.hasOtherProtectedCommands()).toBe(true);
    expect(s.c().moveGate()).toBe('command');
    command.dispose();
    let staged = false;
    act(() => { staged = s.c().stageMove(proposal(1, sourceOf(other)), lease(), scope); });
    expect(staged).toBe(true);
    await act(async () => { hold.release(); await hold.promise; });
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    // A manual apply in flight is this hook's command too, but not a move: it refuses new drops.
    const manualHold = gate();
    const m = setup({ [`POST ${applyPath}`]: async request => { await manualHold.promise; return applied(request); } });
    const row = scheduleContext([{ ...other, revision: 7 }]).rows[0];
    if (!row) throw new Error('Expected row');
    act(() => m.c().open([other], new Map([[other.id, row]])));
    const id = m.c().activeId ?? '';
    act(() => m.c().change(id, other.id, { dueDate: '2026-10-23' }));
    await act(async () => { const draft = m.c().drafts[id]; if (draft) await m.c().preview(draft); });
    act(() => { const draft = m.c().drafts[id]; if (draft) m.c().apply(draft); });
    await waitFor(() => expect(m.c().mutation.pendingCommand).not.toBeNull());
    expect(m.c().moveGate()).toBe('command');
    await act(async () => { manualHold.release(); await manualHold.promise; });
  });

  it('refuses another scope or a no-op/shape-changing proposal without staging, previewing or adopting the lease', () => {
    const s = setup(); const held = lease();
    let staged = true;
    act(() => { staged = s.c().stageMove(proposal(), held, { ...scope, projectId: 'f0000000-0000-4000-8000-000000000999' }); });
    expect(staged).toBe(false);
    act(() => { staged = s.c().stageMove(proposal(0), held, scope); });
    expect(staged).toBe(false);
    act(() => { staged = s.c().stageMove({ ...proposal(), dueDate: '2026-10-27' }, held, scope); });
    expect(staged).toBe(false);
    expect(s.c().drafts).toEqual({});
    expect(s.previews()).toHaveLength(0);
    expect(held.dispose).not.toHaveBeenCalled();
  });

  it('discarding a queued proposal never writes it', async () => {
    const hold = gate(); let seen = 0;
    const s = setup({ [`POST ${previewPath}`]: async request => { if (++seen === 1) await hold.promise; return ok(schedulePreview(request.body as TaskScheduleBatchInput, tasks)); } });
    const a = lease(), b = lease();
    act(() => { s.c().stageMove(proposal(), a, scope); s.c().stageMove(proposal(1, sourceOf(other)), b, scope); });
    const queuedId = Object.values(s.c().drafts).find(draft => draft.rows[0]?.taskId === other.id)?.id ?? '';
    act(() => s.c().discard(queuedId));
    expect(b.dispose).toHaveBeenCalledTimes(1);
    await act(async () => { hold.release(); await hold.promise; });
    await waitFor(() => expect(s.c().drafts).toEqual({}));
    expect(s.applies().map(call => (call.body as TaskScheduleBatchInput).rows[0]?.taskId)).toEqual([task.id]);
    expect(s.previews()).toHaveLength(1);
  });

  it('scope cleanup while a preview is held releases every lease and the late answer sends zero applies', async () => {
    const hold = gate();
    const s = setup({ [`POST ${previewPath}`]: async request => { await hold.promise; return ok(schedulePreview(request.body as TaskScheduleBatchInput, tasks)); } });
    const held = lease(), queued = lease();
    act(() => { s.c().stageMove(proposal(), held, scope); s.c().stageMove(proposal(1, sourceOf(other)), queued, scope); });
    await waitFor(() => expect(s.previews()).toHaveLength(1));
    const old = s.c();
    s.view.unmount();
    expect(held.dispose).toHaveBeenCalledTimes(1); expect(queued.dispose).toHaveBeenCalledTimes(1);
    await act(async () => { hold.release(); await hold.promise; await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(s.applies()).toHaveLength(0);
    expect(s.previews()).toHaveLength(1);
    const late = lease();
    expect(old.moveGate()).toBe('scope');
    expect(old.stageMove(proposal(3), late, scope)).toBe(false);
    expect(late.dispose).not.toHaveBeenCalled();
  });
});
