import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { makeMember, makeSection, statuses } from '../task-table/taskTableFixtures';
import { TaskFields, type TaskFieldsProps } from './TaskFields';
import { emptyDraft, type TaskDraft } from './taskDraft';

const assignee = makeMember({ id: 'member-a', userId: 'user-a', displayName: 'Stored participant' });
const section = makeSection({ id: 'section-a', name: 'Stored section' });
const initial = { ...emptyDraft('status-todo', section.id), title: 'Stored task', description: 'Stored notes', estimate: '2:00' };
function show(props: Partial<TaskFieldsProps>) {
  function Example() {
    const [draft, setDraft] = useState<TaskDraft>(initial);
    return <TaskFields draft={draft} onChange={patch => setDraft(before => ({ ...before, ...patch }))} errors={{}} statuses={statuses} sections={[section]} members={[assignee]} tags={new Map()} savedTagIds={[]} unavailableParticipantIds={[]} estimateMode={{ kind: 'shared' }} {...props} />;
  }
  return render(<Example />);
}

describe('task field parts for the compact drawer', () => {
  it('shows the name, the current project read only, section, status, assignee and dates first', () => {
    show({ part: 'primary', projectName: 'Launch plan' });
    expect(screen.getByLabelText('Task name')).toHaveValue('Stored task');
    expect(screen.getByText('Project')).toBeVisible();
    expect(screen.getByText('Launch plan')).toBeVisible();
    // The project is not a control: tasks cannot move to another project.
    expect(screen.queryByRole('combobox', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Section' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Assignee' })).toBeVisible();
    expect(screen.getByLabelText('Due date')).toBeVisible();
    expect(screen.queryByLabelText('Description')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Team estimate, hours')).not.toBeInTheDocument();
    expect(screen.queryByText('More details')).not.toBeInTheDocument();
  });

  it('shows the estimate, priority, participants and tags openly instead of behind More details', () => {
    show({ part: 'details' });
    expect(screen.getByLabelText('Team estimate, hours')).toBeVisible();
    expect(screen.getByLabelText('Team estimate, hours')).toHaveValue('2:00');
    expect(screen.getByText(/Weekly personal plans and actual hours are recorded separately/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Priority' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Participants' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'Tags' })).toBeVisible();
    expect(screen.queryByText('More details')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Section' })).not.toBeInTheDocument();
  });

  it('shows only the description in its own part', () => {
    show({ part: 'description' });
    expect(screen.getByLabelText('Description')).toHaveValue('Stored notes');
    expect(screen.queryByLabelText('Task name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Team estimate, hours')).not.toBeInTheDocument();
  });

  it('keeps every other field behind More details by default', () => {
    show({});
    expect(screen.getByText('More details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByLabelText('Team estimate, hours')).not.toBeVisible();
    expect(screen.queryByText('Project')).not.toBeInTheDocument();
  });
});


it('keeps the estimate supplement readable and retryable while editable detail fields are locked', () => {
  show({ part: 'details', disabled: true, estimateSupplement: <button type="button">Retry original read</button> });
  expect(screen.getByLabelText('Team estimate, hours')).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Priority' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Retry original read' })).toBeEnabled();
  expect(screen.getByLabelText('Team estimate, hours').closest('fieldset')?.parentElement).toContainElement(screen.getByRole('button', { name: 'Retry original read' }));
});
