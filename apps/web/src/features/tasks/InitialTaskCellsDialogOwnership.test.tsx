import type { TaskFieldDefinitionDto } from '@workloom/contracts';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DialogShell } from '../../shared/DialogShell';
import { emptyInitialTaskCellsDraft, InitialCustomFieldCell } from './InitialTaskCells';

const field = (type: 'text' | 'single_select'): TaskFieldDefinitionDto => ({
  id: '00000000-0000-4000-8000-000000000010',
  workspaceId: '00000000-0000-4000-8000-000000000001',
  projectId: '00000000-0000-4000-8000-000000000002',
  definitionVersionId: '00000000-0000-4000-8000-000000000003',
  name: 'Draft column', type, revision: 1, historyEnabled: true, locked: false,
  archivedAt: null, options: type === 'single_select' ? [{ id: '00000000-0000-4000-8000-000000000099', name: 'Chosen option', color: '#6366f1', position: 0, revision: 1, archivedAt: null }] : [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

function Harness({ type }: { type: 'text' | 'single_select' }) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState(emptyInitialTaskCellsDraft);
  return <DialogShell variant="drawer" title="Parent task" description="Synthetic task drawer" open={open} onOpenChange={setOpen}>
    <InitialCustomFieldCell field={field(type)} draft={draft} onChange={setDraft} members={[]} />
  </DialogShell>;
}

describe('initial custom cell Escape ownership inside the real task drawer shell', () => {
  it('closes the text cell editor before the enclosing drawer', async () => {
    const user = userEvent.setup();
    render(<Harness type="text" />);
    const trigger = await screen.findByRole('button', { name: 'Draft column for the new task' });
    await user.click(trigger);
    const editor = await screen.findByRole('dialog', { name: 'Draft column for the new task' });
    await user.type(within(editor).getByRole('textbox', { name: 'Draft column' }), 'Kept local value');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Parent task' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Draft column for the new task' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(within(await screen.findByRole('dialog', { name: 'Draft column for the new task' })).getByRole('textbox', { name: 'Draft column' })).toHaveValue('Kept local value');
    await user.keyboard('{Escape}{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Parent task' })).not.toBeInTheDocument());
  });

  it('closes a nested choice, then the editor, then the enclosing drawer on separate Escapes', async () => {
    const user = userEvent.setup();
    render(<Harness type="single_select" />);
    const trigger = await screen.findByRole('button', { name: 'Draft column for the new task' });
    await user.click(trigger);
    const editor = await screen.findByRole('dialog', { name: 'Draft column for the new task' });
    await user.click(within(editor).getByRole('combobox', { name: 'Draft column' }));
    await screen.findByRole('listbox', { name: 'Draft column' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Draft column' })).not.toBeInTheDocument();
    expect(editor).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent task' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Draft column for the new task' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent task' })).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Parent task' })).not.toBeInTheDocument());
  });
});
