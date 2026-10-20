import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BooleanFieldControl } from './BooleanFieldControl';

describe('BooleanFieldControl native semantics', () => {
  it('restores indeterminate after a rejected toggle and a render with unchanged null', async () => {
    const change = vi.fn();
    const props = { value: null, label: 'Approved', fieldName: 'Approved', onChange: change };
    const { rerender } = render(<BooleanFieldControl {...props}/>);
    const input = screen.getByRole('checkbox', { name: 'Approved' });
    expect(input).toBePartiallyChecked();
    await userEvent.click(input);
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
    rerender(<BooleanFieldControl {...props}/>);
    expect(input).toBePartiallyChecked();
    expect(input).not.toBeChecked();
  });

  it('releases a clean focus session when leaving the control and lets page Escape propagate', async () => {
    const cancel = vi.fn(), escape = vi.fn();
    const ui = userEvent.setup();
    render(<div onKeyDown={event => { if (event.key === 'Escape') escape(); }}><BooleanFieldControl value={true} label="Approved" fieldName="Approved" onChange={vi.fn()} onCancel={cancel}/><button>Next cell</button></div>);
    const input = screen.getByRole('checkbox'); input.focus();
    await ui.tab(); // Clear is in the same control; keep the captured selection.
    expect(cancel).not.toHaveBeenCalled();
    await ui.tab();
    expect(cancel).toHaveBeenCalledTimes(1);
    input.focus(); await ui.keyboard('{Escape}');
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(escape).toHaveBeenCalledTimes(1);
  });

  it('links error text and clears explicit false separately from unchecked', async () => {
    const change = vi.fn();
    render(<><p id="error">Field is locked</p><BooleanFieldControl value={false} label="Approved" fieldName="Approved" onChange={change} invalid describedBy="error"/></>);
    const input = screen.getByRole('checkbox');
    expect(input).not.toBeChecked(); expect(input).not.toBePartiallyChecked();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Field is locked');
    await userEvent.click(screen.getByRole('button', { name: 'Clear: Approved' }));
    expect(change).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('does not submit enclosing forms when Enter is pressed', () => {
    const submit = vi.fn(), change = vi.fn();
    render(<form onSubmit={submit}><BooleanFieldControl value={false} label="Approved" fieldName="Approved" onChange={change}/></form>);
    fireEvent.keyDown(screen.getByRole('checkbox'), { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  });
});
