import type { TaskStatusDto } from '@workloom/contracts';
import { act, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, anna, created, deferred, installFakeApi, ok } from '../../test/fakeApi';
import { heldResponse, renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { QuickTaskAdd } from './QuickTaskAdd';
import { useTaskCommands, type TaskCommands } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const statuses: TaskStatusDto[] = [{ id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 }];
const OTHER_COMMAND = 'Another task command is still pending or unconfirmed. Resume its original editor first.';

function setup() {
  const onClosed = vi.fn(); const onCreated = vi.fn();
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(true);
    return <>{open ? <QuickTaskAdd projectId={PROJECT_ID} sectionId={SECTION} sectionName="Stored section" statuses={statuses} commands={commands} writable onClose={reason => { onClosed(reason); setOpen(false); }} onMoreDetails={vi.fn()} onCreated={onCreated} /> : null}<button>Outside focus</button></>;
  }
  const ui = renderFieldUi(<Example />);
  const commands = () => { if (!current) throw new Error('No command harness'); return current; };
  // The existing task's title save that the next quick row waits behind.
  const rename = () => act(() => { commands().update.mutate({ taskId: task.id, input: { expectedRevision: task.revision, title: 'Held rename' } }); });
  return { ...ui, onClosed, onCreated, commands, rename };
}

describe('quick row behind an existing task save', () => {
  it('keeps the next title quiet and editable while an ordinary task save is sent, then sends the queued title once', async () => {
    const gate = deferred<Response>();
    const { calls } = installFakeApi({
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => gate.promise,
      [`POST ${rootPath}/tasks`]: request => created({ ...task, id: 'f2000000-0000-4000-8000-000000000201', sectionId: SECTION, title: (request.body as { title: string }).title }),
    });
    const ui = setup();
    await ui.rename();
    await waitFor(() => expect(ui.commands().update.pendingCommand).not.toBeNull());
    const input = screen.getByLabelText('Task name');
    expect(input).not.toHaveAttribute('readonly');
    expect(document.querySelector('[data-cell-popover]')).toBeNull();
    expect(screen.queryByText(OTHER_COMMAND)).not.toBeInTheDocument();
    await ui.user.type(input, 'Queued behind rename{Enter}');
    expect(input).toHaveValue(''); expect(input).toHaveFocus();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    expect(document.querySelector('[data-cell-popover]')).toBeNull();
    // Details stay guarded while a task command is unresolved.
    expect(screen.getByRole('button', { name: 'More details' })).toBeDisabled();
    // The waiting title keeps the untouched row open when focus leaves.
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(ui.onClosed).not.toHaveBeenCalled();
    await act(async () => gate.resolve(ok({ ...task, title: 'Held rename', revision: task.revision + 1 })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    const posts = calls.filter(call => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, title: 'Queued behind rename', statusId: task.statusId });
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  });

  it('shows honest recovery for an unknown task save and sends the queued title only after its exact retry is confirmed', async () => {
    const first = heldResponse(); let attempt = 0;
    const { calls } = installFakeApi({
      [`PATCH ${rootPath}/tasks/${task.id}`]: () => ++attempt === 1 ? first.promise : ok({ ...task, title: 'Held rename', revision: task.revision + 1 }),
      [`POST ${rootPath}/tasks`]: request => created({ ...task, id: 'f2000000-0000-4000-8000-000000000202', sectionId: SECTION, title: (request.body as { title: string }).title }),
    });
    const ui = setup();
    await ui.rename();
    await ui.user.type(screen.getByLabelText('Task name'), 'Waits for unknown{Enter}');
    await act(async () => first.lose());
    expect(await screen.findByText(OTHER_COMMAND)).toBeInTheDocument();
    expect(screen.getByText(OTHER_COMMAND).closest('[data-cell-popover]')).not.toBeNull();
    expect(screen.getByLabelText('Task name')).not.toHaveAttribute('readonly');
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
    act(() => ui.commands().update.retryUncertain());
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    const patches = calls.filter(call => call.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1]?.body).toEqual(patches[0]?.body);
    expect(patches[1]?.headers.get('Idempotency-Key')).toBe(patches[0]?.headers.get('Idempotency-Key'));
    expect(calls.filter(call => call.method === 'POST').map(call => (call.body as { title: string }).title)).toEqual(['Waits for unknown']);
    await waitFor(() => expect(screen.queryByText(OTHER_COMMAND)).not.toBeInTheDocument());
  });
});
