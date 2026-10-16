import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DialogShell } from '../../shared/DialogShell';
import { ProjectActions } from './ProjectActions';

function Example() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [viewOpen, setViewOpen] = useState(false);
  return <>
    <ProjectActions><DialogShell title="QA columns" description="QA draft" trigger={<button>Columns</button>} open={dialogOpen} onOpenChange={setDialogOpen}><input aria-label="QA column draft" value={draft} onChange={event => setDraft(event.target.value)} /></DialogShell></ProjectActions>
    <button onClick={() => setViewOpen(before => !before)}>View columns</button>
    {viewOpen ? <p>View controls available</p> : null}
  </>;
}

describe('Project actions disclosure', () => {
  it('closes for a modal action, returns focus to its visible summary and leaves View usable after the modal closes', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const summary = screen.getByLabelText('Project actions', { selector: 'summary' });
    const details = summary.closest('details');
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    expect(details).not.toHaveAttribute('open');
    await user.type(screen.getByLabelText('QA column draft'), 'Kept column draft');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(summary).toHaveFocus();
    expect(details).not.toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'View columns' }));
    expect(screen.getByText('View controls available')).toBeVisible();
    await user.click(summary);
    await user.click(screen.getByRole('button', { name: 'Columns' }));
    expect(screen.getByLabelText('QA column draft')).toHaveValue('Kept column draft');
  });

  it('closes on outside pointer without taking focus, and closes on Escape with summary focus', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const summary = screen.getByLabelText('Project actions', { selector: 'summary' });
    const details = summary.closest('details');
    await user.click(summary);
    await user.click(screen.getByRole('button', { name: 'View columns' }));
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'View columns' })).toHaveFocus();
    await user.click(summary);
    await user.keyboard('{Escape}');
    expect(details).not.toHaveAttribute('open');
    expect(summary).toHaveFocus();
  });
});
