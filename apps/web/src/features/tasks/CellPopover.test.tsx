import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { DialogShell } from '../../shared/DialogShell';
import { renderFieldUi } from '../fields/test/fixtures';
import { CellPopover } from './CellPopover';

function Anchored({ label }: { label: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return <div ref={setAnchor}><CellPopover anchor={anchor}><p>{label}</p><button type="button">{`${label} action`}</button></CellPopover></div>;
}

function Example() {
  const [open, setOpen] = useState(false);
  return <>
    <Anchored label="Background feedback" />
    <button type="button" onClick={() => setOpen(true)}>Open QA dialog</button>
    <DialogShell title="QA dialog" description="Dialog above the table" open={open} onOpenChange={setOpen}>
      <Anchored label="Dialog feedback" />
    </DialogShell>
  </>;
}

const popover = (label: string) => {
  const node = screen.getByText(label).closest<HTMLElement>('[data-cell-popover]');
  if (!node) throw new Error(`Expected popover for ${label}`);
  return node;
};

describe('CellPopover and dialogs', () => {
  it('hides background cell feedback under a later dialog, keeps feedback inside that dialog and restores it unchanged on close', async () => {
    const ui = renderFieldUi(<Example />);
    const background = popover('Background feedback');
    expect(background).toBeVisible();
    await ui.user.click(screen.getByRole('button', { name: 'Open QA dialog' }));
    const dialog = await screen.findByRole('dialog', { name: 'QA dialog' });
    await waitFor(() => expect(background).not.toBeVisible());
    // Hidden, not unmounted: the same node and action come back after the dialog.
    expect(background).toBeInTheDocument();
    expect(background).toHaveAttribute('hidden');
    const own = popover('Dialog feedback');
    expect(dialog.contains(own)).toBe(true);
    expect(own).toBeVisible();
    await ui.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(popover('Background feedback')).toBeVisible());
    expect(popover('Background feedback')).toBe(background);
    expect(screen.getByRole('button', { name: 'Background feedback action' })).toBeInTheDocument();
  });
});
