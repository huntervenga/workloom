import type { TagDto, TaskDto, TaskStatusDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, created, deferred, failure, installFakeApi } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { PROJECT_ID, rootPath, task } from '../planning/test/fixtures';
import { QuickTaskAdd, QuickTaskDraftPreview } from './QuickTaskAdd';
import { emptyDraft } from './taskDraft';
import { freshQuickSession } from './tableEditing';
import { useTaskCommands, type CreateRequest, type CreateSession, type TaskCommands } from './useTaskCommands';

const SECTION = 'e1000000-0000-4000-8000-000000000001';
const STATUS_PROGRESS = 'f6000000-0000-4000-8000-000000000002';
const B_ID = 'f2000000-0000-4000-8000-0000000000b1';
const C_ID = 'f2000000-0000-4000-8000-0000000000c1';
const X_ID = 'f2000000-0000-4000-8000-0000000000e1';
const Y_ID = 'f2000000-0000-4000-8000-0000000000e2';
const TAG_ID = 'f7000000-0000-4000-8000-000000000001';
const statuses: TaskStatusDto[] = [
  { id: task.statusId, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored todo', group: 'todo', position: 0, revision: 1 },
  { id: STATUS_PROGRESS, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'Stored progress', group: 'in_progress', position: 1, revision: 1 },
];
const tags: TagDto[] = [{ id: TAG_ID, workspaceId: alpha.id, name: 'Stored tag', color: null, revision: 1, archivedAt: null }];
// The table supplies the cells; custom and time columns have no draft adapter yet.
const columns = ['title', 'status', 'responsible', 'participants', 'startDate', 'dueDate', 'priority', 'tags', 'estimate', 'field:custom', 'time'];
const renderRow = (renderCell: (columnId: string) => ReactNode) => <tr data-testid="draft-row">{columns.map(column => <td key={column} data-column={column}>{renderCell(column)}</td>)}</tr>;
const cell = (column: string) => screen.getByTestId('draft-row').querySelector(`[data-column="${column}"]`);
const afterB: CreateRequest = { sectionId: SECTION, parent: null, insertion: { anchorTaskId: B_ID, placement: 'after' } };
const titleOf = (body: unknown) => (body as { title: string }).title;

function row(request?: CreateRequest, tagOptions: readonly TagDto[] = tags, withinShell = false) {
  const onCreated = vi.fn(); const onClosed = vi.fn();
  // Details take focus as a drawer would; the row must not take it back.
  const onMoreDetails = vi.fn(() => document.getElementById('qa-details')?.focus());
  let current: TaskCommands | null = null;
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    current = commands;
    const [open, setOpen] = useState(true);
    return <>
      <table><tbody>{open ? <QuickTaskAdd projectId={PROJECT_ID} sectionId={SECTION} sectionName="Stored section" statuses={statuses} members={alphaMembers} tags={tagOptions} commands={commands} writable
        request={request} renderRow={renderRow} onClose={reason => { onClosed(reason); setOpen(false); }} onMoreDetails={onMoreDetails} onCreated={onCreated} /> : null}</tbody></table>
      <button onClick={() => setOpen(true)}>Resume QA row</button><button>Outside focus</button><button id="qa-details">Details heading</button>
    </>;
  }
  const view = renderFieldUi(withinShell ? <main tabIndex={-1}><Example /></main> : <Example />);
  return { ...view, onCreated, onClosed, onMoreDetails, commands: () => { if (!current) throw new Error('No command harness'); return current; } };
}

const openActions = async (user: ReturnType<typeof renderFieldUi>['user']) => {
  await user.keyboard('{Shift>}{F10}{/Shift}');
  return screen.findByRole('menu', { name: 'New task actions' });
};

function lost() {
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<Response>((_resolve, fail) => { reject = fail; });
  return { promise, lose: () => reject(new TypeError('Failed to fetch')) };
}

