import { describe, expect, it } from 'vitest';
import { makeTask } from '../task-table/taskTableFixtures';
import { withPendingEdit } from './pendingEdit';

describe('withPendingEdit', () => {
  const first = makeTask({ id: 'a', title: 'Old', position: 0 });
  const second = makeTask({ id: 'b', title: 'Other', position: 1 });
  const tasks = [first, second];

  it('returns the very same list when nothing is pending or the task is not in it', () => {
    expect(withPendingEdit(tasks, null)).toBe(tasks);
    expect(withPendingEdit(tasks, { taskId: 'missing', input: { expectedRevision: 1, title: 'x' } })).toBe(tasks);
  });

  it('shows the sent display fields on that row only and leaves the stored task untouched', () => {
    const shown = withPendingEdit(tasks, { taskId: 'a', input: { expectedRevision: 1, title: 'New', priority: 'high' } });
    expect(shown[0]).toMatchObject({ id: 'a', title: 'New', priority: 'high', revision: first.revision });
    expect(shown[1]).toBe(second);
    expect(first.title).toBe('Old');
  });

  it('leaves fields that regroup rows or keep their own draft to the confirmed answer', () => {
    const shown = withPendingEdit(tasks, { taskId: 'a', input: { expectedRevision: 1, statusId: 'next', sectionId: 'other', responsibleMembershipId: null, dueDate: '2026-10-30' } });
    expect(shown[0]).toMatchObject({ statusId: first.statusId, sectionId: first.sectionId, responsibleMembershipId: first.responsibleMembershipId, dueDate: first.dueDate, title: 'Old' });
  });
});
