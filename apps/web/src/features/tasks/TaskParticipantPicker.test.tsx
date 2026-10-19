import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderFieldUi } from '../fields/test/fixtures';
import { makeMember } from '../task-table/taskTableFixtures';
import { TaskParticipantPicker } from './TaskParticipantPicker';

const members = Array.from({ length: 100 }, (_, index) => makeMember({ id: `member-${index}`, userId: `user-${index}`, displayName: `Teammate ${index}` }));
function example() {
  const changed = vi.fn();
  function Example() {
    const [value, setValue] = useState(['member-0', 'missing-member']);
    return <TaskParticipantPicker members={members} value={value} retainedIds={['missing-member']}
      onChange={next => { changed(next); setValue(next); }} />;
  }
  return { ...renderFieldUi(<Example />), changed };
}

describe('compact task participants', () => {
  it('shows only selected chips, searches 100 people, and saves an added person immediately', async () => {
    const ui = example();
    expect(screen.getByText('Teammate 0')).toBeVisible();
    expect(screen.queryByText('Teammate 99')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await ui.user.click(screen.getByRole('combobox', { name: 'Add participant' }));
    await ui.user.type(screen.getByRole('combobox', { name: /Search: Add participant/ }), 'Teammate 99');
    await ui.user.click(screen.getByRole('option', { name: 'Teammate 99' }));
    expect(ui.changed).toHaveBeenCalledExactlyOnceWith(['member-0', 'missing-member', 'member-99']);
    expect(screen.getByText('Teammate 99')).toBeVisible();
  });

  it('removes and restores a retained unavailable reference without inventing another person', async () => {
    const ui = example();
    await ui.user.click(screen.getByRole('button', { name: 'Remove Member unavailable' }));
    expect(ui.changed).toHaveBeenLastCalledWith(['member-0']);
    await ui.user.click(screen.getByRole('combobox', { name: 'Add participant' }));
    await ui.user.type(screen.getByRole('combobox', { name: /Search: Add participant/ }), 'unavailable');
    await ui.user.click(screen.getByRole('option', { name: 'Member unavailable' }));
    expect(ui.changed).toHaveBeenLastCalledWith(['member-0', 'missing-member']);
  });
});