describe('full quick task row', () => {
  it('edits built-in cells locally and sends one placed create only from the title Enter', async () => {
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => created({ ...task, id: X_ID, title: titleOf(request.body) }) });
    const ui = row(afterB);
    expect(screen.getByTestId<HTMLTableRowElement>('draft-row').cells).toHaveLength(columns.length);
    expect(screen.getByLabelText('Task name')).toHaveFocus();
    await ui.user.click(screen.getByRole('combobox', { name: 'Status' }));
    await ui.user.click(screen.getByRole('option', { name: 'Stored progress' }));
    await ui.user.click(screen.getByRole('combobox', { name: 'Priority' }));
    await ui.user.click(screen.getByRole('option', { name: 'High' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-19' } });
    await ui.user.click(screen.getByRole('button', { name: 'Edit dates for the new task' }));
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-20' } });
    await ui.user.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Team estimate (hours)' }), { target: { value: '1:30' } });
    await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
    await ui.user.click(screen.getByRole('checkbox', { name: 'Stored tag' }));
    // No cell writes on its own, and unsupported columns show no invented value.
    expect(calls).toHaveLength(0);
    expect(cell('field:custom')).toBeEmptyDOMElement();
    expect(cell('time')).toBeEmptyDOMElement();
    expect(ui.onClosed).not.toHaveBeenCalled();
    const title = screen.getByLabelText('Task name');
    await ui.user.click(title);
    await ui.user.keyboard('Placed task{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({
      projectId: PROJECT_ID, sectionId: SECTION, title: 'Placed task', statusId: STATUS_PROGRESS, startDate: '2026-10-19', dueDate: '2026-10-20',
      priority: 'high', tagIds: [TAG_ID], estimateMinutes: 90, insertion: { anchorTaskId: B_ID, placement: 'after' },
    });
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    // The same focused input continues across the ACK, ready for the next task.
    expect(screen.getByLabelText('Task name')).toBe(title);
    expect(title).toHaveValue('');
    expect(title).toHaveFocus();
    expect(calls).toHaveLength(1);
  });

  it('looks like a task row: only the title input in its cell, with details reached through the keyboard actions menu', async () => {
    const { calls } = installFakeApi({});
    const ui = row(afterB);
    const titleCell = cell('title') as HTMLElement;
    expect(within(titleCell).getByRole('textbox', { name: 'Task name' })).toHaveFocus();
    expect(within(titleCell).queryByRole('button')).not.toBeInTheDocument();
    for (const name of ['Add task', 'More details', 'Collapse editor']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task name')).toHaveAccessibleDescription(/Shift\+F10/);
    await ui.user.type(screen.getByLabelText('Task name'), 'Needs details');
    const menu = await openActions(ui.user);
    await ui.user.click(within(menu).getByRole('menuitem', { name: 'More details' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(ui.commands().createSession.current?.draft.title).toBe('Needs details');
    expect(ui.commands().quick.draft).toBeNull();
    // Closing the menu after the hand-off leaves focus in details.
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(screen.getByRole('button', { name: 'Details heading' })).toHaveFocus();
    expect(calls).toHaveLength(0);
  });

  it('closes only the actions menu on its Escape, returning focus to the same title with the draft intact', async () => {
    installFakeApi({});
    const ui = row(afterB);
    const title = screen.getByLabelText('Task name');
    await ui.user.type(title, 'Kept under the menu');
    await openActions(ui.user);
    await ui.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(title).toHaveFocus());
    expect(ui.onClosed).not.toHaveBeenCalled();
    expect(title).toHaveValue('Kept under the menu');
    expect(ui.commands().quick.draft?.draft.title).toBe('Kept under the menu');
  });

  it('adds from the menu like Enter and discards from a right-click menu like Escape', async () => {
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => created({ ...task, id: X_ID, title: titleOf(request.body) }) });
    const ui = row(afterB);
    const title = screen.getByLabelText('Task name');
    await ui.user.type(title, 'Menu added');
    await ui.user.click(within(await openActions(ui.user)).getByRole('menuitem', { name: 'Add and start the next task' }));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls.map(call => titleOf(call.body))).toEqual(['Menu added']);
    await waitFor(() => expect(title).toHaveFocus());
    await ui.user.type(title, 'Menu discarded');
    fireEvent.contextMenu(title);
    await ui.user.click(within(await screen.findByRole('menu', { name: 'New task actions' })).getByRole('menuitem', { name: 'Discard draft' }));
    expect(ui.onClosed).toHaveBeenLastCalledWith('cancel');
    expect(ui.commands().quick.draft).toBeNull();
    expect(ui.commands().createSession.current).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('continues a first child without an anchor: no place in its body, the next child follows the confirmed one', async () => {
    const parent: TaskDto = { ...task, sectionId: SECTION };
    const first = deferred<Response>(); let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => ++attempt === 1 ? first.promise : created({ ...task, id: Y_ID, parentTaskId: parent.id, title: titleOf(request.body) }) });
    const ui = row({ sectionId: null, parent, continueInPlace: true });
    await ui.user.type(screen.getByLabelText('Task name'), 'First child{Enter}Second child{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, parentTaskId: parent.id, workScope: 'detail', title: 'First child', statusId: task.statusId });
    expect(ui.commands().quick.queue[1]?.sent).toBeUndefined();
    await act(async () => first.resolve(created({ ...task, id: X_ID, parentTaskId: parent.id, title: 'First child' })));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, parentTaskId: parent.id, workScope: 'detail', title: 'Second child', statusId: task.statusId, insertion: { anchorTaskId: X_ID, placement: 'after' } });
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(2));
  });

  it('places a queued follower after the confirmed task of its predecessor, never before it is known', async () => {
    const first = deferred<Response>(); let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => ++attempt === 1 ? first.promise : created({ ...task, id: Y_ID, title: titleOf(request.body) }) });
    const ui = row(afterB);
    await ui.user.type(screen.getByLabelText('Task name'), 'X task{Enter}Y task{Enter}');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toMatchObject({ title: 'X task', insertion: { anchorTaskId: B_ID, placement: 'after' } });
    expect(ui.commands().quick.queue.map(entry => entry.input.title)).toEqual(['X task', 'Y task']);
    expect(ui.commands().quick.queue[1]?.input).not.toHaveProperty('insertion');
    expect(ui.commands().quick.queue[1]?.sent).toBeUndefined();
    await act(async () => first.resolve(created({ ...task, id: X_ID, title: 'X task' })));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ title: 'Y task', insertion: { anchorTaskId: X_ID, placement: 'after' } });
    expect(calls[1]?.headers.get('Idempotency-Key')).not.toBe(calls[0]?.headers.get('Idempotency-Key'));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(2));
  });

  it('gives a discarded rejected task’s place to its follower without overtaking it before the discard', async () => {
    let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => ++attempt === 1 ? failure(409, 'REVISION_CONFLICT', 'private') : created({ ...task, id: Y_ID, title: titleOf(request.body) }) });
    const ui = row({ sectionId: SECTION, parent: null, insertion: { anchorTaskId: C_ID, placement: 'before' } });
    await ui.user.type(screen.getByLabelText('Task name'), 'X task{Enter}Y task{Enter}');
    await screen.findByRole('button', { name: 'Discard rejected task' });
    expect(calls).toHaveLength(1);
    await ui.user.click(screen.getByRole('button', { name: 'Discard rejected task' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toMatchObject({ title: 'Y task', insertion: { anchorTaskId: C_ID, placement: 'before' } });
  });

  it('retries an unknown placed create with its exact first body and key', async () => {
    const first = lost(); let attempt = 0;
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => ++attempt === 1 ? first.promise : created({ ...task, id: X_ID, title: 'Placed unknown' }) });
    const ui = row(afterB);
    await ui.user.type(screen.getByLabelText('Task name'), 'Placed unknown{Enter}');
    await waitFor(() => expect(attempt).toBe(1));
    await act(async () => first.lose());
    await ui.user.click(await screen.findByRole('button', { name: 'Retry original' }));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ insertion: { anchorTaskId: B_ID, placement: 'after' } });
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
  });

  it('drops only the unsent placed draft on Escape and keeps the queued create', async () => {
    const response = deferred<Response>();
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: () => response.promise });
    const ui = row(afterB);
    await ui.user.type(screen.getByLabelText('Task name'), 'Queued placed{Enter}Unsent placed');
    await waitFor(() => expect(calls).toHaveLength(1));
    await ui.user.keyboard('{Escape}');
    expect(ui.onClosed).toHaveBeenLastCalledWith('cancel');
    expect(ui.commands().quick.draft).toBeNull();
    expect(ui.commands().quick.queue.map(entry => entry.input.title)).toEqual(['Queued placed']);
    expect(ui.commands().createSession.current?.draft.title).toBe('Queued placed');
    await act(async () => response.resolve(created({ ...task, id: X_ID, title: 'Queued placed' })));
    await waitFor(() => expect(ui.onCreated).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(ui.commands().createSession.current).toBeNull();
  });

  it('discards the bottom row’s unsent draft on Escape, so reopening shows an empty row', async () => {
    const { calls } = installFakeApi({});
    const ui = row();
    await ui.user.type(screen.getByLabelText('Task name'), 'Bottom discarded');
    await ui.user.keyboard('{Escape}');
    expect(ui.onClosed).toHaveBeenLastCalledWith('cancel');
    expect(ui.commands().createSession.current).toBeNull();
    expect(ui.commands().quick.draft).toBeNull();
    await ui.user.click(screen.getByRole('button', { name: 'Resume QA row' }));
    expect(screen.getByLabelText('Task name')).toHaveValue('');
    expect(calls).toHaveLength(0);
  });

  it('keeps the row open while focus moves between its own cells', async () => {
    installFakeApi({});
    const ui = row(afterB);
    await ui.user.tab();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(ui.onClosed).not.toHaveBeenCalled();
    await ui.user.click(screen.getByRole('combobox', { name: 'Status' }));
    await ui.user.keyboard('{Escape}');
    expect(ui.onClosed).not.toHaveBeenCalled();
    await ui.user.click(screen.getByRole('button', { name: 'Outside focus' }));
    await waitFor(() => expect(ui.onClosed).toHaveBeenCalledExactlyOnceWith('blur'));
  });

  it('creates a detail subtask in its parent section without an estimate cell or estimate', async () => {
    const parent: TaskDto = { ...task, sectionId: SECTION };
    const { calls } = installFakeApi({ [`POST ${rootPath}/tasks`]: request => created({ ...task, id: X_ID, parentTaskId: parent.id, title: titleOf(request.body) }) });
    row({ sectionId: null, parent });
    expect(cell('estimate')).toBeEmptyDOMElement();
    await screen.findByLabelText('Task name');
    fireEvent.change(screen.getByLabelText('Task name'), { target: { value: 'Child task' } });
    fireEvent.submit(screen.getByLabelText('Task name').closest('form') as HTMLFormElement);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ projectId: PROJECT_ID, sectionId: SECTION, parentTaskId: parent.id, workScope: 'detail', title: 'Child task', statusId: task.statusId });
  });
});

