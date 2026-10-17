import type { TagDto, TaskDto } from '@workloom/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, installFakeApi, ok } from '../../test/fakeApi';
import { renderFieldUi } from '../fields/test/fixtures';
import { STAMP, rootPath, task, lostResponse } from '../planning/test/fixtures';
import { InlineTaskEdit } from './InlineTaskEdit';
import { TaskTable } from '../task-table/TaskTable';
import { TaskDateInput } from './TaskDateInput';
import { TaskTagPicker } from './TaskTagPicker';
import { useTaskCommands } from './useTaskCommands';
import { canResumeInlineSession, matchesInlineTaskReceipt } from './tableEditing';
import { draftFromTask } from './taskDraft';

const oldTag: TagDto = { id: 'f7000000-0000-4000-8000-000000000001', workspaceId: alpha.id, name: 'Design', color: null, revision: 1, archivedAt: null };
const newTag: TagDto = { ...oldTag, id: 'f7000000-0000-4000-8000-000000000002', name: 'Delivery' };
const archived: TagDto = { ...oldTag, id: 'f7000000-0000-4000-8000-000000000003', name: 'Old tag', archivedAt: STAMP };
const source: TaskDto = { ...task, startDate: null, dueDate: '2027-03-20', tags: [oldTag] };
const path = `${rootPath}/tasks/${source.id}`;
function inline(field: 'dueDate' | 'tagIds', value = source, writable = true, tags = [oldTag, newTag, archived]) {
  const onSaved = vi.fn();
  const onMoreDetails = vi.fn();
  function Example() {
    const commands = useTaskCommands(anna.id, alpha.id);
    const [open, setOpen] = useState(true);
    return <>{open ? <InlineTaskEdit task={value} field={field} tags={tags} statuses={[]} members={alphaMembers} commands={commands} writable={writable}
      onClose={() => setOpen(false)} onMoreDetails={onMoreDetails} onSaved={onSaved} /> : null}<button>Outside dates</button></>;
  }
  // The real AppShell main is programmatically focusable for skip navigation.
  return { ...renderFieldUi(<main tabIndex={-1}><Example /></main>), onSaved, onMoreDetails };
}

