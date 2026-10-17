import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as I18n from '../../i18n';
import type { LocalizationManager, TranslationCatalog } from '../../i18n/LocalizationManager';
import { makeMember, makeTag, statuses } from '../task-table/taskTableFixtures';
import { TaskFilters, emptyTaskFilters, hasActiveTaskFilters, patchTaskFilterParams, readTaskFilterParams, type TaskFilterValue } from './TaskFilters';
import { chooseFilter, filterMenu, filterOptionNames, filterPicker } from './test/filterPickers';

const state = vi.hoisted(() => ({ manager: undefined as LocalizationManager | undefined }));
vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18n>();
  const resources = import.meta.glob<TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const en = Object.fromEntries(Object.entries(resources).map(([path, catalog]) => [path.slice(path.lastIndexOf('/') + 1).replace('.json', ''), catalog]));
  const manager = new actual.LocalizationManager({ en, fr: { tasks: { taskFilters: { taskTag: 'Étiquette de tâche', allTags: 'Toutes les étiquettes', tagUnavailable: 'Étiquette indisponible', clearFilters: 'Effacer les filtres' } }, filterSummary: { group: 'Filtres actifs', tag: 'Étiquette : {{value}}', clearTag: 'Effacer le filtre étiquette : {{value}}' } } });
  state.manager = manager;
  return { ...actual, useTranslation: () => actual.useTranslation(manager) };
});
afterEach(() => act(() => state.manager?.setLocale('en')));

const first = makeTag({ id: 'tag-a', name: 'Alpha tag' });
const second = makeTag({ id: 'tag-b', name: 'Beta tag' });
const archived = makeTag({ id: 'tag-old', name: 'Old authorized tag', archivedAt: '2026-10-16T09:00:00Z' });
const member = makeMember({ id: 'member-a', userId: 'user-a', displayName: 'Stored participant' });
const catalogs = { statuses, members: [member], tags: [second, archived, first] };
const firstStatus = statuses[0]; if (!firstStatus) throw new Error('Missing status fixture');

function Controlled({ initial = emptyTaskFilters }: { initial?: TaskFilterValue }) {
  const [value, onChange] = useState(initial);
  return <TaskFilters {...catalogs} value={value} onChange={onChange} />;
}

