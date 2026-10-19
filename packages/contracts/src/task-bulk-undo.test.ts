import { describe, expect, it } from 'vitest';
import { bulkChangesForTask, bulkUpdateTasksInputSchema } from './tasks.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const a = id(1), b = id(2), projectId = id(3), fieldId = id(4);
const tasks = [{ taskId: a, expectedRevision: 2 }, { taskId: b, expectedRevision: 4 }];
describe('atomic inverse bulk contract', () => {
  it('keeps the legacy parsed body identical without defaults', () => {
    const body = { projectId, tasks, changes: { dueDate: null } };
    expect(JSON.stringify(bulkUpdateTasksInputSchema.parse(body))).toBe(JSON.stringify(body));
  });
  it('supports heterogeneous values and preserves null, zero, false and empty reference sets', () => {
    for (const value of [{ type: 'duration', value: 0 }, { type: 'boolean', value: false }, { type: 'multi_select', value: [] }, { type: 'text', value: null }]) {
      const body = { projectId, includeFieldValueAck: true, tasks: tasks.map(row => ({ ...row, expectedFieldValueRevision: 1 })), changes: { restore: tasks.map(row => ({ taskId: row.taskId, changes: { customField: { fieldId, expectedDefinitionRevision: 1, value } } })) } };
      const parsed = bulkUpdateTasksInputSchema.parse(body);
      expect(bulkChangesForTask(parsed, a).customField?.value).toEqual(value);
    }
  });
  it('requires an exact set, unique IDs and mutually exclusive uniform/restore patches', () => {
    const restore = [{ taskId: a, changes: { dueDate: null } }, { taskId: b, changes: { dueDate: '2030-01-02' } }];
    expect(bulkUpdateTasksInputSchema.safeParse({ projectId, tasks, changes: { restore } }).success).toBe(true);
    for (const changes of [{ restore: restore.slice(1) }, { restore: [restore[0], restore[0]] }, { restore, priority: 'high' }, { restore: [{ taskId: a, changes: {} }, restore[1]] }]) {
      expect(bulkUpdateTasksInputSchema.safeParse({ projectId, tasks, changes }).success).toBe(false);
    }
  });
  it('checks per-row independent guards and forbids unused guards', () => {
    const changes = { restore: [{ taskId: a, changes: { participantMembershipIds: [] } }, { taskId: b, changes: { estimateMinutes: 0 } }] };
    expect(bulkUpdateTasksInputSchema.safeParse({ projectId, tasks, changes }).success).toBe(false);
    const guarded = [{ ...tasks[0], expectedParticipantsRevision: 2 }, { ...tasks[1], expectedWorkPackageRevision: 3 }];
    expect(bulkUpdateTasksInputSchema.safeParse({ projectId, tasks: guarded, changes }).success).toBe(true);
    expect(bulkUpdateTasksInputSchema.safeParse({ projectId, tasks: guarded.map(row => ({ ...row, expectedFieldValueRevision: 0 })), changes }).success).toBe(false);
  });
  it('canonicalizes task and field IDs in restore and rejects nonboolean ACK opt-ins', () => {
    const body = { projectId, tasks: [{ taskId: a, expectedRevision: 1, expectedFieldValueRevision: 0 }], changes: { restore: [{ taskId: a, changes: { customField: { fieldId, expectedDefinitionRevision: 1, value: { type: 'number', value: 0 } } } }] } };
    expect(bulkUpdateTasksInputSchema.parse(body).changes.restore?.[0]?.taskId).toBe(a);
    expect(bulkUpdateTasksInputSchema.safeParse({ ...body, includeFieldValueAck: false }).success).toBe(false);
  });
});
