import { describe, expect, it } from 'vitest';
import { makeTask } from '../task-table/taskTableFixtures';
import { pendingEditsOfBulk, withPendingEdit } from './pendingEdit';

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

  it('shows dates early, and status or assignee only where the view lets rows regroup, never the section', () => {
    const input = { expectedRevision: 1, statusId: 'next', sectionId: 'other', responsibleMembershipId: null, dueDate: '2026-10-30', startDate: '2026-10-28' };
    const plain = withPendingEdit(tasks, { taskId: 'a', input });
    expect(plain[0]).toMatchObject({ statusId: first.statusId, sectionId: first.sectionId, responsibleMembershipId: first.responsibleMembershipId, dueDate: '2026-10-30', startDate: '2026-10-28', title: 'Old' });
    const shown = withPendingEdit(tasks, { taskId: 'a', input }, [], { status: true, responsible: true });
    expect(shown[0]).toMatchObject({ statusId: 'next', responsibleMembershipId: null, sectionId: first.sectionId, dueDate: '2026-10-30' });
  });

  it('shows sent tags by name from the row or the catalog, drops unknown ids, and does not touch the stored tags', () => {
    const kept = { id: 'tag-kept', workspaceId: 'ws-1', name: 'Kept', color: null, revision: 1, archivedAt: null };
    const added = { ...kept, id: 'tag-new', name: 'New' };
    const tagged = makeTask({ id: 'c', tags: [kept] });
    const shown = withPendingEdit([tagged], { taskId: 'c', input: { expectedRevision: 1, tagIds: ['tag-kept', 'tag-new', 'tag-gone'] } }, [added]);
    expect(shown[0]?.tags.map(tag => tag.id)).toEqual(['tag-kept', 'tag-new']);
    expect(withPendingEdit([tagged], { taskId: 'c', input: { expectedRevision: 1, tagIds: [] } })[0]?.tags).toEqual([]);
    expect(tagged.tags).toEqual([kept]);
  });

  it('shows several pending edits at once, and a bulk update gives each of its tasks the sent priority and tags', () => {
    const tag = { id: 'tag-1', workspaceId: 'ws-1', name: 'One', color: null, revision: 1, archivedAt: null };
    const edits = pendingEditsOfBulk({ projectId: 'p', tasks: [{ taskId: 'a', expectedRevision: 1 }, { taskId: 'b', expectedRevision: 1 }], changes: { tagIds: ['tag-1'], priority: 'high' } });
    const shown = withPendingEdit(tasks, edits, [tag]);
    expect(shown.map(task => [task.priority, task.tags.map(t => t.id)])).toEqual([['high', ['tag-1']], ['high', ['tag-1']]]);
    expect(pendingEditsOfBulk({ projectId: 'p', tasks: [{ taskId: 'a', expectedRevision: 1 }], changes: { sectionId: 's' } })).toEqual([]);
    expect(pendingEditsOfBulk(null)).toEqual([]);
    expect(withPendingEdit(tasks, [])).toBe(tasks);
  });
});