describe('submitted draft preview', () => {
  it('shows the submitted values in the same cells without any control or task link', () => {
    installFakeApi({});
    const session: CreateSession = { ...freshQuickSession(SECTION, task.statusId), draft: { ...emptyDraft(STATUS_PROGRESS, SECTION), title: 'Submitted row', priority: 'high', dueDate: '2026-10-20', tagIds: [TAG_ID] } };
    renderFieldUi(<table><tbody><QuickTaskDraftPreview session={session} renderRow={renderRow} pending statuses={statuses} members={alphaMembers} tags={tags} /></tbody></table>);
    expect(screen.getByTestId<HTMLTableRowElement>('draft-row').cells).toHaveLength(columns.length);
    expect(screen.getByText('Submitted row')).toBeInTheDocument();
    expect(screen.getByText('Stored progress')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('2026-10-20')).toBeInTheDocument();
    expect(screen.getByText('Stored tag')).toBeInTheDocument();
    expect(cell('responsible')).toBeEmptyDOMElement();
    expect(cell('field:custom')).toBeEmptyDOMElement();
    const preview = within(screen.getByTestId('draft-row'));
    expect(preview.queryByRole('textbox')).not.toBeInTheDocument();
    expect(preview.queryByRole('combobox')).not.toBeInTheDocument();
    expect(preview.queryByRole('button')).not.toBeInTheDocument();
    expect(preview.queryByRole('link')).not.toBeInTheDocument();
  });
});


