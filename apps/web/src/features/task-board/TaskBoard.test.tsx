import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { installFakeApi } from '../../test/fakeApi';
import { makeMember, makeTask, participant, statuses } from '../task-table/taskTableFixtures';
import { TaskBoard, type TaskBoardProps } from './TaskBoard';

const todo = statuses[0]; if (!todo) throw new Error('Missing todo fixture');
const done = { ...todo, id: 'done-a', name: 'Done A', group: 'done' as const, position: 2 };
const otherDone = { ...done, id: 'done-b', name: 'Done B', position: 3 };
function renderBoard(overrides: Partial<TaskBoardProps> = {}) {
  const props: TaskBoardProps = { tasks: [], statuses: [...statuses, done, otherDone], members: [], partial: false, writable: true, onOpenTask: vi.fn(), onEditStatus: vi.fn(), renderStatusEditor: () => null, ...overrides };
  return { ...render(<TaskBoard {...props} />), user: userEvent.setup(), props };
}

describe('independent loaded-task board', () => {
  it('shows scoped counts, every catalog lane and a separate fallback lane for each missing status', () => {
    const tasks = [makeTask({ id: 'one', title: 'One' }), makeTask({ id: 'one', revision: 2, title: 'One current' }), makeTask({ id: 'two', title: 'Two', statusId: 'missing-a' }), makeTask({ id: 'three', title: 'Three', statusId: 'missing-b' })];
    renderBoard({ tasks, partial: true, caption: 'Filtered review' });
    expect(screen.getByRole('heading', { name: 'Filtered review' })).toHaveClass('sr-only');
    expect(screen.getByRole('region', { name: 'Filtered review' })).toHaveAccessibleName('Filtered review');
    expect(screen.getByText('3 loaded tasks in this view.')).toBeInTheDocument();
    expect(screen.getByText('More matching tasks may be available. Counts cover only the loaded tasks in this view.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Task status lanes' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('region', { name: 'Done A' })).toHaveTextContent('0 loaded tasks');
    expect(screen.getByRole('region', { name: 'Done B' })).toHaveTextContent('0 loaded tasks');
    expect(screen.getByRole('region', { name: 'Status unavailable (1)' })).toHaveTextContent('1 loaded task');
    expect(screen.getByRole('region', { name: 'Status unavailable (2)' })).toHaveTextContent('1 loaded task');
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(document.body).not.toHaveTextContent('missing-a');
    expect(document.body).not.toHaveTextContent('missing-b');
    expect(screen.queryByRole('button', { name: 'One' })).not.toBeInTheDocument();
  });

  it('opens task and immediate parent using separate native controls without reads or mutations', async () => {
    const { calls } = installFakeApi({});
    const parent = makeTask({ id: 'parent', title: 'Loaded parent' });
    const child = makeTask({ id: 'child', title: 'Child task', parentTaskId: parent.id });
    const missing = makeTask({ id: 'missing-child', title: 'Missing-parent child', parentTaskId: 'not-loaded' });
    const { user, props } = renderBoard({ tasks: [parent, child, missing] });
    const childButton = screen.getByRole('button', { name: 'Child task' });
    const childCard = childButton.closest('li'); if (!childCard) throw new Error('Missing card');
    const parentButton = within(childCard).getByRole('button', { name: 'Loaded parent' });
    expect(parentButton.tagName).toBe('BUTTON');
    expect(parentButton).toHaveAccessibleDescription('Parent task');
    await user.click(parentButton);
    await user.click(childButton);
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, parent.id);
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, child.id);
    expect(screen.getByText('Parent task not loaded')).toBeInTheDocument();
    expect(document.querySelector('button button')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('hands the merged seen task to the status editor and uses native keyboard activation', async () => {
    const current = makeTask({ id: 'edit', title: 'Current task', revision: 7, statusId: done.id, workPackageRevision: 1 });
    const oldFields = { ...current, title: 'Old task', revision: 2, workPackageRevision: 4, estimateMinutes: 0, participantsRevision: 6, participants: [participant('person-b')] };
    const { user, props } = renderBoard({ tasks: [current, oldFields] });
    const open = screen.getByRole('button', { name: 'Current task' });
    open.focus();
    await user.keyboard('{Enter}');
    expect(props.onOpenTask).toHaveBeenCalledWith(current.id);
    const change = screen.getByRole('button', { name: 'Change status' });
    expect(change).toHaveAccessibleDescription(current.title);
    await user.click(change);
    expect(props.onEditStatus).toHaveBeenCalledOnce();
    expect(props.onEditStatus).toHaveBeenCalledWith(expect.objectContaining({ id: current.id, revision: 7, workPackageRevision: 4, estimateMinutes: 0, participantsRevision: 6 }));
  });

  it.each([true, false])('shows new status editing only for writable ordinary unarchived tasks (writable=%s)', async writable => {
    const ordinary = makeTask({ id: 'ordinary', title: 'Ordinary' });
    const meeting = makeTask({ id: 'meeting', title: 'Meeting task', meetingId: 'meeting-id' });
    const unknown = makeTask({ id: 'unknown', title: 'Unknown type', meetingId: undefined });
    const archived = makeTask({ id: 'archived', title: 'Archived task', archivedAt: '2026-10-01T00:00:00Z' });
    const { user, props } = renderBoard({ tasks: [ordinary, meeting, unknown, archived], writable });
    expect(screen.queryAllByRole('button', { name: 'Change status' })).toHaveLength(writable ? 1 : 0);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Meeting task' }));
    await user.click(screen.getByRole('button', { name: 'Unknown type' }));
    expect(props.onOpenTask).toHaveBeenNthCalledWith(1, meeting.id);
    expect(props.onOpenTask).toHaveBeenNthCalledWith(2, unknown.id);
    expect(props.onEditStatus).not.toHaveBeenCalled();
    expect(screen.getByText('Refresh task details')).toBeInTheDocument();
  });

  it('retains a supplied original editor and its input after the latest task becomes read-only/unknown', async () => {
    const task = makeTask({ id: 'held', title: 'Held task' });
    const retry = vi.fn();
    const editor = () => <div role="group" aria-label="Original status save"><label>Original draft<input defaultValue="In progress" /></label><button type="button" onClick={retry}>Retry original status</button></div>;
    const { user, props, rerender } = renderBoard({ tasks: [task], renderStatusEditor: editor, draftTaskIds: new Set([task.id]) });
    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Original draft'), ' kept');
    rerender(<TaskBoard {...props} tasks={[{ ...task, meetingId: undefined }]} writable={false} />);
    expect(screen.getByLabelText('Original draft')).toHaveValue('In progress kept');
    expect(screen.getByLabelText('Original draft')).toHaveFocus();
    expect(screen.getByText('Draft kept')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry original status' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('distinguishes missing people/dates and uses only an explicit today for overdue labels', () => {
    const person = makeMember({ id: 'known-person', userId: 'user', displayName: 'Known person' });
    const tasks = [makeTask({ id: 'past', title: 'Past due', responsibleMembershipId: person.id, dueDate: '2026-10-05' }), makeTask({ id: 'done', title: 'Done past due', statusId: done.id, responsibleMembershipId: 'missing-person', dueDate: '2026-10-05' }), makeTask({ id: 'none', title: 'No date' })];
    const { props, rerender } = renderBoard({ tasks, members: [person], today: '2026-10-16' });
    expect(screen.getAllByText('Overdue')).toHaveLength(1);
    expect(screen.getAllByText('Due Oct 5, 2026')).toHaveLength(2);
    expect(screen.getByText('Known person')).toBeInTheDocument();
    expect(screen.getByText('Assigned person unavailable')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('No due date')).toBeInTheDocument();
    rerender(<TaskBoard {...props} today={undefined} />);
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  it('keeps full long metadata and separate completion, title and status keyboard actions', async () => {
    const person = makeMember({ id: 'long-name', userId: 'long-name-user', displayName: 'Alexandra María Verylongunbrokenfamilynameforwrapping' });
    const task = makeTask({ id: 'long-card', title: 'Review the complete launch plan with Verylongunbrokenprojecttitleforwrapping', responsibleMembershipId: person.id, dueDate: '2026-10-05' });
    const complete = vi.fn();
    const { user, props } = renderBoard({ tasks: [task], members: [person], today: '2026-10-16', renderCompletionAction: item => <button type="button" aria-label={`Complete ${item.title}`} onClick={complete}>Complete</button> });
    const title = screen.getByRole('button', { name: task.title });
    const card = title.closest('li'); if (!card) throw new Error('Missing card');
    const metadata = within(card);
    expect(metadata.getByText(person.displayName)).toBeInTheDocument();
    expect(metadata.getByText('Assignee', { selector: 'dt' })).toHaveClass('sr-only');
    expect(metadata.getByText('Due Oct 5, 2026')).toBeInTheDocument();
    expect(metadata.getByText('Overdue')).toBeInTheDocument();
    const completion = metadata.getByRole('button', { name: `Complete ${task.title}` });
    const status = metadata.getByRole('button', { name: 'Change status' });
    expect(status).toHaveAccessibleDescription(task.title);
    expect(status).toHaveAttribute('data-task-cell', `${task.id}:statusId`);
    completion.focus();
    await user.keyboard('{Enter}'); expect(complete).toHaveBeenCalledTimes(1);
    await user.tab(); expect(title).toHaveFocus();
    await user.keyboard('{Enter}'); expect(props.onOpenTask).toHaveBeenCalledWith(task.id);
    await user.tab(); expect(status).toHaveFocus();
    await user.keyboard(' '); expect(props.onEditStatus).toHaveBeenCalledWith(task);
    expect(document.querySelector('button button')).toBeNull();
  });

  it('keeps empty catalog lanes and gives an explicit empty loaded view', () => {
    renderBoard();
    expect(screen.getByText('0 loaded tasks in this view.')).toBeInTheDocument();
    expect(screen.getAllByText('No loaded tasks in this status.')).toHaveLength(4);
    expect(screen.getByText('No loaded tasks match this view.')).toBeInTheDocument();
  });
});
