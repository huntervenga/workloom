import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as I18n from '../../i18n';
import type { LocalizationManager, TranslationCatalog } from '../../i18n/LocalizationManager';
import { makeMember, makeTag, statuses } from '../task-table/taskTableFixtures';
import { TaskFilters, emptyTaskFilters, hasActiveTaskFilters, type TaskFilterValue } from './TaskFilters';

const state = vi.hoisted(() => ({ manager: undefined as LocalizationManager | undefined }));
vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof I18n>();
  const resources = import.meta.glob<TranslationCatalog>('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const en = Object.fromEntries(Object.entries(resources).map(([path, catalog]) => [path.slice(path.lastIndexOf('/') + 1).replace('.json', ''), catalog]));
  const manager = new actual.LocalizationManager({ en, fr: { tasks: { taskFilters: { taskTag: 'Étiquette de tâche', allTags: 'Toutes les étiquettes', tagUnavailable: 'Étiquette indisponible', clearFilters: 'Effacer les filtres' } } } });
  state.manager = manager;
  return { ...actual, useTranslation: () => actual.useTranslation(manager) };
});
afterEach(() => act(() => state.manager?.setLocale('en')));

const first = makeTag({ id: 'tag-a', name: 'Alpha tag' });
const second = makeTag({ id: 'tag-b', name: 'Beta tag' });
const archived = makeTag({ id: 'tag-old', name: 'Old authorized tag', archivedAt: '2026-10-16T09:00:00Z' });
const member = makeMember({ id: 'member-a', userId: 'user-a', displayName: 'Stored participant' });
const catalogs = { statuses, members: [member], tags: [second, archived, first] };

function Controlled({ initial = emptyTaskFilters }: { initial?: TaskFilterValue }) {
  const [value, onChange] = useState(initial);
  return <TaskFilters {...catalogs} value={value} onChange={onChange} />;
}

describe('single-tag task chooser', () => {
  it('offers active tags in name order with an accessible label and excludes unselected archived tags', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.click(screen.getByText('Filters'));
    const chooser = screen.getByRole('combobox', { name: 'Task tag' });
    expect(within(chooser).getAllByRole('option').map(option => option.textContent)).toEqual(['All tags', 'Alpha tag', 'Beta tag']);
    expect(chooser).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('combines tag/status/participant/archive/search choices and Clear resets every filter', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    await user.type(screen.getByRole('searchbox', { name: 'Search tasks' }), 'needle');
    await user.click(screen.getByText('Filters'));
    await user.selectOptions(screen.getByLabelText('Task status'), statuses[0]?.id ?? '');
    await user.selectOptions(screen.getByLabelText('Task participant'), member.id);
    await user.selectOptions(screen.getByLabelText('Task tag'), first.id);
    await user.click(screen.getByLabelText('Show archived tasks'));
    expect(screen.getByText('Filters (4)')).toBeVisible();
    expect(screen.getByLabelText('Task tag')).toHaveValue(first.id);
    expect(screen.getByRole('searchbox')).toHaveValue('needle');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByLabelText('Task tag')).toHaveValue('');
    expect(screen.getByLabelText('Task status')).toHaveValue('');
    expect(screen.getByLabelText('Task participant')).toHaveValue('');
    expect(screen.getByLabelText('Show archived tasks')).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(hasActiveTaskFilters({ ...emptyTaskFilters, tagId: first.id })).toBe(true);
    expect(hasActiveTaskFilters(emptyTaskFilters)).toBe(false);
  });

  it('keeps a held tag through active, archived, missing and restored catalog states without changing filters', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = { ...emptyTaskFilters, tagId: first.id, search: 'Held search' };
    const view = render(<TaskFilters {...catalogs} value={value} onChange={onChange} />);
    await user.click(screen.getByText('Filters (1)'));
    view.rerender(<TaskFilters {...catalogs} tags={[{ ...first, archivedAt: '2026-10-16T09:00:00Z' }, archived]} value={value} onChange={onChange} />);
    expect(screen.getByLabelText('Task tag')).toHaveValue(first.id);
    expect(screen.getByRole('option', { name: 'Alpha tag (archived)' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Old authorized tag' })).not.toBeInTheDocument();
    // Empty catalog also covers parent query loading/error with no available cached data.
    view.rerender(<TaskFilters statuses={statuses} members={[member]} value={value} onChange={onChange} />);
    expect(screen.getByLabelText('Task tag')).toHaveValue(first.id);
    expect(screen.getByRole('option', { name: 'Tag unavailable' })).toHaveValue(first.id);
    expect(screen.queryByText(first.id)).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('Held search');
    view.rerender(<TaskFilters {...catalogs} value={value} onChange={onChange} />);
    expect(screen.getByLabelText('Task tag')).toHaveValue(first.id);
    expect(screen.getByRole('option', { name: 'Alpha tag' })).toHaveValue(first.id);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reacts to live locale changes while preserving an unavailable tag and all other held inputs', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const value = { ...emptyTaskFilters, tagId: 'missing-tag', statusId: statuses[0]?.id ?? '', search: 'Held input' };
    render(<TaskFilters statuses={statuses} members={[]} value={value} onChange={onChange} />);
    await user.click(screen.getByText('Filters (2)'));
    expect(screen.getByRole('option', { name: 'Tag unavailable' })).toBeInTheDocument();
    act(() => state.manager?.setLocale('fr'));
    expect(screen.getByRole('combobox', { name: 'Étiquette de tâche' })).toHaveValue('missing-tag');
    expect(screen.getByRole('option', { name: 'Étiquette indisponible' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Toutes les étiquettes' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox')).toHaveValue('Held input');
    expect(screen.getByLabelText('Task status')).toHaveValue(value.statusId);
    expect(screen.getByRole('button', { name: 'Effacer les filtres' })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
