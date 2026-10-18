import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogShell } from './DialogShell';
import { TaskPanelFrame } from './TaskPanelFrame';
import { TaskDateInput } from '../features/tasks/TaskDateInput';

type PaneVariant = 'task-drawer' | 'drawer' | 'center';
type MediaListener = (event: MediaQueryListEvent) => void;

const toPx = (value: string, unit: string) => Number(value) * (unit === 'px' ? 1 : 16);

/** Width queries only; anything else (reduced motion, hover) reports no match. */
function matchesWidth(query: string, width: number): boolean {
  const min = /min-width:\s*([\d.]+)(px|r?em)/.exec(query);
  const max = /max-width:\s*([\d.]+)(px|r?em)/.exec(query);
  if (!min && !max) return false;
  const [, minValue = '0', minUnit = 'px'] = min ?? [];
  const [, maxValue = '0', maxUnit = 'px'] = max ?? [];
  return (!min || width >= toPx(minValue, minUnit)) && (!max || width <= toPx(maxValue, maxUnit));
}

/** A fixed viewport for the whole test; `vi.unstubAllGlobals` restores the originals. */
function stubViewport(width: number) {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const listeners = new Set<MediaListener>();
    const list = {
      media: query,
      matches: matchesWidth(query, width),
      onchange: null as MediaListener | null,
      addEventListener: (type: string, listener: MediaListener) => {
        if (type === 'change') listeners.add(listener);
      },
      removeEventListener: (type: string, listener: MediaListener) => {
        if (type === 'change') listeners.delete(listener);
      },
      addListener: (listener: MediaListener) => listeners.add(listener),
      removeListener: (listener: MediaListener) => listeners.delete(listener),
      dispatchEvent: (event: Event) => {
        for (const listener of listeners) listener(event as MediaQueryListEvent);
        list.onchange?.(event as MediaQueryListEvent);
        return true;
      },
    };
    return list as unknown as MediaQueryList;
  });
}

/** A task list beside the pane: Escape in the list clears its selection, like the project table. */
function TaskWorkspace({ variant = 'task-drawer', initiallyOpen = true }: { variant?: PaneVariant; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [selected, setSelected] = useState<string | null>('Alpha');
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <section aria-label="Task list" onKeyDown={(event) => { if (event.key === 'Escape') setSelected(null); }}>
        <input aria-label="Search tasks" />
        {['Alpha', 'Beta'].map((name) => (
          <button key={name} type="button" aria-pressed={selected === name} onClick={() => setSelected(name)}>Select {name}</button>
        ))}
        <p role="status">Selected: {selected ?? 'none'}</p>
        <button type="button" onClick={() => setOpen(true)}>Open task</button>
        <button type="button" onClick={() => setOpen(false)}>Dismiss task</button>
      </section>
      <DialogShell title="Task details" description="Edit the selected task" variant={variant} open={open} onOpenChange={setOpen}>
        <input aria-label="Task name" />
        <input
          role="combobox"
          aria-label="Assignee"
          aria-expanded={assigneeOpen}
          aria-controls={assigneeOpen ? 'assignee-options' : undefined}
          onClick={() => setAssigneeOpen(true)}
          onKeyDown={(event) => {
            // Pickers claim Escape first; the pane must leave a handled Escape alone.
            if (event.key === 'Escape' && assigneeOpen) {
              event.preventDefault();
              setAssigneeOpen(false);
            }
          }}
        />
        {assigneeOpen ? <ul id="assignee-options" role="listbox" aria-label="Assignees"><li role="option" aria-selected="false">Ada Lovelace</li></ul> : null}
        <DialogShell title="Delete task" description="This cannot be undone" open={confirming} onOpenChange={setConfirming} trigger={<button type="button">Delete task</button>}>
          <input aria-label="Confirm task name" />
        </DialogShell>
      </DialogShell>
    </>
  );
}

/** Modal semantics: focus moves inside, the rest of the page leaves the accessibility tree, Escape closes and returns focus. */
async function expectModalPane(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Open task' }));
  const pane = await screen.findByRole('dialog', { name: 'Task details' });
  expect(pane).toContainElement(document.activeElement as HTMLElement);
  expect(screen.queryByRole('textbox', { name: 'Search tasks' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Search tasks', hidden: true }).closest('[aria-hidden="true"]')).not.toBeNull();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Open task' })).toHaveFocus();
}

const consoleErrors: unknown[][] = [];

