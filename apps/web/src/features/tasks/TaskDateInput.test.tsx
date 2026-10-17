import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderFieldUi } from '../fields/test/fixtures';
import { TaskDateInput } from './TaskDateInput';

function example(startDate = '', dueDate = '2027-03-20', calendarPopover = false) {
  const changed = vi.fn();
  function Example() {
    const [dates, setDates] = useState({ startDate, dueDate });
    return <TaskDateInput {...dates} calendarPopover={calendarPopover} onChange={patch => { changed(patch); setDates(before => ({ ...before, ...patch })); }} />;
  }
  return { ...renderFieldUi(<Example />), changed };
}

describe('compact date-only calendar', () => {
  it('keeps a form calendar open while a nonfocusable month heading is held through blur and timer', async () => {
    const ui = example('', '2027-03-20', true);
    await ui.user.click(screen.getByLabelText('Due date'));
    const heading = screen.getByText('March 2027');
    await ui.user.pointer({ keys: '[MouseLeft>]', target: heading });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.getByRole('region', { name: 'Choose a date' })).toBeInTheDocument();
    await ui.user.pointer({ keys: '[/MouseLeft]' });
    expect(ui.changed).not.toHaveBeenCalled();
  });

  it('lets a bulk editor explicitly clear initially mixed endpoints without defaulting them into a mutation', async () => {
    const changed = vi.fn();
    const ui = renderFieldUi(<TaskDateInput startDate="" dueDate="" allowEmptyClear onChange={changed} />);
    expect(changed).not.toHaveBeenCalled();
    await ui.user.click(screen.getByRole('button', { name: 'Clear due date' }));
    expect(changed).toHaveBeenLastCalledWith({ dueDate: '' });
    await ui.user.click(screen.getByRole('button', { name: '+ Start date' }));
    await ui.user.click(screen.getByRole('button', { name: 'Clear start date' }));
    expect(changed).toHaveBeenLastCalledWith({ startDate: '' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps a form calendar open through a held pointer and closes on Escape without reopening on restored focus', async () => {
    const ui = example('', '2027-03-20', true);
    expect(screen.queryByRole('region', { name: 'Choose a date' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByLabelText('Due date'));
    const day = screen.getByRole('button', { name: 'Sunday, March 21, 2027' });
    await ui.user.pointer({ keys: '[MouseLeft>]', target: day });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(day).toBeInTheDocument();
    expect(ui.changed).not.toHaveBeenCalled();
    await ui.user.pointer({ keys: '[/MouseLeft]' });
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-21');
    day.focus();
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Choose a date' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Due date')).toHaveFocus();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('region', { name: 'Choose a date' })).not.toBeInTheDocument();
    expect(ui.changed).toHaveBeenCalledExactlyOnceWith({ dueDate: '2027-03-21' });
  });

  it('chooses the active endpoint and clears it without clearing the other endpoint', async () => {
    const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Sunday, March 21, 2027' }));
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-21');
    await ui.user.click(screen.getByRole('button', { name: '+ Start date' }));
    await waitFor(() => expect(screen.getByLabelText('Start date')).toHaveFocus());
    await ui.user.click(screen.getByRole('button', { name: 'Monday, March 15, 2027' }));
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-03-15');
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-21');
    await ui.user.click(screen.getByRole('button', { name: 'Clear start date' }));
    expect(ui.changed).toHaveBeenLastCalledWith({ startDate: '' });
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-21');
  });

  it('moves keyboard focus across a month boundary and commits only on an explicit choice', async () => {
    const ui = example('', '2027-03-31');
    const last = screen.getByRole('button', { name: 'Wednesday, March 31, 2027' });
    last.focus();
    await ui.user.keyboard('{ArrowRight}');
    const next = await screen.findByRole('button', { name: 'Thursday, April 1, 2027' });
    await waitFor(() => expect(next).toHaveFocus());
    expect(ui.changed).not.toHaveBeenCalled();
    await ui.user.keyboard('{Enter}');
    expect(ui.changed).toHaveBeenLastCalledWith({ dueDate: '2027-04-01' });
  });

  it('bounds navigation at both supported calendar years and keeps dates canonical', async () => {
    const first = example('', '0001-01-01');
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled();
    expect(screen.getByLabelText('Due date')).toHaveValue('0001-01-01');
    first.unmount();
    example('', '9999-12-31');
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled();
    expect(screen.getByLabelText('Due date')).toHaveValue('9999-12-31');
  });

  it('locks every local edit during an unresolved command and labels validation errors', () => {
    const changed = vi.fn();
    renderFieldUi(<TaskDateInput startDate="2027-03-21" dueDate="2027-03-20" disabled onChange={changed} errors={{ dueDate: 'Range needs review' }} />);
    expect(screen.getByLabelText('Due date')).toBeDisabled();
    expect(screen.getByLabelText('Start date')).toBeDisabled();
    expect(screen.getByLabelText('Due date')).toHaveAccessibleDescription('Range needs review');
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(changed).not.toHaveBeenCalled();
  });
});
