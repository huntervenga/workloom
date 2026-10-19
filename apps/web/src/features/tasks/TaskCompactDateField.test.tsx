import { fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderFieldUi } from '../fields/test/fixtures';
import { TaskCompactDateField } from './TaskCompactDateField';

function example() {
  const committed = vi.fn();
  const submitted = vi.fn();
  const escaped = vi.fn();
  function Example() {
    const [dates, setDates] = useState({ startDate: '', dueDate: '2027-03-20' });
    return <form onSubmit={event => { event.preventDefault(); submitted(); }} onKeyDown={event => { if (event.key === 'Escape') escaped(); }}>
      <TaskCompactDateField {...dates} onCommit={next => { committed(next); setDates(next); }} />
      <button type="button">Outside</button>
    </form>;
  }
  return { ...renderFieldUi(<Example />), committed, submitted, escaped };
}

describe('compact saved-task dates', () => {
  it('uses the table range calendar and saves both endpoints once when leaving', async () => {
    const ui = example();
    expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates' }));
    const calendar = within(screen.getByRole('dialog', { name: 'Edit dates' }));
    await ui.user.click(calendar.getByRole('button', { name: 'Sunday, March 21, 2027' }));
    await ui.user.click(calendar.getByRole('button', { name: '+ Start date' }));
    await ui.user.click(calendar.getByRole('button', { name: 'Monday, March 15, 2027' }));
    expect(ui.committed).not.toHaveBeenCalled();
    await ui.user.click(screen.getByRole('button', { name: 'Outside' }));
    expect(ui.committed).toHaveBeenCalledExactlyOnceWith({ startDate: '2027-03-15', dueDate: '2027-03-21' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the date popup open through Chrome focusout before its internal destination receives focus', async () => {
    const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates' }));
    const due = screen.getByLabelText('Due date');
    fireEvent.change(due, { target: { value: '2027-04-10' } });
    const addStart = screen.getByRole('button', { name: '+ Start date' });
    // Native Chrome checkpoints microtasks after focusout, before focusin. The old
    // owner saw body here and saved/removed the popup before +Start could be clicked.
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);
    try {
      fireEvent.blur(due, { relatedTarget: addStart });
      await Promise.resolve();
      expect(ui.committed).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'Edit dates' })).toBeVisible();
    } finally {
      active.mockRestore();
    }
    await ui.user.click(addStart);
    await ui.user.type(screen.getByLabelText('Start date'), '2027-04-08');
    expect(ui.committed).not.toHaveBeenCalled();
    await ui.user.keyboard('{Enter}');
    expect(ui.committed).toHaveBeenCalledExactlyOnceWith({ startDate: '2027-04-08', dueDate: '2027-04-10' });
  });

  it('hands focus to a newly added start date before blur checks and keeps raw endpoints uncommitted', async () => {
    const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates' }));
    await ui.user.clear(screen.getByLabelText('Due date'));
    await ui.user.type(screen.getByLabelText('Due date'), '2027-04-10');
    // A backgrounded/busy browser may not deliver an animation frame before blur checks.
    // The new endpoint must own focus in the same DOM commit that removes +Start date.
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    try {
      const addStart = screen.getByRole('button', { name: '+ Start date' });
      addStart.focus();
      fireEvent.click(addStart);
      expect(screen.getByLabelText('Start date')).toHaveFocus();
      await Promise.resolve();
      expect(screen.getByRole('dialog', { name: 'Edit dates' })).toBeVisible();
      expect(ui.committed).not.toHaveBeenCalled();
      await ui.user.type(screen.getByLabelText('Start date'), '2027-04-08');
      expect(ui.committed).not.toHaveBeenCalled();
      await ui.user.keyboard('{Enter}');
      expect(ui.committed).toHaveBeenCalledExactlyOnceWith({ startDate: '2027-04-08', dueDate: '2027-04-10' });
      expect(ui.submitted).not.toHaveBeenCalled();
    } finally {
      frame.mockRestore();
    }
  });

  it('cancels raw typing on Escape and keeps the parent pane open', async () => {
    const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates' }));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-04-01' } });
    const departure = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(departure);
    expect(departure.defaultPrevented).toBe(true);
    await ui.user.keyboard('{Escape}');
    const cancelled = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cancelled);
    expect(cancelled.defaultPrevented).toBe(false);
    expect(ui.committed).not.toHaveBeenCalled();
    expect(ui.escaped).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Edit dates' })).toHaveFocus();
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates' }));
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-20');
  });

  it('commits raw date typing on Enter without submitting the task form', async () => {
    const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates' }));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-04-01' } });
    await ui.user.keyboard('{Enter}');
    expect(ui.committed).toHaveBeenCalledExactlyOnceWith({ startDate: '', dueDate: '2027-04-01' });
    expect(ui.submitted).not.toHaveBeenCalled();
  });
});
