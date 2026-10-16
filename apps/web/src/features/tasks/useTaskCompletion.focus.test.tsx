import type { TaskDto, TaskStatusDto } from '@workloom/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { rootPath, task } from '../planning/test/fixtures';
import { draftFromTask } from './taskDraft';
import { useTaskCommands } from './useTaskCommands';
import { useTaskCompletion } from './useTaskCompletion';

const doneId = 'f6000000-0000-4000-8000-000000000002';
const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: task.projectId, group: 'todo', name: 'Active', position: 0, revision: 1 }, { id: doneId, workspaceId: alpha.id, projectId: task.projectId, group: 'done', name: 'Done', position: 1, revision: 1 }];
const next: TaskDto = { ...task, statusId: doneId, revision: task.revision + 1 };
const context = { tasks: [task], statuses, writable: true, editingTaskId: null as string | null, focusScope: 'original presentation' };
function hook() {
  render(<div><button>Source</button><button>Target</button><button>Outside</button></div>);
  const source = screen.getByRole('button', { name: 'Source' }) as HTMLButtonElement;
  const target = screen.getByRole('button', { name: 'Target' }) as HTMLButtonElement;
  const gate = deferred<Response>(); const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise });
  const client = createQueryClient({ retry: false });
  const h = renderHook(({ value }) => { const commands = useTaskCommands(anna.id, alpha.id); return { commands, completion: useTaskCompletion(commands, value, () => undefined) }; }, { initialProps: { value: context }, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  return { ...h, source, target, gate, calls, start: async () => { source.focus(); act(() => h.result.current.completion.choose(task, doneId, source)); await waitFor(() => expect(calls).toHaveLength(1)); }, confirm: async () => { await act(async () => gate.resolve(ok(next))); await waitFor(() => expect(h.result.current.completion.attempt).toBeNull()); } };
}

describe('explicit completion focus lease handshake', () => {
  it('waits for the receipt when the new target is ready first, and an old registration cannot remove the replacement', async () => {
    const h = hook(); const unregisterOld = h.result.current.completion.targetReady(task, h.source);
    await h.start(); h.source.remove(); h.rerender({ value: { ...context, tasks: [next] } });
    act(() => { h.result.current.completion.targetReady(next, h.target); unregisterOld(); });
    expect(h.target).not.toHaveFocus(); await h.confirm(); expect(h.target).toHaveFocus();
  });
  it('waits for matching rendered head and target when the receipt arrives first', async () => {
    const h = hook(); await h.start(); await h.confirm(); expect(h.target).not.toHaveFocus();
    h.source.remove(); h.rerender({ value: { ...context, tasks: [next] } });
    act(() => { h.result.current.completion.targetReady(next, h.target); }); expect(h.target).toHaveFocus();
    screen.getByRole('button', { name: 'Outside' }).focus();
    act(() => { h.result.current.completion.targetReady(next, h.target); }); expect(h.target).not.toHaveFocus();
  });
  it.each(['presentation', 'permission', 'editing', 'replacement session'] as const)('permanently revokes a lease on %s change before an old receipt arrives', async kind => {
    const h = hook(); await h.start();
    if (kind === 'replacement session') act(() => { h.result.current.commands.editSessions.current.set(task.id, { base: task, draft: { ...draftFromTask(task), title: 'Independent replacement draft' } }); });
    h.rerender({ value: { ...context, ...(kind === 'presentation' ? { focusScope: 'another actor, workspace, project, view, grouping or raw filter' } : kind === 'permission' ? { writable: false } : kind === 'editing' ? { editingTaskId: task.id } : {}) } });
    h.rerender({ value: context }); h.source.remove(); await h.confirm();
    h.rerender({ value: { ...context, tasks: [next] } }); act(() => { h.result.current.completion.targetReady(next, h.target); });
    expect(h.target).not.toHaveFocus();
    if (kind === 'replacement session') expect(h.result.current.commands.editSessions.current.get(task.id)?.draft.title).toBe('Independent replacement draft');
  });
  it.each(['missing row', 'newer head', 'ineligible head'] as const)('does not focus a later target after confirmation encounters a %s', async kind => {
    const h = hook(); await h.start(); h.source.remove();
    h.rerender({ value: { ...context, tasks: kind === 'missing row' ? [] : kind === 'newer head' ? [{ ...next, revision: next.revision + 1 }] : [{ ...next, archivedAt: task.createdAt }] } });
    await h.confirm(); h.rerender({ value: { ...context, tasks: [next] } });
    act(() => { h.result.current.completion.targetReady(next, h.target); }); expect(h.target).not.toHaveFocus();
  });
  it('clears the lease and ignores detached targets after owner unmount', async () => {
    const h = hook(); await h.start(); const ready = h.result.current.completion.targetReady;
    h.unmount(); h.source.remove(); await act(async () => h.gate.resolve(ok(next)));
    act(() => { ready(next, h.target); }); expect(h.target).not.toHaveFocus();
  });
});
