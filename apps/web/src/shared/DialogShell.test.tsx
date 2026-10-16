import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DialogReturnFocus, DialogShell } from './DialogShell';

function MenuDialog() {
  const [menu, setMenu] = useState(true);
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const summary = useRef<HTMLElement | null>(null);
  return <details open={menu}><summary ref={summary}>Project actions</summary><DialogReturnFocus targetRef={summary}><DialogShell title="Edit project" description="Project settings" open={open} onOpenChange={setOpen} trigger={<button onClick={() => setMenu(false)}>Rename</button>}><input aria-label="Name" /><DialogShell title="Nested dialog" description="Nested settings" open={nested} onOpenChange={setNested} trigger={<button>Nested action</button>}><input aria-label="Nested name" /></DialogShell></DialogShell></DialogReturnFocus></details>;
}

describe('dialog focus from dismissed action menus', () => {
  it('returns focus to the visible summary when its original trigger is hidden', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<MenuDialog />);
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit project' });
    expect(screen.getByText('Project actions').closest('details')).not.toHaveAttribute('open');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('Project actions')).toHaveFocus();
  });
  it('keeps a nested dialog focus return inside its parent instead of using the outer menu target', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<MenuDialog />);
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const parent = await screen.findByRole('dialog', { name: 'Edit project' });
    const nestedTrigger = within(parent).getByRole('button', { name: 'Nested action' });
    await user.click(nestedTrigger);
    const nested = await screen.findByRole('dialog', { name: 'Nested dialog' });
    fireEvent.keyDown(nested, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nested dialog' })).not.toBeInTheDocument());
    expect(nestedTrigger).toHaveFocus();
    expect(screen.getByText('Project actions')).not.toHaveFocus();
  });
});