it('closes local date and tag pickers on first Escape while retaining the unsent row values', async () => {
  const { calls } = installFakeApi({});
  const ui = row(afterB);
  await ui.user.click(screen.getByRole('button', { name: 'Edit dates for the new task' }));
  fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-20' } });
  await ui.user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Edit dates' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit dates for the new task' })).toHaveFocus();
  expect(ui.onClosed).not.toHaveBeenCalled();
  await ui.user.click(screen.getByRole('button', { name: 'Edit dates for the new task' }));
  expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-20');
  await ui.user.click(screen.getByRole('button', { name: 'Done' }));
  await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
  await ui.user.click(screen.getByRole('checkbox', { name: 'Stored tag' }));
  await ui.user.keyboard('{Escape}');
  expect(screen.queryByRole('checkbox', { name: 'Stored tag' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Tags' })).toHaveFocus();
  expect(ui.onClosed).not.toHaveBeenCalled();
  await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
  expect(screen.getByRole('checkbox', { name: 'Stored tag' })).toBeChecked();
  expect(calls).toHaveLength(0);
});


it('offers the existing details tag-creation path from an empty picker without sending or losing the new row draft', async () => {
  const { calls } = installFakeApi({});
  const ui = row(afterB, []);
  await ui.user.type(screen.getByLabelText('Task name'), 'Retained tag draft');
  await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
  await ui.user.click(screen.getByRole('button', { name: 'Open details to create tags' }));
  expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
  expect(ui.commands().createSession.current?.draft.title).toBe('Retained tag draft');
  expect(ui.commands().createSession.current?.request.insertion).toEqual(afterB.insertion);
  expect(calls).toHaveLength(0);
});


it('keeps a held nonfocusable date-popup target through the timer and gives the first Escape to the popup', async () => {
  const { calls } = installFakeApi({});
  const ui = row(afterB);
  await ui.user.click(screen.getByRole('button', { name: 'Edit dates for the new task' }));
  fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-20' } });
  await ui.user.pointer({ keys: '[MouseLeft>]', target: screen.getByText('March 2027') });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.getByRole('dialog', { name: 'Edit dates' })).toBeInTheDocument();
  expect(ui.onClosed).not.toHaveBeenCalled();
  await ui.user.pointer({ keys: '[/MouseLeft]' });
  await ui.user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Edit dates' })).not.toBeInTheDocument();
  expect(ui.onClosed).not.toHaveBeenCalled();
  await ui.user.keyboard('{Escape}');
  expect(ui.onClosed).toHaveBeenCalledTimes(1);
  expect(calls).toHaveLength(0);
});


