import { describe, expect, it } from 'vitest';
import type { TaskStatusDto } from '@workloom/contracts';
import { task } from '../planning/test/fixtures';
import { taskCompletion } from './taskCompletion';
const base: TaskStatusDto = { id: task.statusId, workspaceId: task.workspaceId, projectId: task.projectId, name: 'Stored active', group: 'todo', position: 0, revision: 1 };
const done: TaskStatusDto = { ...base, id: 'f6000000-0000-4000-8000-000000000002', name: 'Stored done', group: 'done', position: 1 };
describe('task completion choices', () => {
  it('only uses own-project known status identities and never guesses from names', () => {
    expect(taskCompletion(task, [base]).choices).toEqual([]);
    expect(taskCompletion(task, [base, done]).direct).toBe(true);
    expect(taskCompletion(task, [base, done, { ...done, id: 'second' }]).direct).toBe(false);
    expect(taskCompletion(task, [base, { ...done, projectId: 'foreign' }]).choices).toEqual([]);
    expect(taskCompletion(task, [{ ...done, name: 'Todo' }]).eligible).toBe(false);
  });
  it('requires an explicit active choice for done or cancelled, never an inferred prior status', () => {
    for (const group of ['done', 'cancelled'] as const) {
      const result = taskCompletion({ ...task, statusId: done.id }, [base, { ...done, group }]);
      expect(result.reopening).toBe(true); expect(result.direct).toBe(false); expect(result.choices).toEqual([base]);
      expect(result.completed).toBe(group === 'done');
    }
  });
  it.each([{ ...task, archivedAt: task.createdAt }, { ...task, meetingId: 'meeting' }, { ...task, meetingId: undefined }])('rejects nonordinary or archived task types', row => {
    expect(taskCompletion(row, [base, done]).eligible).toBe(false);
  });
});
