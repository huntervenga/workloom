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


describe('CellPopover beside an explicit desktop nonmodal task pane', () => {
  it('keeps outside cell editors visible beside the pane, but hides them under a nested modal dialog', async () => {
    function BesidePane() {
      const [modal, setModal] = useState(false);
      return <>
        <Anchored label="Outside date and tag feedback" />
        <section role="dialog" aria-label="Task pane" data-task-panel="" data-state="open">
          <button onClick={() => setModal(true)}>Open nested modal</button>
          <DialogShell title="Nested modal" description="Modal above both pane and table" open={modal} onOpenChange={setModal}>
            <Anchored label="Modal feedback" />
          </DialogShell>
        </section>
      </>;
    }
    const ui = renderFieldUi(<BesidePane />);
    const outside = popover('Outside date and tag feedback');
    await waitFor(() => expect(outside).toBeVisible());
    await ui.user.click(screen.getByRole('button', { name: 'Open nested modal' }));
    await screen.findByRole('dialog', { name: 'Nested modal' });
    await waitFor(() => expect(outside).not.toBeVisible());
    expect(popover('Modal feedback')).toBeVisible();
    await ui.user.keyboard('{Escape}');
    await waitFor(() => expect(outside).toBeVisible());
    expect(popover('Outside date and tag feedback')).toBe(outside);
  });
});