it('retains an unsent draft when its tag label is held inside a focusable shell', async () => {
  const { calls } = installFakeApi({});
  const ui = row(afterB, tags, true);
  await ui.user.type(screen.getByLabelText('Task name'), 'Unsent tagged task');
  await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
  await ui.user.pointer({ keys: '[MouseLeft>]', target: screen.getByText('Stored tag') });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.getByRole('checkbox', { name: 'Stored tag' })).not.toBeChecked();
  expect(ui.onClosed).not.toHaveBeenCalled();
  expect(calls).toHaveLength(0);
  await ui.user.pointer({ keys: '[/MouseLeft]' });
  expect(screen.getByRole('checkbox', { name: 'Stored tag' })).toBeChecked();
  await ui.user.keyboard('{Enter}');
  expect(calls).toHaveLength(0);
  await ui.user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Tags' })).toHaveFocus();
  expect(ui.onClosed).not.toHaveBeenCalled();
  await ui.user.click(screen.getByRole('button', { name: 'Tags' }));
  expect(screen.getByRole('checkbox', { name: 'Stored tag' })).toBeChecked();
  expect(screen.getByLabelText('Task name')).toHaveValue('Unsent tagged task');
  expect(ui.commands().createSession.current?.draft.tagIds).toEqual([TAG_ID]);
  expect(calls).toHaveLength(0);
});
