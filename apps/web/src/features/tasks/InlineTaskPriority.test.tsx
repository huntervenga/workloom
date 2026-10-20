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

const labels = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' } as const;

function editor(source: TaskDto = task, seed?: EditSession, writable = true) {
  const onSaved = vi.fn(), onMoreDetails = vi.fn(), onClosed = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id); current = commands;
    const [open, setOpen] = useState(() => { if (seed) commands.editSessions.current.set(source.id, seed); return true; });
    return <>{open ? <InlineTaskEdit task={source} field="priority" statuses={[]} members={alphaMembers} commands={commands} writable={writable} onClose={reason => { onClosed(reason); setOpen(false); }} onMoreDetails={onMoreDetails} onSaved={onSaved} /> : null}<button onClick={() => setOpen(true)}>Resume Priority editor</button><button onClick={() => setOpen(false)}>Hide Priority editor</button><button>Outside Priority focus</button></>;
  }
  return { ...renderFieldUi(<Example />), onSaved, onMoreDetails, onClosed, commands: () => { if (!current) throw Error('Expected Priority harness'); return current; } };
}
const list = () => screen.getByRole('listbox', { name: 'Priority' });

describe('custom inline Priority editor', () => {
  it.each(taskPrioritySchema.options)('opens the custom list at once and saves %s as the explicit choice with only priority and expectedRevision', async priority => {
    const base = { ...task, revision: 7, priority: priority === 'none' ? 'medium' as const : 'none' as const };
    const gate = deferred<Response>();
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${base.id}`]: () => gate.promise });
    const ui = editor(base);
    const trigger = screen.getByRole('combobox', { name: 'Priority' });
    expect(trigger.tagName).toBe('BUTTON'); expect(document.querySelector('select')).toBeNull();
    expect(trigger).toHaveFocus(); expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(list()).getAllByRole('option').map(option => option.textContent)).toEqual(taskPrioritySchema.options.map(option => labels[option]));
    expect(within(list()).getByRole('option', { name: labels[base.priority] })).toHaveAttribute('aria-selected', 'true');
    expect(calls).toHaveLength(0);
    await ui.user.click(within(list()).getByRole('option', { name: labels[priority] }));
    await waitFor(() => expect(calls).toHaveLength(1)); expect(calls[0]?.body).toEqual({ expectedRevision: 7, priority });
    expect(trigger).toBeDisabled(); expect(ui.onSaved).not.toHaveBeenCalled();
    await act(async () => gate.resolve(ok({ ...base, priority, revision: 8 })));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
  });

  it('commits a keyboard choice with arrows and Enter, and Escape on a reopened list writes nothing', async () => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: request => ok({ ...task, ...(request.body as object), revision: task.revision + 1 }) });
    const ui = editor();
    await ui.user.keyboard('{ArrowDown}{ArrowDown}{Escape}');
    expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('cancel'); expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Resume Priority editor' }));
    await ui.user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1); expect(calls[0]?.body).toEqual({ expectedRevision: task.revision, priority: 'medium' });
  });

  it('keeps the exact lost-ACK values and key while hidden, then retries without stealing external focus', async () => {
    const first = lostResponse(), retry = deferred<Response>(); let attempt = 0;
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : retry.promise });
    const ui = editor();
    await ui.user.click(within(list()).getByRole('option', { name: 'Urgent' }));
    await waitFor(() => expect(attempt).toBe(1)); await act(async () => first.lose());
    await ui.user.click(await screen.findByRole('button', { name: 'Collapse editor' })); await ui.user.click(screen.getByRole('button', { name: 'Resume Priority editor' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveTextContent('Urgent'); expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
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
    const ui = editor(task, seed); expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument(); expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Resume draft' })); expect(ui.onMoreDetails).toHaveBeenCalledTimes(1); expect(calls).toHaveLength(0);
  });

  it.each(['viewer', 'meeting', 'archived', 'unknown-type'] as const)('does not offer a fresh picker for %s', kind => {
    const { calls } = installFakeApi({});
    const source = kind === 'meeting' ? { ...task, meetingId: task.id } : kind === 'archived' ? { ...task, archivedAt: task.createdAt } : kind === 'unknown-type' ? { ...task, meetingId: undefined } : task;
    editor(source, undefined, kind !== 'viewer'); expect(screen.queryByRole('combobox', { name: 'Priority' })).not.toBeInTheDocument(); expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); expect(calls).toHaveLength(0);
  });

  it('shows a fixed conflict error while retaining the chosen Priority and refusing a fresh resubmit', async () => {
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => failure(409, 'REVISION_CONFLICT', 'Untrusted server details') });
    const ui = editor(); await ui.user.click(within(list()).getByRole('option', { name: 'Low' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible()); expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveTextContent('Low'); expect(screen.queryByText('Untrusted server details')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
    await ui.user.click(screen.getByRole('combobox', { name: 'Priority' })); expect(screen.queryByRole('listbox')).not.toBeInTheDocument(); expect(calls).toHaveLength(1);
  });
});

it('disables an already-open selected Priority picker during a list refresh and resumes its guarded port afterward', async () => {
  const submit = vi.fn(() => 'sent' as const), retry = vi.fn();
  let refresh: (busy: boolean) => void = () => { throw new Error('Missing editor readiness harness'); };
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    const [busy, setBusy] = useState(false); refresh = setBusy;
    return <InlineTaskEdit task={task} field="priority" statuses={[]} members={alphaMembers} commands={commands} writable onClose={() => undefined} onMoreDetails={() => undefined} onSaved={() => undefined}
      bulkEdit={{ count: 2, busy, pending: false, uncertain: false, error: null, notice: null, unsupported: false, submit, retry }} />;
  }
  const ui = renderFieldUi(<Example />);
  expect(list()).toBeInTheDocument();
  await act(async () => refresh(true));
  expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  await ui.user.click(screen.getByRole('combobox', { name: 'Priority' }));
  expect(submit).not.toHaveBeenCalled(); expect(retry).not.toHaveBeenCalled();
  await act(async () => refresh(false));
  expect(screen.getByRole('combobox', { name: 'Priority' })).toBeEnabled();
  await ui.user.click(screen.getByRole('combobox', { name: 'Priority' }));
  await ui.user.click(within(list()).getByRole('option', { name: 'High' }));
  expect(submit).toHaveBeenCalledExactlyOnceWith({ priority: 'high' }, expect.any(Object));
});
