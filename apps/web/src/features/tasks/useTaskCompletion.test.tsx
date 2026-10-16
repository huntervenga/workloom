import type { TaskStatusDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { lostResponse, rootPath, task } from '../planning/test/fixtures';
import { draftFromTask } from './taskDraft';
import { useTaskCommands, type EditSession } from './useTaskCommands';
import { TaskCompletionFeedback } from './TaskCompletionFeedback';
import { useTaskCompletion } from './useTaskCompletion';
const doneId = 'f6000000-0000-4000-8000-000000000002';
const other = { ...task, id: 'f2000000-0000-4000-8000-000000000002' };
const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: task.projectId, group: 'todo', name: 'Stored active', position: 0, revision: 1 }, { id: doneId, workspaceId: alpha.id, projectId: task.projectId, group: 'done', name: 'Stored done', position: 1, revision: 1 }];
const context = { tasks: [task, other], statuses, writable: true, editingTaskId: null };
function hook() {
  const client = createQueryClient({ retry: false }); const saved = vi.fn();
  return { saved, ...renderHook(({ value }) => { const commands = useTaskCommands(anna.id, alpha.id); return { commands, completion: useTaskCompletion(commands, value, saved) }; }, { initialProps: { value: context }, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }) };
}
describe('page-owned completion command identity', () => {
  it('keeps an independent rich draft and refuses a same-tick second completion before staging another draft', async () => {
    const gate = deferred<Response>(); const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise });
    const h = hook(); const kept: EditSession = { base: other, draft: { ...draftFromTask(other), description: 'Independent unsent description' } };
    h.result.current.commands.editSessions.current.set(other.id, kept);
    act(() => { h.result.current.completion.choose(task, doneId); h.result.current.completion.choose(other, doneId); });
    await waitFor(() => expect(calls).toHaveLength(1)); expect(h.result.current.commands.editSessions.current.get(other.id)).toBe(kept);
    await act(async () => gate.resolve(ok({ ...task, statusId: doneId, revision: 2 })));
    await waitFor(() => expect(h.result.current.completion.attempt).toBeNull());
    expect(h.result.current.commands.editSessions.current.get(other.id)).toBe(kept); expect(h.saved).toHaveBeenCalledTimes(1);
  });
  it('reconciles a confirmation through the original drawer and prevents an old Retry from replaying a later foreign command', async () => {
    const first = lostResponse(); const foreign = lostResponse(); let attempt = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : ok({ ...task, statusId: doneId, revision: 2 }), [`PATCH ${rootPath}/tasks/${other.id}`]: () => foreign.promise });
    const h = hook(); act(() => h.result.current.completion.choose(task, doneId)); await waitFor(() => expect(attempt).toBe(1));
    await act(async () => first.lose()); await waitFor(() => expect(h.result.current.completion.uncertain).toBe(true));
    const oldRetry = h.result.current.completion.retry; const submitted = h.result.current.completion.attempt;
    if (!submitted) throw new Error('Missing completion session');
    act(() => h.result.current.commands.update.retryUncertain({ onSuccess: result => { h.result.current.commands.confirmSession(submitted.session, result); } }));
    await waitFor(() => expect(h.result.current.completion.attempt).toBeNull());
    act(() => h.result.current.commands.update.mutate({ taskId: other.id, input: { expectedRevision: 1, statusId: doneId } }));
    await waitFor(() => expect(calls).toHaveLength(3)); await act(async () => foreign.lose());
    await waitFor(() => expect(h.result.current.commands.update.uncertain?.variables.taskId).toBe(other.id));
    const held = h.result.current.commands.update.uncertain; const error = h.result.current.commands.update.error;
    act(() => oldRetry());
    expect(calls).toHaveLength(3); expect(h.result.current.commands.update.uncertain).toBe(held); expect(h.result.current.commands.update.error).toBe(error);
    expect(h.result.current.commands.editSessions.current.has(task.id)).toBe(false);
  });
  it('does not reset or replace a foreign pending or unknown command', async () => {
    const gate = lostResponse(); const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${other.id}`]: () => gate.promise });
    const h = hook(); act(() => h.result.current.commands.update.mutate({ taskId: other.id, input: { expectedRevision: 1, statusId: doneId } }));
    await waitFor(() => expect(calls).toHaveLength(1)); act(() => h.result.current.completion.choose(task, doneId));
    expect(h.result.current.commands.editSessions.current.has(task.id)).toBe(false);
    await act(async () => gate.lose()); await waitFor(() => expect(h.result.current.commands.update.uncertain).not.toBeNull());
    const held = h.result.current.commands.update.uncertain; const error = h.result.current.commands.update.error;
    act(() => h.result.current.completion.choose(task, doneId));
    expect(calls).toHaveLength(1); expect(h.result.current.commands.update.uncertain).toBe(held); expect(h.result.current.commands.update.error).toBe(error);
  });
  it('rechecks current permission, task revision and catalog before a retained choice handler can send', () => {
    const { calls } = installFakeApi({}); const h = hook(); const retained = h.result.current.completion.choose;
    h.rerender({ value: { ...context, writable: false } }); act(() => retained(task, doneId)); expect(calls).toHaveLength(0);
    h.rerender({ value: { ...context, tasks: [{ ...task, revision: 2 }, other] } }); act(() => retained(task, doneId));
    expect(h.result.current.completion.reviewTaskId).toBe(task.id); expect(calls).toHaveLength(0);
    h.rerender({ value: { ...context, statuses: statuses.filter(status => status.id !== doneId) } }); act(() => retained(task, doneId));
    expect(calls).toHaveLength(0); expect(h.result.current.commands.editSessions.current.size).toBe(0);
  });
  it('blocks original retry after current edit permission is lost without forgetting the held command', async () => {
    const gate = lostResponse(); const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise });
    const h = hook(); act(() => h.result.current.completion.choose(task, doneId)); await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => gate.lose()); await waitFor(() => expect(h.result.current.completion.canRetry).toBe(true));
    const retry = h.result.current.completion.retry; h.rerender({ value: { ...context, writable: false } }); act(() => retry());
    expect(h.result.current.completion.canRetry).toBe(false); expect(h.result.current.commands.update.uncertain).not.toBeNull(); expect(calls).toHaveLength(1);
  });
});

it('clears a stale-choice notice on explicit Review without discarding a retained draft or touching commands', async () => {
  const { calls } = installFakeApi({}); const client = createQueryClient({ retry: false }); const review = vi.fn();
  let state: { commands: ReturnType<typeof useTaskCommands>; completion: ReturnType<typeof useTaskCompletion> } | undefined;
  function Page() { const commands = useTaskCommands(anna.id, alpha.id); const completion = useTaskCompletion(commands, context, () => undefined); state = { commands, completion }; return <TaskCompletionFeedback controller={completion} onReview={review} />; }
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  const current = () => { if (!state) throw new Error('Missing page controller'); return state; };
  const kept: EditSession = { base: other, draft: { ...draftFromTask(other), description: 'Independent draft' } };
  current().commands.editSessions.current.set(other.id, kept);
  act(() => current().completion.choose({ ...task, revision: 0 }, doneId));
  expect(screen.getByText('The task or status changed. Review the current task before changing its status.')).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Review original task' }));
  expect(review).toHaveBeenCalledWith(task.id); expect(current().completion.reviewTaskId).toBeNull();
  expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(current().commands.editSessions.current.get(other.id)).toBe(kept); expect(calls).toHaveLength(0);
});

it('refuses retained action callbacks after the owning page is unmounted', () => {
  const { calls } = installFakeApi({}); const h = hook(); const choose = h.result.current.completion.choose; const retry = h.result.current.completion.retry;
  h.unmount(); act(() => { choose(task, doneId); retry(); }); expect(calls).toHaveLength(0);
});
