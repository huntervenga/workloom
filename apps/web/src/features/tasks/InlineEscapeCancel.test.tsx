import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { lostResponse, rootPath, task } from '../planning/test/fixtures';
import { InlineTaskEdit } from './InlineTaskEdit';
import { draftFromTask } from './taskDraft';
import type { TaskInlineField } from './tableEditing';
import { useTaskCommands, type EditSession, type TaskCommands } from './useTaskCommands';

function setup(field: TaskInlineField, seed?: EditSession) {
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(() => {
      if (seed) commands.editSessions.current.set(task.id, seed);
      return true;
    });
    return <>{open ? <InlineTaskEdit task={task} field={field} statuses={[]} members={alphaMembers} commands={commands} writable
      onClose={() => setOpen(false)} onMoreDetails={() => undefined} onSaved={() => undefined} /> : null}
      <button onClick={() => setOpen(true)}>Reopen editor</button></>;
  }
  return { ...renderFieldUi(<Example />), commands: () => {
    if (!current) throw new Error('Task command owner missing.');
    return current;
  } };
}

describe('Escape cancels only an unsent inline field', () => {
  it.each([
    { field: 'title' as const, label: 'Task name', value: 'Canceled local title' },
    { field: 'estimate' as const, label: 'Team estimate (hours)', value: '0.001' },
  ])('clears the unsent $field buffer so it cannot block a later selection', async ({ field, label, value }) => {
    const { calls } = installFakeApi({});
    const ui = setup(field);
    fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
    expect(ui.commands().editSessions.current.has(task.id)).toBe(true);
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: label })).not.toBeInTheDocument();
    expect(ui.commands().editSessions.current.has(task.id)).toBe(false);
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Reopen editor' }));
    expect(screen.getByRole('textbox', { name: label })).not.toHaveValue(value);
  });

  it('retains the exact already-sent command when Escape closes a pending view', async () => {
    const first = lostResponse();
    const { calls } = installFakeApi({ [`PATCH ${rootPath}/tasks/${task.id}`]: () => first.promise });
    const ui = setup('title');
    fireEvent.change(screen.getByRole('textbox', { name: 'Task name' }), { target: { value: 'Submitted title' } });
    await ui.user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(calls).toHaveLength(1));
    const original = ui.commands().update.pendingCommand?.variables;
    expect(original?.input).toEqual({ expectedRevision: task.revision, title: 'Submitted title' });
    await ui.user.keyboard('{Escape}');
    expect(ui.commands().editSessions.current.has(task.id)).toBe(true);
    await act(async () => first.lose());
    expect(ui.commands().update.uncertain?.variables).toBe(original);
    expect(calls).toHaveLength(1);
  });

  it('does not discard another full-form draft through a foreign cell', async () => {
    const { calls } = installFakeApi({});
    const seed = { base: task, draft: { ...draftFromTask(task), description: 'Retained rich text' } };
    const ui = setup('title', seed);
    await ui.user.keyboard('{Escape}');
    expect(ui.commands().editSessions.current.get(task.id)).toBe(seed);
    expect(calls).toHaveLength(0);
  });
});