describe('single-tag task chooser', () => {
  it('offers active tags in name order with an accessible label and excludes unselected archived tags', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByText('Filters'));
    const chooser = filterPicker('Task tag');
    expect(chooser.tagName).toBe('BUTTON');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(await filterOptionNames(user, 'Task tag')).toEqual(['All tags', 'Alpha tag', 'Beta tag']);
    expect(chooser).toHaveTextContent('All tags');
    expect(chooser).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('uses no native selects for status, participant or tag', async () => {
    const user = userEvent.setup();
    const { container } = render(<Controlled />);
    await user.click(screen.getByText('Filters'));
    expect(container.querySelector('select')).toBeNull();
    for (const label of ['Task status', 'Task participant', 'Task tag'] as const) {
      expect(screen.getByLabelText(label)).toBe(filterPicker(label));
      expect(filterPicker(label)).toHaveAttribute('aria-haspopup', 'listbox');
    }
  });

  it('combines tag/status/participant/archive/search choices and Clear resets every filter', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'needle');
    await user.click(screen.getByText('Filters'));
    await chooseFilter(user, 'Task status', firstStatus.name);
    await chooseFilter(user, 'Task participant', member.displayName);
    await chooseFilter(user, 'Task tag', first.name);
    await user.click(screen.getByLabelText('Show archived tasks'));
    expect(screen.getByText('Filters (4)')).toBeVisible();
    expect(filterPicker('Task tag')).toHaveTextContent(first.name);
    expect(filterPicker('Task status')).toHaveTextContent(firstStatus.name);
    expect(filterPicker('Task participant')).toHaveTextContent(member.displayName);
    expect(screen.getByRole('searchbox')).toHaveValue('needle');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(filterPicker('Task tag')).toHaveTextContent('All tags');
    expect(filterPicker('Task status')).toHaveTextContent('All statuses');
    expect(filterPicker('Task participant')).toHaveTextContent('All participants');
    expect(screen.getByLabelText('Show archived tasks')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
    expect(hasActiveTaskFilters({ ...emptyTaskFilters, tagId: first.id })).toBe(true);
    expect(hasActiveTaskFilters(emptyTaskFilters)).toBe(false);
  });

  it('sends exactly one change per explicit choice and none for dismissing or re-choosing the same option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TaskFilters {...catalogs} value={{ ...emptyTaskFilters, search: 'Held' }} onChange={onChange} />);
    await user.click(screen.getByText('Filters'));
    await user.click(filterPicker('Task status')); await user.keyboard('{Escape}');
    expect(screen.getByText('Filters', { selector: 'summary' }).closest('details')).toHaveAttribute('open');
    await chooseFilter(user, 'Task tag', 'All tags');
    expect(onChange).not.toHaveBeenCalled();
    await chooseFilter(user, 'Task status', firstStatus.name);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ ...emptyTaskFilters, search: 'Held', statusId: firstStatus.id });
  });

  it('keeps a held tag through active, archived, missing and restored catalog states without changing filters', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = { ...emptyTaskFilters, tagId: first.id, search: 'Held search' };
    const view = render(<TaskFilters {...catalogs} value={value} onChange={onChange} />);
    await user.click(screen.getByText('Filters (1)'));
    view.rerender(<TaskFilters {...catalogs} tags={[{ ...first, archivedAt: '2026-10-16T09:00:00Z' }, archived]} value={value} onChange={onChange} />);
    expect(filterPicker('Task tag')).toHaveTextContent('Alpha tag (archived)');
    await user.click(filterPicker('Task tag'));
    const retained = filterMenu('Task tag').getByRole('option', { name: 'Alpha tag (archived)' });
    expect(retained).toHaveAttribute('aria-selected', 'true'); expect(retained).toHaveAttribute('aria-disabled', 'true');
    expect(filterMenu('Task tag').queryByRole('option', { name: 'Old authorized tag' })).not.toBeInTheDocument();
    // A retained choice is visible but cannot be chosen again.
    await user.click(retained); expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Clear tag filter: Alpha tag (archived)' })).toBeInTheDocument();
    // Empty catalog also covers parent query loading/error with no available cached data.
    view.rerender(<TaskFilters statuses={statuses} members={[member]} value={value} onChange={onChange} />);
    expect(filterPicker('Task tag')).toHaveTextContent('Tag unavailable');
    await user.click(filterPicker('Task tag'));
    expect(filterMenu('Task tag').getByRole('option', { name: 'Tag unavailable' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Clear tag filter: Tag unavailable' })).toBeInTheDocument();
    expect(screen.queryByText(first.id)).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('Held search');
    view.rerender(<TaskFilters {...catalogs} value={value} onChange={onChange} />);
    expect(filterPicker('Task tag')).toHaveTextContent('Alpha tag');
    await user.click(filterPicker('Task tag'));
    expect(filterMenu('Task tag').getByRole('option', { name: 'Alpha tag' })).toHaveAttribute('aria-selected', 'true');
    expect(filterMenu('Task tag').queryByRole('option', { name: 'Tag unavailable' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a held status or participant that is not in the catalog as an explicit unavailable choice', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = { ...emptyTaskFilters, statusId: 'missing-status-secret-id', participantMembershipId: 'missing-person-secret-id' };
    render(<TaskFilters {...catalogs} value={value} onChange={onChange} />);
    await user.click(screen.getByText('Filters (2)'));
    expect(filterPicker('Task status')).toHaveTextContent('Status unavailable');
    expect(filterPicker('Task participant')).toHaveTextContent('Participant unavailable');
    await user.click(filterPicker('Task status'));
    const status = filterMenu('Task status').getByRole('option', { name: 'Status unavailable' });
    expect(status).toHaveAttribute('aria-selected', 'true'); expect(status).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');
    await user.click(filterPicker('Task participant'));
    expect(filterMenu('Task participant').getByRole('option', { name: 'Participant unavailable' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(document.body).not.toHaveTextContent(/secret-id/); expect(onChange).not.toHaveBeenCalled();
    // Any available choice replaces the held one explicitly.
    await chooseFilter(user, 'Task status', 'All statuses');
    expect(onChange).toHaveBeenLastCalledWith({ ...value, statusId: '' });
  });

  it('reacts to live locale changes while preserving an unavailable tag and all other held inputs', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = { ...emptyTaskFilters, tagId: 'missing-tag', statusId: firstStatus.id, search: 'Held input' };
    render(<TaskFilters statuses={statuses} members={[]} value={value} onChange={onChange} />);
    await user.click(screen.getByText('Filters (2)'));
    expect(filterPicker('Task tag')).toHaveTextContent('Tag unavailable');
    act(() => state.manager?.setLocale('fr'));
    const tag = screen.getByRole('combobox', { name: 'Étiquette de tâche' });
    expect(tag).toHaveTextContent('Étiquette indisponible');
    await user.click(tag);
    const menu = within(screen.getByRole('listbox', { name: 'Étiquette de tâche' }));
    expect(menu.getByRole('option', { name: 'Étiquette indisponible' })).toHaveAttribute('aria-selected', 'true');
    expect(menu.getByRole('option', { name: 'Toutes les étiquettes' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('searchbox')).toHaveValue('Held input');
    expect(filterPicker('Task status')).toHaveTextContent(firstStatus.name);
    expect(screen.getByRole('button', { name: 'Effacer les filtres' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Filtres actifs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Effacer le filtre étiquette : Étiquette indisponible' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});


const selectedStatus = statuses[0]; if (!selectedStatus) throw new Error('Missing status fixture');
const combined: TaskFilterValue = { search: '  literal search  ', statusId: selectedStatus.id, participantMembershipId: member.id, tagId: first.id, includeArchived: true };

describe('visible active-filter summaries', () => {
  it.each([
    ['statusId', `Clear status filter: ${selectedStatus.name}`],
    ['participantMembershipId', `Clear participant filter: ${member.displayName}`],
    ['tagId', `Clear tag filter: ${first.name}`],
    ['includeArchived', 'Exclude archived tasks'],
  ] as const)('clears only %s while preserving search and other conditions outside the closed panel', async (field, action) => {
    const user = userEvent.setup(); render(<Controlled initial={combined} />);
    const summary = screen.getByText('Filters (4)', { selector: 'summary' });
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(within(screen.getByRole('group', { name: 'Active filters' })).getAllByRole('button')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: action }));
    expect(summary).toHaveFocus(); expect(summary.closest('details')).not.toHaveAttribute('open'); expect(summary).toHaveTextContent('Filters (3)');
    expect(screen.getByRole('searchbox')).toHaveValue(combined.search);
    await user.click(summary);
    expect(filterPicker('Task status')).toHaveTextContent(field === 'statusId' ? 'All statuses' : selectedStatus.name);
    expect(filterPicker('Task participant')).toHaveTextContent(field === 'participantMembershipId' ? 'All participants' : member.displayName);
    expect(filterPicker('Task tag')).toHaveTextContent(field === 'tagId' ? 'All tags' : first.name);
    expect((screen.getByLabelText('Show archived tasks') as HTMLInputElement).checked).toBe(field !== 'includeArchived');
  });

  it.each(['{Enter}', ' '] as const)('supports native %s activation and keeps focus on a surviving summary after the last chip disappears', async key => {
    const user = userEvent.setup(); render(<Controlled initial={{ ...emptyTaskFilters, tagId: first.id }} />);
    screen.getByRole('button', { name: 'Clear tag filter: Alpha tag' }).focus();
    await user.keyboard(key);
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
    expect(screen.getByText('Filters', { selector: 'summary' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('keeps search visible without a duplicate chip or non-search count', () => {
    render(<Controlled initial={{ ...emptyTaskFilters, search: 'Visible query' }} />);
    expect(screen.getByRole('searchbox')).toHaveValue('Visible query');
    expect(screen.getByText('Filters', { selector: 'summary' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Active filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('uses neutral unloaded-reference labels without raw IDs and never changes a held filter on catalog updates', () => {
    const onChange = vi.fn();
    const value = { ...combined, statusId: 'missing-status-secret-id', participantMembershipId: 'missing-person-secret-id', tagId: 'missing-tag-secret-id' };
    const view = render(<TaskFilters value={value} onChange={onChange} statuses={[]} members={[]} tags={[]} />);
    expect(screen.getByRole('button', { name: 'Clear status filter: Status unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear participant filter: Participant unavailable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear tag filter: Tag unavailable' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/secret-id/);
    view.rerender(<TaskFilters value={value} onChange={onChange} statuses={statuses} members={[member]} tags={[first]} />);
    expect(onChange).not.toHaveBeenCalled(); expect(screen.getByRole('searchbox')).toHaveValue(combined.search);
  });

  it('retains full long literal catalog names in both visible labels and accessible actions', () => {
    const name = '<literal> Verylongunbrokenlabelthatmustwrapwithoutbeingcut off';
    const onChange = vi.fn();
    render(<TaskFilters value={{ ...emptyTaskFilters, tagId: first.id }} onChange={onChange} statuses={statuses} members={[member]} tags={[{ ...first, name }]} />);
    const action = screen.getByRole('button', { name: `Clear tag filter: ${name}` });
    expect(action).toHaveTextContent(`Tag: ${name}`); expect(action.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(action.querySelector('literal')).toBeNull(); expect(onChange).not.toHaveBeenCalled();
  });
});

const STATUS = 'f6000000-0000-4000-8000-000000000002';
const PERSON = 'c0000000-0000-4000-8000-000000000002';
const TAG = 'f7000000-0000-4000-8000-000000000001';

describe('task filter URL state', () => {
  it('reads canonical single values and ignores malformed, repeated and unknown boolean values', () => {
    expect(readTaskFilterParams(new URLSearchParams(`status=${STATUS.toUpperCase()}&participant=${PERSON}&tag=${TAG}&includeArchived=true&search=never`)))
      .toEqual({ statusId: STATUS, participantMembershipId: PERSON, tagId: TAG, includeArchived: true });
    for (const query of ['status=not-a-uuid&participant=&tag=x', `status=${STATUS}&status=${STATUS}`, 'includeArchived=1', 'includeArchived=True', 'includeArchived=false', `includeArchived=true&includeArchived=true`, `statusId=${STATUS}&participantMembershipId=${PERSON}&tagId=${TAG}`]) {
      expect(readTaskFilterParams(new URLSearchParams(query)), query).toEqual({ statusId: '', participantMembershipId: '', tagId: '', includeArchived: false });
    }
  });

  it('patches only changed filters onto the current head, keeps every other parameter and never writes search', () => {
    const empty = readTaskFilterParams(new URLSearchParams());
    const head = new URLSearchParams(`task=t&sort=due_asc&week=w&worker=p&other=kept&status=${STATUS}`);
    // A search edit changes no URL filter.
    expect(patchTaskFilterParams(head, empty, empty)).toBeNull();
    // A control rendered before the status change still adds its own tag without undoing that status.
    const tagged = patchTaskFilterParams(head, empty, { ...empty, tagId: TAG });
    expect(tagged?.toString()).toBe(`task=t&sort=due_asc&week=w&worker=p&other=kept&status=${STATUS}&tag=${TAG}`);
    expect(tagged?.has('search')).toBe(false); expect(head.has('tag')).toBe(false);
    const cleared = patchTaskFilterParams(new URLSearchParams(`status=${STATUS}&status=other&includeArchived=true&task=t`), { ...empty, statusId: STATUS, includeArchived: true }, empty);
    expect(cleared?.toString()).toBe('task=t');
    const archivedOnly = patchTaskFilterParams(new URLSearchParams('task=t'), empty, { ...empty, includeArchived: true });
    expect(archivedOnly?.toString()).toBe('task=t&includeArchived=true');
  });
});
