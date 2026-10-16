import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChoicePicker, type ChoiceOption } from './ChoicePicker';
import { DialogShell } from './DialogShell';

const people: ChoiceOption[] = [
  { value: '', label: 'Unassigned' },
  { value: 'anna', label: 'Anna Kowalska', avatarName: 'Anna Kowalska' },
  { value: 'boris', label: 'Boris Ünal', avatarName: 'Boris Ünal' },
  { value: 'gone', label: 'Member unavailable', disabled: true },
  { value: 'chen', label: 'Chen Li', avatarName: 'Chen Li', description: 'Design' },
];

function Controlled(props: { initial?: string; options?: readonly ChoiceOption[]; searchable?: boolean; onValueChange?: (value: string) => void }) {
  const [value, setValue] = useState(props.initial ?? '');
  return (
    <ChoicePicker
      label="Assignee"
      value={value}
      options={props.options ?? people}
      searchable={props.searchable}
      onValueChange={(next) => {
        setValue(next);
        props.onValueChange?.(next);
      }}
    />
  );
}

const trigger = (name = 'Assignee') => screen.getByRole('combobox', { name });
const active = () => {
  const id = (screen.queryByRole('combobox', { name: 'Search: Assignee' }) ?? trigger()).getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

describe('ChoicePicker', () => {
  it('shows the value on one line and chooses with the pointer, returning focus to the trigger', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="anna" onValueChange={changed} />);
    expect(trigger()).toHaveTextContent('Anna Kowalska');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger());
    const list = screen.getByRole('listbox', { name: 'Assignee' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', list.id);
    expect(within(list).getByRole('option', { name: 'Anna Kowalska' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('option', { name: 'Unassigned' })).toHaveAttribute('aria-selected', 'false');
    expect(within(list).getByRole('option', { name: /Chen Li/ })).toHaveTextContent('Design');

    await user.click(within(list).getByRole('option', { name: 'Unassigned' }));
    expect(changed).toHaveBeenCalledWith('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveTextContent('Unassigned');
  });

  it('navigates with arrows, Home and End, skips disabled options and never submits the form on Enter', async () => {
    const user = userEvent.setup();
    const submitted = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const changed = vi.fn();
    render(
      <form onSubmit={submitted}>
        <Controlled initial="boris" onValueChange={changed} />
      </form>,
    );
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(active()).toHaveTextContent('Boris Ünal');
    await user.keyboard('{ArrowDown}');
    // The unavailable member is shown but skipped.
    expect(active()).toHaveTextContent('Chen Li');
    expect(screen.getByRole('option', { name: 'Member unavailable' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Home}');
    expect(active()).toHaveTextContent('Unassigned');
    await user.keyboard('{End}');
    expect(active()).toHaveTextContent('Chen Li');
    await user.keyboard('{Enter}');
    expect(changed).toHaveBeenCalledWith('chen');
    expect(submitted).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // Enter on a closed trigger opens the menu instead of submitting.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('cancels with Escape and keeps the value, returning focus', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="anna" onValueChange={changed} />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveTextContent('Anna Kowalska');
  });

  it('ignores clicks on disabled options', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="anna" onValueChange={changed} />);
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: 'Member unavailable' }));
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('searches labels ignoring case and accents, and says when nothing matches', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="" searchable onValueChange={changed} />);
    await user.click(trigger());
    const search = screen.getByRole('combobox', { name: 'Search: Assignee' });
    expect(search).toHaveFocus();
    expect(search).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);

    await user.type(search, 'UNAL');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Boris Ünal' })).toBeInTheDocument();
    expect(active()).toHaveTextContent('Boris Ünal');

    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('No matches')).toBeVisible();

    await user.clear(search);
    await user.type(search, 'li{Enter}');
    expect(changed).toHaveBeenCalledWith('chen');
    expect(trigger()).toHaveFocus();
  });

  it('opens a searchable picker with the typed character and searches by default for long lists', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 9 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` }));
    render(<Controlled initial="v0" options={many} />);
    trigger().focus();
    await user.keyboard('8');
    const search = screen.getByRole('combobox', { name: 'Search: Assignee' });
    expect(search).toHaveValue('8');
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('jumps by typed letters in a short list without changing the value until chosen', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<Controlled initial="" onValueChange={changed} />);
    trigger().focus();
    await user.keyboard('c');
    expect(active()).toHaveTextContent('Chen Li');
    expect(changed).not.toHaveBeenCalled();
    // Like a native select, a quick space continues the typed prefix instead of choosing.
    await user.keyboard('{Enter}');
    expect(changed).toHaveBeenCalledWith('chen');
  });

  it('continues the tab order from the trigger when tabbing out of the search box', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    render(
      <div>
        <Controlled initial="anna" searchable onValueChange={changed} />
        <button type="button">Next control</button>
      </div>,
    );
    await user.click(trigger());
    expect(screen.getByRole('combobox', { name: 'Search: Assignee' })).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next control' })).toHaveFocus();
    expect(changed).not.toHaveBeenCalled();
  });

  it('respects a disabled fieldset, even when it becomes disabled while the menu is open', async () => {
    const user = userEvent.setup();
    const changed = vi.fn();
    function Form({ locked }: { locked: boolean }) {
      return (
        <fieldset disabled={locked}>
          <ChoicePicker label="Status" value="a" options={[{ value: 'a', label: 'To do' }, { value: 'b', label: 'Done' }]} onValueChange={changed} />
        </fieldset>
      );
    }
    const view = render(<Form locked />);
    expect(trigger('Status')).toBeDisabled();
    await user.click(trigger('Status'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    view.rerender(<Form locked={false} />);
    await user.click(trigger('Status'));
    const option = screen.getByRole('option', { name: 'Done' });
    view.rerender(<Form locked />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(option).catch(() => undefined);
    expect(changed).not.toHaveBeenCalled();
  });

  it('keeps the menu inside a modal dialog and closes only the menu on Escape', async () => {
    const user = userEvent.setup();
    const closed = vi.fn();
    render(
      <DialogShell title="Task" description="Edit the task" open onOpenChange={closed}>
        <Controlled initial="anna" searchable />
      </DialogShell>,
    );
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Assignee' }));
    expect(within(dialog).getByRole('listbox')).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Search: Assignee' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(closed).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('combobox', { name: 'Assignee' })).toHaveFocus();
    // With the menu closed, Escape belongs to the dialog again.
    await user.keyboard('{Escape}');
    expect(closed).toHaveBeenCalledWith(false);
  });

  it('closes on an outside pointer press without moving focus back', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Controlled initial="anna" />
        <input aria-label="Elsewhere" />
      </div>,
    );
    await user.click(trigger());
    await user.click(screen.getByLabelText('Elsewhere'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Elsewhere')).toHaveFocus();
  });

  it('does not take focus when options arrive later', async () => {
    const user = userEvent.setup();
    function Loading({ options }: { options: readonly ChoiceOption[] }) {
      return (
        <div>
          <input aria-label="Title" />
          <ChoicePicker label="Assignee" value="" options={options} onValueChange={() => undefined} />
        </div>
      );
    }
    const view = render(<Loading options={[{ value: '', label: 'Unassigned' }]} />);
    await user.click(screen.getByLabelText('Title'));
    act(() => view.rerender(<Loading options={people} />));
    expect(screen.getByLabelText('Title')).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // An open short menu stays without a search box even when the list grows past the threshold.
    await user.click(trigger());
    const many = [...people, ...Array.from({ length: 8 }, (_, index) => ({ value: `x${index}`, label: `Extra ${index}` }))];
    act(() => view.rerender(<Loading options={many} />));
    expect(screen.queryByRole('combobox', { name: 'Search: Assignee' })).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('shows a placeholder for a value without an option and draws decorative marks only', async () => {
    const user = userEvent.setup();
    render(
      <ChoicePicker
        label="Priority"
        value="missing"
        placeholder="Pick one"
        options={[{ value: 'high', label: 'High', color: '#d97706' }, { value: 'none', label: 'No priority' }]}
        onValueChange={() => undefined}
      />,
    );
    expect(trigger('Priority')).toHaveTextContent('Pick one');
    await user.click(trigger('Priority'));
    const high = screen.getByRole('option', { name: 'High' });
    expect(high.querySelector('[aria-hidden="true"][style]')).toHaveStyle({ backgroundColor: '#d97706' });
    expect(screen.queryAllByRole('option', { selected: true })).toEqual([]);
  });

  it('keeps menu keys and clicks away from surrounding handlers', async () => {
    const user = userEvent.setup();
    const outerKey = vi.fn();
    const outerClick = vi.fn();
    render(
      <div onKeyDown={outerKey} onClick={outerClick}>
        <Controlled initial="anna" />
      </div>,
    );
    trigger().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Escape}');
    expect(outerKey).not.toHaveBeenCalled();
    await user.click(trigger());
    outerClick.mockClear();
    await user.click(screen.getByRole('option', { name: 'Unassigned' }));
    expect(outerClick).not.toHaveBeenCalled();
  });
});
