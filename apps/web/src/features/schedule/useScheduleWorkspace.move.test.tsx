import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { TaskScheduleBatchInput } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { moveDateRange, type DateMoveProposal, type DateMoveSource } from './dateGesture';
import { PROJECT_ID, scheduleContext, scheduledTask, schedulePath, schedulePreview } from './test/fixtures';
import { useScheduleWorkspace, type ScheduleWorkspace } from './useScheduleWorkspace';

// Production controller and real QueryClient; fetch is the only seam and leases are spies.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const previewPath = `${schedulePath}/schedule-preview`, applyPath = `${schedulePath}/schedule-apply`;
const task = scheduledTask(1, '2026-10-24', null);
const source: DateMoveSource = Object.freeze({ taskId: task.id, title: task.title, expectedRevision: 7, startDate: '2026-10-24', dueDate: null });
function proposal(delta = 2): DateMoveProposal { const value = moveDateRange(source, delta); if (!value) throw new Error('Expected proposal'); return value; }
const lease = () => ({ dispose: vi.fn() });
const scope = { actorId: anna.id, workspaceId: alpha.id, projectId: PROJECT_ID };

function setup(routes: RouteTable = {}) {
  const { calls } = installFakeApi({ [`POST ${previewPath}`]: request => ok(schedulePreview(request.body as TaskScheduleBatchInput, [task])), ...routes });
  const client = createQueryClient({ retry: false }); clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = renderHook(() => useScheduleWorkspace(anna.id, alpha.id, PROJECT_ID, alpha.timezone), { wrapper });
  const c = (): ScheduleWorkspace => view.result.current;
  const previews = () => calls.filter(call => call.path === previewPath);
  return { calls, client, view, c, previews };
}

describe('atomic move staging', () => {
  it('creates exactly one move draft from the immutable source and previews that exact input', async () => {
    const s = setup(); const held = lease();
    let staged = false;
    act(() => { staged = s.c().stageMove(proposal(), held, scope); });
    expect(staged).toBe(true);
    const drafts = Object.values(s.c().drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ origin: 'move', rows: [{ taskId: task.id, title: task.title, expectedRevision: 7, startDate: '2026-10-26', dueDate: '', baseStart: '2026-10-24', baseDue: '', editable: true }] });
    expect(s.c().activeId).toBe(drafts[0]?.id);
    await waitFor(() => expect(s.c().active?.preview).not.toBeNull());
    expect(s.previews().map(call => call.body)).toEqual([{ rows: [{ taskId: task.id, expectedRevision: 7, startDate: '2026-10-26', dueDate: null }] }]);
    expect(s.calls.filter(call => call.method !== 'GET' && call.path !== previewPath)).toHaveLength(0);
    // Closing the dialog keeps the page-owned lease; only explicit discard releases it, once.
    act(() => s.c().setActiveId(null));
    expect(held.dispose).not.toHaveBeenCalled();
    expect(s.c().moveGate()).toBe('draft');
    const id = drafts[0]?.id ?? '';
    act(() => { s.c().discard(id); s.c().discard(id); });
    expect(held.dispose).toHaveBeenCalledTimes(1);
    expect(s.c().drafts).toEqual({});
    expect(s.c().moveGate()).toBeNull();
  });

  it('refuses beside any retained draft, even one opened in the same tick, without opening, changing or previewing it', () => {
    const s = setup(); const row = scheduleContext([{ ...task, revision: 7 }]).rows[0];
    if (!row) throw new Error('Expected row');
    const first = lease(); let staged = true;
    act(() => { s.c().open([task], new Map([[task.id, row]])); staged = s.c().stageMove(proposal(), first, scope); });
    expect(staged).toBe(false);
    const drafts = Object.values(s.c().drafts);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.origin).toBeUndefined();
    expect(drafts[0]?.rows[0]).toMatchObject({ startDate: '2026-10-24', dueDate: '' });
    const active = s.c().activeId;
    const second = lease();
    act(() => { staged = s.c().stageMove(proposal(3), second, scope); });
    expect(staged).toBe(false);
    expect(s.c().activeId).toBe(active);
    expect(s.c().drafts).toEqual({ [drafts[0]?.id ?? '']: drafts[0] });
    expect(s.previews()).toHaveLength(0);
    // A refused lease stays with the gesture, which disposes it.
    expect(first.dispose).not.toHaveBeenCalled(); expect(second.dispose).not.toHaveBeenCalled();
  });

  it('refuses any pending/unknown command of the client, another scope or a no-op proposal', () => {
    const s = setup(); const held = lease();
    const command = protectedCommandsFor(s.client).register();
    command.set(true);
    expect(s.c().moveGate()).toBe('command');
    let staged = true;
    act(() => { staged = s.c().stageMove(proposal(), held, scope); });
    expect(staged).toBe(false);
    command.dispose();
    expect(s.c().moveGate()).toBeNull();
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

  it('keeps the lease, exact draft and command through an unknown outcome and releases it only after confirmed success', async () => {
    let sends = 0;
    const s = setup({ [`POST ${applyPath}`]: async () => {
      sends++;
      if (sends === 1) throw new TypeError('Failed to fetch');
      return ok({ projectId: PROJECT_ID, tasks: [{ ...task, startDate: '2026-10-26', revision: 8 }], asOfChangeSeq: '2' });
    } });
    const held = lease();
    act(() => { s.c().stageMove(proposal(), held, scope); });
    await waitFor(() => expect(s.c().active?.preview).not.toBeNull());
    const draft = s.c().active;
    if (!draft) throw new Error('Expected draft');
    act(() => s.c().apply(draft));
    await waitFor(() => expect(s.c().mutation.uncertain?.variables.draftId).toBe(draft.id));
    expect(held.dispose).not.toHaveBeenCalled();
    expect(s.c().moveGate()).toBe('command');
    act(() => { s.c().discard(draft.id); s.c().change(draft.id, task.id, { startDate: '2026-12-01' }); });
    expect(s.c().drafts[draft.id]?.rows).toEqual(draft.rows);
    expect(held.dispose).not.toHaveBeenCalled();
    let staged = true;
    act(() => { staged = s.c().stageMove(proposal(5), lease(), scope); });
    expect(staged).toBe(false);
    act(() => s.c().mutation.retryUncertain());
    await waitFor(() => expect(s.c().drafts[draft.id]).toBeUndefined());
    expect(held.dispose).toHaveBeenCalledTimes(1);
    const sent = s.calls.filter(call => call.path === applyPath);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.headers.get('Idempotency-Key')).toBe(sent[0]?.headers.get('Idempotency-Key'));
    expect(sent.map(call => call.body)).toEqual([0, 1].map(() => ({ rows: [{ taskId: task.id, expectedRevision: 7, startDate: '2026-10-26', dueDate: null }], previewHash: 'a'.repeat(64) })));
  });

  it('releases every adopted lease on controller cleanup and refuses a late drop afterwards', () => {
    const s = setup(); const held = lease();
    act(() => { s.c().stageMove(proposal(), held, scope); });
    const old = s.c();
    s.view.unmount();
    expect(held.dispose).toHaveBeenCalledTimes(1);
    const late = lease();
    expect(old.moveGate()).toBe('scope');
    expect(old.stageMove(proposal(3), late, scope)).toBe(false);
    expect(late.dispose).not.toHaveBeenCalled();
  });
});