beforeEach(() => {
  consoleErrors.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(consoleErrors).toEqual([]);
});

describe('task pane on desktop widths', () => {
  it.each([1440, 1920])('stays open beside the page at %ipx while outside controls remain usable', async (width) => {
    stubViewport(width);
    const user = userEvent.setup();
    render(<TaskWorkspace />);
    const pane = await screen.findByRole('dialog', { name: 'Task details' });
    expect(pane).toHaveAttribute('data-task-panel');
    expect(pane).toHaveAttribute('data-state', 'open');
    expect(pane).not.toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.pointerEvents).not.toBe('none');
    expect(screen.getByRole('region', { name: 'Task list' }).closest('[aria-hidden="true"], [inert]')).toBeNull();
    // No backdrop or other open layer outside the pane itself.
    expect(Array.from(document.querySelectorAll('[data-state="open"]')).filter((element) => !pane.contains(element))).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Select Beta' }));
    expect(screen.getByRole('status')).toHaveTextContent('Selected: Beta');
    const search = screen.getByRole('textbox', { name: 'Search tasks' });
    await user.type(search, 'design');
    expect(search).toHaveValue('design');
    expect(search).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument();
  });

  it('leaves Escape pressed outside the pane to the page without closing the pane', async () => {
    stubViewport(1440);
    const user = userEvent.setup();
    render(<TaskWorkspace />);
    await screen.findByRole('dialog', { name: 'Task details' });
    const search = screen.getByRole('textbox', { name: 'Search tasks' });
    await user.click(search);
    expect(screen.getByRole('status')).toHaveTextContent('Selected: Alpha');

    await user.keyboard('{Escape}');
    expect(screen.getByRole('status')).toHaveTextContent('Selected: none');
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument();
    expect(search).toHaveFocus();
  });

  it('closes on Escape inside the pane and returns focus to the control that opened it', async () => {
    stubViewport(1440);
    const user = userEvent.setup();
    render(<TaskWorkspace initiallyOpen={false} />);
    await user.click(screen.getByRole('button', { name: 'Open task' }));
    const pane = await screen.findByRole('dialog', { name: 'Task details' });
    await user.click(within(pane).getByRole('textbox', { name: 'Task name' }));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Open task' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Selected: Alpha');
  });

  it('does not pull focus back when the pane closes while the user is working outside it', async () => {
    stubViewport(1440);
    const user = userEvent.setup();
    render(<TaskWorkspace initiallyOpen={false} />);
    await user.click(screen.getByRole('button', { name: 'Open task' }));
    const pane = await screen.findByRole('dialog', { name: 'Task details' });
    await user.click(within(pane).getByRole('textbox', { name: 'Task name' }));
    await user.click(screen.getByRole('textbox', { name: 'Search tasks' }));
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument();

    const dismiss = screen.getByRole('button', { name: 'Dismiss task' });
    await user.click(dismiss);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dismiss).toHaveFocus();
  });

  it('lets an inner picker consume Escape before the pane closes', async () => {
    stubViewport(1440);
    const user = userEvent.setup();
    render(<TaskWorkspace />);
    const pane = await screen.findByRole('dialog', { name: 'Task details' });
    const assignee = within(pane).getByRole('combobox', { name: 'Assignee' });
    await user.click(assignee);
    expect(within(pane).getByRole('listbox', { name: 'Assignees' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(within(pane).queryByRole('listbox', { name: 'Assignees' })).not.toBeInTheDocument();
    expect(assignee).toHaveAttribute('aria-expanded', 'false');
    expect(assignee).toHaveFocus();
    expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes only a nested modal on Escape and restores focus inside the pane', async () => {
    stubViewport(1440);
    const user = userEvent.setup();
    render(<TaskWorkspace />);
    const pane = await screen.findByRole('dialog', { name: 'Task details' });
    const deleteTrigger = within(pane).getByRole('button', { name: 'Delete task' });
    await user.click(deleteTrigger);
    const nested = await screen.findByRole('dialog', { name: 'Delete task' });
    await user.click(within(nested).getByRole('textbox', { name: 'Confirm task name' }));

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete task' })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Task details' })).toBeInTheDocument());
    expect(deleteTrigger).toHaveFocus();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('task pane below the desktop threshold and other variants', () => {
  it.each([390, 1024])('keeps the task drawer modal at %ipx', async (width) => {
    stubViewport(width);
    const user = userEvent.setup();
    render(<TaskWorkspace initiallyOpen={false} />);
    await expectModalPane(user);
  });

  it.each(['drawer', 'center'] as const)('keeps the existing %s variant modal on desktop widths', async (variant) => {
    stubViewport(1440);
    const user = userEvent.setup();
    render(<TaskWorkspace variant={variant} initiallyOpen={false} />);
    await expectModalPane(user);
  });
});


describe('task pane exit presentation', () => {
  function animatedPane() {
    const computed = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = computed(element, pseudo);
      if (!element.hasAttribute('data-task-panel')) return style;
      return new Proxy(style, { get(target, property) {
        return property === 'animationName' ? `task-panel-${element.getAttribute('data-state')}` : Reflect.get(target, property);
      } });
    });
  }
  it('retains the last open title and content, disables it during exit, then removes it at animation end', () => {
    animatedPane();
    const change = vi.fn();
    const { rerender } = render(<TaskPanelFrame title="Saved task" description="Saved details" open onOpenChange={change} zIndex={50}><input aria-label="Retained title" defaultValue="Unsent name" /></TaskPanelFrame>);
    const pane = screen.getByRole('dialog', { name: 'Saved task' });
    rerender(<TaskPanelFrame title="New task" description="Create details" open={false} onOpenChange={change} zIndex={50}>{null}</TaskPanelFrame>);
    expect(pane).toHaveAttribute('data-state', 'closed');
    expect(pane).toHaveAttribute('inert');
    expect(pane).toHaveAttribute('aria-hidden', 'true');
    expect(within(pane).getByText('Saved task')).toBeInTheDocument();
    expect(within(pane).getByText('Saved details')).toBeInTheDocument();
    expect(within(pane).getByLabelText('Retained title')).toHaveValue('Unsent name');
    expect(within(pane).queryByText('New task')).not.toBeInTheDocument();
    fireEvent.animationEnd(pane);
    expect(pane).not.toBeInTheDocument();
  });
  it('keeps a newly reopened task mounted when the previous exit animation completes', () => {
    animatedPane();
    const change = vi.fn();
    const { rerender } = render(<TaskPanelFrame title="First task" description="First" open onOpenChange={change} zIndex={50}><input aria-label="Retained title" defaultValue="First" /></TaskPanelFrame>);
    const oldPane = screen.getByRole('dialog', { name: 'First task' });
    rerender(<TaskPanelFrame title="New task" description="Create" open={false} onOpenChange={change} zIndex={50}>{null}</TaskPanelFrame>);
    rerender(<TaskPanelFrame title="Second task" description="Second" open onOpenChange={change} zIndex={50}><input key="second" aria-label="Retained title" defaultValue="Second" /></TaskPanelFrame>);
    fireEvent.animationEnd(oldPane);
    const reopened = screen.getByRole('dialog', { name: 'Second task' });
    expect(reopened).toHaveAttribute('data-state', 'open');
    expect(reopened).not.toHaveAttribute('inert');
    expect(reopened).not.toHaveAttribute('aria-hidden');
    expect(within(reopened).getByLabelText('Retained title')).toHaveValue('Second');
  });
});


