import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { CellPopover } from './CellPopover';

const LABEL = 'Note for the new task';

/** A cell editor panel that is itself a dialog, optionally inside a drawer that holds the cell. */
function Harness({ inDrawer = false }: { inDrawer?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const cell = (
    <div data-testid="frame">
      <div ref={setAnchor}>
        <CellPopover anchor={anchor} id="panel" role="dialog" ariaLabel={LABEL}>
          <button type="button">Inside</button>
        </CellPopover>
      </div>
    </div>
  );
  return inDrawer ? (
    <div role="dialog" aria-label="Drawer">
      {cell}
    </div>
  ) : (
    cell
  );
}

function panel(): HTMLElement {
  const node = document.getElementById('panel');
  if (!node) throw new Error('panel is not mounted');
  return node;
}

/** Mutation observer callbacks run as microtasks, so the DOM change settles inside `act`. */
async function mutate(change: () => void) {
  await act(async () => {
    change();
  });
}

function laterDialog(): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-label', 'Later');
  return dialog;
}

describe('CellPopover as a dialog', () => {
  it('does not count itself as a covering dialog and never takes focus', () => {
    const before = document.activeElement;
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: LABEL });
    expect(dialog).toBe(panel());
    expect(dialog.hidden).toBe(false);
    expect(document.activeElement).toBe(before);
  });

  it('stays shown inside the drawer that holds its cell', () => {
    render(<Harness inDrawer />);
    expect(screen.getByRole('dialog', { name: LABEL }).hidden).toBe(false);
  });

  it('hides while a later dialog covers it and returns with the same content', async () => {
    render(<Harness inDrawer />);
    const inside = screen.getByRole('button', { name: 'Inside' });
    const later = laterDialog();

    await mutate(() => document.body.append(later));
    expect(panel().hidden).toBe(true);
    expect(panel().contains(inside)).toBe(true);

    await mutate(() => later.remove());
    expect(panel().hidden).toBe(false);
    expect(screen.getByRole('button', { name: 'Inside' })).toBe(inside);
  });

  it('hides while its cell is under an inert or hidden ancestor', async () => {
    render(<Harness />);
    const frame = screen.getByTestId('frame');

    await mutate(() => frame.setAttribute('inert', ''));
    expect(panel().hidden).toBe(true);
    await mutate(() => frame.removeAttribute('inert'));
    expect(panel().hidden).toBe(false);

    await mutate(() => {
      frame.hidden = true;
    });
    expect(panel().hidden).toBe(true);
    await mutate(() => {
      frame.hidden = false;
    });
    expect(panel().hidden).toBe(false);
  });
});
