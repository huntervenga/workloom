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
    return <TaskFields draft={draft} onChange={patch => setDraft(before => ({ ...before, ...patch }))} errors={{}} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} {...props} />;
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
    await user.selectOptions(screen.getByLabelText('Priority'), 'urgent');
    await user.click(screen.getByText('More details'));
    await user.click(screen.getByText('More details'));
    expect(screen.getByLabelText('Priority')).toHaveValue('urgent');
    expect(screen.getByLabelText('Section')).toHaveValue(section.id);
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
        <TaskFields draft={{ ...initial, estimate: 'invalid' }} onChange={() => undefined} errors={errors} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} />
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
