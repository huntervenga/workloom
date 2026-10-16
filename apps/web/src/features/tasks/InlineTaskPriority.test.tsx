import type { TaskDto } from '@workloom/contracts';
import { taskPrioritySchema } from '@workloom/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { lostResponse, rootPath, task } from '../planning/test/fixtures';
import { InlineTaskEdit } from './InlineTaskEdit';
import { draftFromTask } from './taskDraft';
import { useTaskCommands, type EditSession, type TaskCommands } from './useTaskCommands';

function editor(source: TaskDto = task, seed?: EditSession, writable = true) {
  const onSaved = vi.fn(), onMoreDetails = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id); current = commands;
    const [open, setOpen] = useState(() => { if (seed) commands.editSessions.current.set(source.id, seed); return true; });
    return <>{open ? <InlineTaskEdit task={source} field="priority" statuses={[]} members={alphaMembers} commands={commands} writable={writable} onClose={() => setOpen(false)} onMoreDetails={onMoreDetails} onSaved={onSaved} /> : null}<button onClick={() => setOpen(true)}>Resume Priority editor</button><button>Outside Priority focus</button></>;
  }
  return { ...renderFieldUi(<Example />), onSaved, onMoreDetails, commands: () => { if (!current) throw Error('Expected Priority harness'); return current; } };
}

describe('native inline Priority editor', () => {
  it.each(taskPrioritySchema.options)('selects %s without writing then saves only priority and expectedRevision', async priority => {
    const base = { ...task, revision: 7, priority: priority === 'none' ? 'medium' as const : 'none' as const };
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${base.id}`]: () => gate.promise });
    const ui = editor(base);
    const select = screen.getByRole('combobox', { name: 'Priority' });
    expect(select.tagName).toBe('SELECT'); expect(select).toHaveFocus();
    expect(within(select).getAllByRole('option').map(option => (option as HTMLOptionElement).value)).toEqual(taskPrioritySchema.options);
    await ui.user.selectOptions(select, priority); expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1)); expect(calls[0]?.body).toEqual({ expectedRevision: 7, priority });
    expect(select).toBeDisabled(); expect(ui.onSaved).not.toHaveBeenCalled();
    await act(async () => gate.resolve(ok({ ...base, priority, revision: 8 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
  });

  it('closes an unchanged Priority without a command and keeps a selected draft through Escape', async () => {
    const { calls } = installFakeApi({}); const ui = editor();
    await ui.user.click(screen.getByRole('button', { name: 'Save' })); expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Resume Priority editor' }));
    await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'high'); await ui.user.keyboard('{Escape}');
    await ui.user.click(screen.getByRole('button', { name: 'Resume Priority editor' })); expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('high'); expect(calls).toHaveLength(0);
  });

  it('keeps the exact lost-ACK values and key while collapsed, then retries without stealing external focus', async () => {
    const first = lostResponse(), retry = deferred<Response>(); let attempt = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : retry.promise });
    const ui = editor();
    await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'urgent'); await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(attempt).toBe(1)); await act(async () => first.lose());
    await ui.user.click(screen.getByRole('button', { name: 'Collapse editor' })); await ui.user.click(screen.getByRole('button', { name: 'Resume Priority editor' }));
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('urgent'); expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(attempt).toBe(2));
    expect(calls[1]?.body).toEqual(calls[0]?.body); expect(calls[1]?.body).toEqual({ expectedRevision: task.revision, priority: 'urgent' });
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key')); expect(calls[0]?.headers.get('Idempotency-Key')).toBeTruthy();
    await ui.user.click(screen.getByRole('button', { name: 'Outside Priority focus' }));
    await act(async () => retry.resolve(ok({ ...task, priority: 'urgent', revision: task.revision + 1 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1)); expect(screen.getByRole('button', { name: 'Outside Priority focus' })).toHaveFocus();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
  });

  it('does not submit a retained rich drawer draft through the Priority cell', async () => {
    const { calls } = installFakeApi({});
    const seed = { base: task, draft: { ...draftFromTask(task), priority: 'high' as const } };
    const ui = editor(task, seed); expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' })); expect(ui.onMoreDetails).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(0);
  });

  it.each(['viewer', 'meeting', 'archived', 'unknown-type'] as const)('does not offer a fresh native editor for %s', kind => {
    const { calls } = installFakeApi({});
    const source = kind === 'meeting' ? { ...task, meetingId: task.id } : kind === 'archived' ? { ...task, archivedAt: task.createdAt } : kind === 'unknown-type' ? { ...task, meetingId: undefined } : task;
    editor(source, undefined, kind !== 'viewer'); expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument(); expect(calls).toHaveLength(0);
  });

  it('shows a fixed conflict error while retaining the chosen Priority and refusing a fresh resubmit', async () => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'REVISION_CONFLICT', 'Untrusted server details') });
    const ui = editor(); await ui.user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'low'); await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible()); expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveValue('low'); expect(screen.queryByText('Untrusted server details')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Save' })); expect(calls).toHaveLength(1);
  });
});