describe('real calendar Escape inside the mobile task drawer', () => {
  it.each(['date input', 'calendar day'])('closes only the calendar on first Escape from %s, then the drawer on second Escape', async target => {
    stubViewport(390);
    const changed = vi.fn();
    function Example() {
      const [open, setOpen] = useState(true);
      const [dates, setDates] = useState({ startDate: '', dueDate: '2027-03-20' });
      return <DialogShell variant="task-drawer" title="Saved calendar task" description="Task dates" open={open} onOpenChange={setOpen}>
        <TaskDateInput {...dates} calendarPopover onChange={patch => { changed(patch); setDates(before => ({ ...before, ...patch })); }} />
      </DialogShell>;
    }
    const user = userEvent.setup();
    render(<Example />);
    const pane = screen.getByRole('dialog', { name: 'Saved calendar task' });
    const due = within(pane).getByLabelText('Due date');
    await user.click(due);
    expect(screen.getByRole('region', { name: 'Choose a date' })).toBeInTheDocument();
    if (target === 'calendar day') within(pane).getByRole('button', { name: 'Saturday, March 20, 2027' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Choose a date' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Saved calendar task' })).toBeInTheDocument();
    expect(due).toHaveFocus();
    expect(due).toHaveValue('2027-03-20');
    expect(changed).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(changed).not.toHaveBeenCalled();
  });
});
