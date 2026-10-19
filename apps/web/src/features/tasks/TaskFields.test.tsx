import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { makeMember, makeSection, statuses } from '../task-table/taskTableFixtures';
import { TaskFields, type TaskFieldsProps } from './TaskFields';
import { buildCreateInput, emptyDraft, type TaskDraft, type TaskDraftErrors } from './taskDraft';
import { submitTaskFormShortcut } from './TaskDrawer';

const assignee = makeMember({ id: 'member-a', userId: 'user-a', displayName: 'Stored participant' });
const section = makeSection({ id: 'section-a', name: 'Stored section' });
const initial = { ...emptyDraft('status-todo', section.id), title: 'Stored task', priority: 'high' as const, estimate: '2:00' };
function show(props: Partial<TaskFieldsProps> = {}) {
  function Example() {
    const [draft, setDraft] = useState<TaskDraft>(initial);
    return <TaskFields showLegacyEstimate draft={draft} onChange={patch => setDraft(before => ({ ...before, ...patch }))} errors={{}} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} {...props} />;
  }
  return render(<Example />);
}

describe('everyday task fields', () => {
  it('keeps everyday fields visible, preserves optional values while collapsed, and shows the team budget meaning', async () => {
    const user = userEvent.setup();
    show();
    expect(screen.getByLabelText('Task name')).toBeVisible();
    expect(screen.getByLabelText('Status')).toBeVisible();
    expect(screen.getByLabelText('Assignee')).toBeVisible();
    expect(screen.getByLabelText('Due date')).toBeVisible();
    expect(screen.getByLabelText('Description')).toBeVisible();
    const details = screen.getByText('More details').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Team estimate, hours')).toHaveValue('2:00');
    expect(screen.getByLabelText('Team estimate, hours')).not.toBeVisible();
    await user.click(screen.getByText('More details'));
    expect(screen.getByLabelText('Team estimate, hours')).toBeVisible();
    expect(screen.getByText(/Weekly personal plans and actual hours are recorded separately/)).toBeVisible();
    await user.click(screen.getByRole('combobox', { name: 'Priority' }));
    await user.click(screen.getByRole('option', { name: 'Urgent' }));
    await user.click(screen.getByText('More details'));
    await user.click(screen.getByText('More details'));
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveTextContent('Urgent');
    expect(screen.getByRole('combobox', { name: 'Section' })).toHaveTextContent('Stored section');
  });

  it('uses selected chips and search in ordinary creation instead of rendering a 100-person checkbox roster', async () => {
    const user = userEvent.setup();
    const members = Array.from({ length: 100 }, (_, index) => makeMember({ id: `person-${index}`, userId: `user-${index}`, displayName: `Create teammate ${index}` }));
    show({ showLegacyEstimate: false, members });
    await user.click(screen.getByText('More details'));
    expect(screen.queryByLabelText('Team estimate, hours')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Create teammate 99')).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Add participant' }));
    await user.type(screen.getByRole('combobox', { name: 'Search: Add participant' }), 'teammate 99');
    await user.click(screen.getByRole('option', { name: 'Create teammate 99' }));
    expect(screen.getByText('Create teammate 99')).toBeVisible();
    await user.click(screen.getByText('More details'));
    await user.click(screen.getByText('More details'));
    expect(screen.getByText('Create teammate 99')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Create teammate 99' }));
    expect(screen.queryByText('Create teammate 99')).not.toBeInTheDocument();
  });

  it('chooses status, assignee and section in pickers, keeping null choices and unknown references distinct', async () => {
    const user = userEvent.setup();
    const changes: Partial<TaskDraft>[] = [];
    const retained = { ...initial, statusId: 'status-missing', responsibleMembershipId: 'member-gone', sectionId: 'section-gone' };
    function Example() {
      const [draft, setDraft] = useState<TaskDraft>(retained);
      return <TaskFields showLegacyEstimate draft={draft} onChange={patch => { changes.push(patch); setDraft(before => ({ ...before, ...patch })); }} errors={{}} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} />;
    }
    render(<Example />);
    const status = screen.getByRole('combobox', { name: 'Status' });
    const responsible = screen.getByRole('combobox', { name: 'Assignee' });
    expect(status).toHaveTextContent('Status unavailable');
    expect(responsible).toHaveTextContent('Member unavailable');
    expect(screen.getByLabelText('Status')).toBe(status);

    await user.click(status);
    expect(screen.getByRole('option', { name: 'Status unavailable' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('option', { name: statuses[1]?.name ?? '' }));
    expect(changes.at(-1)).toEqual({ statusId: statuses[1]?.id });
    expect(status).toHaveFocus();

    await user.click(responsible);
    expect(screen.getByRole('option', { name: 'Stored participant' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'Unassigned' }));
    expect(changes.at(-1)).toEqual({ responsibleMembershipId: null });
    await user.click(responsible);
    await user.click(screen.getByRole('option', { name: 'Stored participant' }));
    expect(changes.at(-1)).toEqual({ responsibleMembershipId: assignee.id });

    await user.click(screen.getByText('More details'));
    const sectionPicker = screen.getByRole('combobox', { name: 'Section' });
    expect(sectionPicker).toHaveTextContent('Section unavailable');
    await user.click(sectionPicker);
    await user.click(screen.getByRole('option', { name: 'No section' }));
    expect(changes.at(-1)).toEqual({ sectionId: null });
  });

  it('locks every picker inside a disabled fieldset', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<fieldset disabled><TaskFields showLegacyEstimate draft={initial} onChange={onChange} errors={{}} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} /></fieldset>);
    for (const name of ['Status', 'Assignee', 'Section', 'Priority']) expect(screen.getByRole('combobox', { name })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reveals optional field errors automatically and keeps them linked to the input', () => {
    show({ errors: { startDate: { key: 'tasks.taskDraft.enterAValidDateBetweenYears0001And' }, estimate: { key: 'taskTable.estimate.useWholeMinutesSuchAs15Or' } } });
    expect(screen.getByText('More details').closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText('Start date')).toBeVisible();
    expect(screen.getByLabelText('Start date')).toHaveAccessibleDescription('Enter a valid date between years 0001 and 9999.');
    expect(screen.getByLabelText('Team estimate, hours')).toHaveAccessibleDescription(/Use whole minutes/);
  });

  it('reopens the same optional validation error after the user closes details and saves again', async () => {
    const user = userEvent.setup();
    function Example() {
      const [errors, setErrors] = useState<TaskDraftErrors>({});
      return <form onSubmit={event => { event.preventDefault(); const result = buildCreateInput('project-a', { ...initial, estimate: 'invalid' }, { parentTaskId: null, workScope: 'detail' }); if (!result.ok) setErrors(result.errors); }}>
        <TaskFields showLegacyEstimate draft={{ ...initial, estimate: 'invalid' }} onChange={() => undefined} errors={errors} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} />
        <button type="submit">Validate task</button>
      </form>;
    }
    render(<Example />);
    const details = screen.getByText('More details').closest('details');
    expect(details).not.toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'Validate task' }));
    expect(details).toHaveAttribute('open');
    expect(screen.getByLabelText('Team estimate, hours')).toHaveAccessibleDescription(/Enter hours/);
    await user.click(screen.getByText('More details'));
    expect(details).not.toHaveAttribute('open');
    await user.click(screen.getByRole('button', { name: 'Validate task' }));
    expect(details).toHaveAttribute('open');
    expect(screen.getByLabelText('Team estimate, hours')).toBeVisible();
  });

});

describe('task form save shortcut', () => {
  it.each(['ctrlKey', 'metaKey'] as const)('submits via the same form for %s+Enter without adding a textarea line', modifier => {
    const saved = vi.fn();
    render(<form onSubmit={event => { event.preventDefault(); saved(); }} onKeyDown={event => submitTaskFormShortcut(event, true)}><textarea aria-label="Task description" /><button type="submit">Save</button></form>);
    const event = new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true });
    fireEvent(screen.getByLabelText('Task description'), event);
    expect(event.defaultPrevented).toBe(true);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('does not submit a locked form or intercept ordinary Enter, Shift, or composition', () => {
    const saved = vi.fn();
    const view = render(<form onSubmit={event => { event.preventDefault(); saved(); }} onKeyDown={event => submitTaskFormShortcut(event, false)}><textarea aria-label="Draft" /></form>);
    fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'Enter', ctrlKey: true });
    expect(saved).not.toHaveBeenCalled();
    view.rerender(<form onSubmit={event => { event.preventDefault(); saved(); }} onKeyDown={event => submitTaskFormShortcut(event, true)}><textarea aria-label="Draft" /></form>);
    fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'Enter', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(screen.getByLabelText('Draft'), { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(saved).not.toHaveBeenCalled();
  });
});