describe('task dates and existing tags', () => {
  it('names saved tag and due-date cell actions distinctly and opens the intended field', async () => {
    const edit = vi.fn();
    const ui = renderFieldUi(<TaskTable tasks={[source]} sections={[]} statuses={[]} members={alphaMembers} writable
      onOpenTask={vi.fn()} onCreateTask={vi.fn()} onCreateChild={vi.fn()} onEditTaskField={edit} />);
    const tagAction = screen.getByRole('button', { name: `Edit tags for ${source.title}` });
    const dateAction = screen.getByRole('button', { name: `Edit due date for ${source.title}` });
    expect(screen.getAllByRole('button', { name: `Edit due date for ${source.title}` })).toHaveLength(1);
    expect(tagAction).toHaveAttribute('title', `Edit tags for ${source.title}`);
    await ui.user.click(tagAction);
    expect(edit).toHaveBeenLastCalledWith(source, 'tagIds');
    await ui.user.click(dateAction);
    expect(edit).toHaveBeenLastCalledWith(source, 'dueDate');
    expect(edit).toHaveBeenCalledTimes(2);
  });

  it('does not save a range while popup padding is held inside a focusable shell, but still saves on deliberate Tab outside', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok({ ...source, dueDate: '2027-04-15', revision: source.revision + 1 }) });
    const ui = inline('dueDate');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-04-15' } });
    const heading = screen.getByText('April 2027');
    expect(heading.closest('[tabindex]')).toBe(screen.getByRole('main'));
    await ui.user.pointer({ keys: '[MouseLeft>]', target: heading });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(calls).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Edit dates' })).toBeInTheDocument();
    await ui.user.pointer({ keys: '[/MouseLeft]' });
    screen.getByRole('button', { name: 'Collapse editor' }).focus();
    await ui.user.tab();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ expectedRevision: source.revision, dueDate: '2027-04-15' });
    expect(screen.getByRole('button', { name: 'Outside dates' })).toHaveFocus();
  });

  it('retains an incomplete typed date and refuses to turn it into a saved null clear', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok({ ...source, dueDate: null, revision: source.revision + 1 }) });
    const ui = inline('dueDate');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-' } });
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(calls).toHaveLength(0);
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid date.');
  });

  it('offers a direct retained-details path to existing tag creation when no tags are configured', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('tagIds', { ...source, tags: [] }, true, []);
    expect(within(screen.getByRole('dialog', { name: 'Edit tags' })).getByText('No tags yet.')).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: 'Open details to create tags' }));
    expect(ui.onMoreDetails).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('matches a range receipt by both endpoints and tag receipts by stable selected IDs', () => {
    const ranged = { ...source, startDate: '2027-03-01' };
    expect(matchesInlineTaskReceipt(ranged, { ...ranged, startDate: '2027-03-02' }, 'dueDate')).toBe(false);
    expect(matchesInlineTaskReceipt(source, { ...source, tags: [{ ...oldTag, name: 'Renamed independently', revision: 2 }] }, 'tagIds')).toBe(true);
    expect(matchesInlineTaskReceipt(source, { ...source, tags: [newTag] }, 'tagIds')).toBe(false);
    const draft = { ...draftFromTask(source), startDate: '2027-03-01', dueDate: '2027-03-22' };
    expect(canResumeInlineSession({ base: source, draft, inlineField: 'dueDate' }, 'dueDate')).toBe(true);
    expect(canResumeInlineSession({ base: source, draft: { ...draft, title: 'Other retained edit' }, inlineField: 'dueDate' }, 'dueDate')).toBe(false);
  });

  it('reveals an optional start without inventing a date and preserves a pre-existing range', async () => {
    const changes = vi.fn();
    const ui = renderFieldUi(<TaskDateInput startDate="" dueDate="2027-03-20" onChange={changes} />);
    expect(screen.getByLabelText('Due date')).toHaveValue('2027-03-20');
    expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: '+ Start date' }));
    expect(screen.getByLabelText('Start date')).toHaveValue('');
    expect(changes).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Due date')).toHaveAttribute('min', '0001-01-01');
    expect(screen.getByLabelText('Due date')).toHaveAttribute('max', '9999-12-31');
    ui.rerender(<TaskDateInput startDate="0001-01-01" dueDate="9999-12-31" onChange={changes} />);
    expect(screen.getByLabelText('Start date')).toHaveValue('0001-01-01');
    expect(screen.getByLabelText('Due date')).toHaveValue('9999-12-31');
  });

  it('stages both dates, rejects a reversed range without a command, then sends one final valid range', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok({ ...source, startDate: '2027-03-21', dueDate: '2027-03-22', revision: source.revision + 1 }) });
    const ui = inline('dueDate');
    expect(screen.getByRole('dialog', { name: 'Edit dates' })).toBeInTheDocument();
    await ui.user.click(screen.getByRole('button', { name: '+ Start date' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-21' } });
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Due date must be on or after the start date.');
    expect(calls).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2027-03-22' } });
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ expectedRevision: source.revision, startDate: '2027-03-21', dueDate: '2027-03-22' });
  });

  it('keeps an unknown range frozen and retries the exact same body and key', async () => {
    const first = lostResponse(); let attempts = 0;
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ++attempts === 1 ? first.promise : ok({ ...source, startDate: '2027-03-01', revision: source.revision + 1 }) });
    const ui = inline('dueDate');
    await ui.user.click(screen.getByRole('button', { name: '+ Start date' }));
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-03-01' } });
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    await act(async () => first.lose());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByLabelText('Start date')).toBeDisabled();
    expect(screen.getByLabelText('Due date')).toBeDisabled();
    await ui.user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
  });

  it('cancels without changing an existing saved start or sending a command', async () => {
    const { calls } = installFakeApi({});
    const ui = inline('dueDate', { ...source, startDate: '2027-03-01' });
    expect(screen.getByLabelText('Start date')).toHaveValue('2027-03-01');
    await ui.user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Edit dates' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('edits configured tags through a searchable picker and sends only changed tag IDs', async () => {
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok({ ...source, tags: [newTag], revision: source.revision + 1 }) });
    const ui = inline('tagIds');
    expect(screen.getByRole('dialog', { name: 'Edit tags' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Design' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Old tag' })).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Design' }));
    await ui.user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'Del');
    await ui.user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Edit tags' })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('checkbox', { name: 'Delivery' }));
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls[0]?.body).toEqual({ expectedRevision: source.revision, tagIds: [newTag.id] });
  });

  it.each(['startDate', 'dueDate'] as const)('keeps clearing %s local with usable owned focus before explicit Save', async endpoint => {
    const ranged = { ...source, startDate: '2027-03-01' };
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok({ ...ranged, [endpoint]: null, revision: source.revision + 1 }) });
    const ui = inline('dueDate', ranged);
    await ui.user.click(screen.getByLabelText(endpoint === 'startDate' ? 'Start date' : 'Due date'));
    const clear = screen.getByRole('button', { name: endpoint === 'startDate' ? 'Clear start date' : 'Clear due date' });
    await ui.user.click(clear);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const popup = screen.getByRole('dialog', { name: 'Edit dates' });
    expect(popup).toBeInTheDocument();
    expect(popup.contains(document.activeElement)).toBe(true);
    // Chrome blurs a focused button as it becomes disabled; do not leave focus on that control.
    expect(document.activeElement).not.toHaveAttribute('disabled');
    expect(calls).toHaveLength(0);
    if (endpoint === 'startDate') expect(screen.getByLabelText('Due date')).toHaveValue(ranged.dueDate);
    else expect(screen.getByLabelText('Start date')).toHaveValue(ranged.startDate);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ expectedRevision: source.revision, [endpoint]: null });
  });

  it('keeps a tag-label press local inside the shell until explicit Save', async () => {
    const emptyTags = { ...source, tags: [] };
    const { calls } = installFakeApi({ [`PATCH ${path}`]: () => ok({ ...emptyTags, tags: [newTag], revision: source.revision + 1 }) });
    const ui = inline('tagIds', emptyTags);
    await ui.user.type(screen.getByRole('searchbox', { name: 'Search tags' }), 'Del');
    await ui.user.keyboard('{Enter}');
    expect(calls).toHaveLength(0);
    const label = screen.getByText('Delivery');
    await ui.user.pointer({ keys: '[MouseLeft>]', target: label });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.getByRole('dialog', { name: 'Edit tags' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Delivery' })).not.toBeChecked();
    expect(calls).toHaveLength(0);
    await ui.user.pointer({ keys: '[/MouseLeft]' });
    expect(screen.getByRole('checkbox', { name: 'Delivery' })).toBeChecked();
    expect(calls).toHaveLength(0);
    await ui.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ui.onSaved).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ expectedRevision: source.revision, tagIds: [newTag.id] });
  });

  it('keeps held archived and missing tags removable, without offering new archived assignments', async () => {
    const changes = vi.fn();
    const ui = renderFieldUi(<TaskTagPicker tags={[oldTag, archived]} values={[archived.id, 'unavailable-tag']} onChange={changes} />);
    expect(screen.getByRole('checkbox', { name: 'Old tag (archived)' })).toBeChecked();
    await ui.user.click(screen.getByRole('checkbox', { name: 'Tag unavailable' }));
    expect(changes).toHaveBeenLastCalledWith([archived.id]);
  });

  it.each([false, true])('does not expose mutation controls for readonly or meeting tasks (%s)', meeting => {
    const { calls } = installFakeApi({});
    inline('tagIds', meeting ? { ...source, meetingId: 'ab000000-0000-4000-8000-000000000001' } : source, meeting);
    expect(screen.queryByRole('dialog', { name: 'Edit tags' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search tags' })).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});
