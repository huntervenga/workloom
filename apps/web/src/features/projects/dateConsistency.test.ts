import { describe, expect, it } from 'vitest';
import { completedDateIssues } from './dateConsistency';

const statuses = [{ id: 'todo', group: 'todo' as const }, { id: 'done', group: 'done' as const }, { id: 'no', group: 'cancelled' as const }];
const task = (id: string, dueDate: string | null, statusId = 'done', archivedAt: string | null = null) => ({ id, dueDate, statusId, archivedAt });
const project = { dateRange: { from: '2026-01-01', to: '2026-01-14' } };

describe('completed tasks and the project dates', () => {
  it('flags a finished task with no due date, or one before or after the project dates', () => {
    const issues = completedDateIssues(project, [task('a', '2026-01-05'), task('b', null), task('c', '2026-01-20'), task('d', '2025-12-31'), task('e', '2026-01-01'), task('f', '2026-01-14')], statuses);
    expect(issues).toEqual([{ taskId: 'b', kind: 'missing', finished: true }, { taskId: 'c', kind: 'after', finished: true }, { taskId: 'd', kind: 'before', finished: true }]);
  });
  it('ignores dated open tasks, cancelled tasks and archived tasks', () => {
    expect(completedDateIssues(project, [task('a', '2027-06-01', 'todo'), task('b', '2027-01-01', 'no'), task('c', null, 'done', '2026-01-02T00:00:00Z'), task('d', null, 'no')], statuses)).toEqual([]);
  });
  it('checks nothing for a project without dates', () => {
    expect(completedDateIssues({ dateRange: null }, [task('a', null)], statuses)).toEqual([]);
    expect(completedDateIssues({}, [task('a', null)], statuses)).toEqual([]);
  });
});
