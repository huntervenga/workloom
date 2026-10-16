import type { TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, task } from '../planning/test/fixtures';
import { InlineTaskEdit, type InlineCloseReason } from './InlineTaskEdit';
import type { TaskInlineField } from './tableEditing';
import { useTaskCommands } from './useTaskCommands';

const statuses: TaskStatusDto[] = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
  { id: 'f6000000-0000-4000-8000-000000000002', workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
];

function inline(field: TaskInlineField) {
  const onClosed = vi.fn<(reason?: InlineCloseReason) => void>();
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    const [open, setOpen] = useState(true);
    return <>
      {open ? <InlineTaskEdit task={task} field={field} statuses={statuses} members={alphaMembers} commands={commands} writable onClose={reason => { onClosed(reason); setOpen(false); }} onMoreDetails={vi.fn()} onSaved={vi.fn()} /> : null}
      <p>Plain page text</p>
      <button type="button">Elsewhere button</button>
    </>;
  }
  return { ...renderFieldUi(<Example />), onClosed };
}

/** Lets the explicit open settle, as a real press always comes in a later task. */
const settled = () => act(async () => { await Promise.resolve(); });

describe('inline choice dismissal', () => {
  it.each(['statusId', 'priority', 'responsibleMembershipId'] as const)('treats an outside press on plain page content as leaving %s, never as a keyboard cancel', async field => {
    const { calls } = installFakeApi({});
    const ui = inline(field);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await settled();
    // Native order: the list closes during pointerdown, while focus is still on its trigger.
    fireEvent.pointerDown(screen.getByText('Plain page text'));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
    expect(calls).toHaveLength(0);
  });

  it.each(['Plain page text', 'Elsewhere button'])('classifies a native-order press on %s before focus moves', async name => {
    installFakeApi({});
    const ui = inline('statusId');
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(trigger).toHaveFocus();
    await settled();
    fireEvent.pointerDown(screen.getByText(name));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
  });

  it('treats a full outside click on another control as leaving the editor', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('statusId');
    await ui.user.click(screen.getByRole('button', { name: 'Elsewhere button' }));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
    expect(calls).toHaveLength(0);
  });

  it.each(['statusId', 'responsibleMembershipId'] as const)('keeps keyboard Escape on %s as a cancel that returns to the cell', async field => {
    const { calls } = installFakeApi({});
    const ui = inline(field);
    expect(within(screen.getByRole('listbox')).getAllByRole('option').length).toBeGreaterThan(0);
    await ui.user.keyboard('{ArrowDown}{Escape}');
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('cancel'));
    expect(calls).toHaveLength(0);
  });

  it('never counts a press on its own trigger as an outside press', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('priority');
    // The toggle is inside the editor and returns focus to the trigger, so it closes like Escape.
    await ui.user.click(screen.getByRole('combobox', { name: 'Priority' }));
    expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('cancel');
    expect(calls).toHaveLength(0);
  });
});
