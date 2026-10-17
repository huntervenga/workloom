import { describe, expect, it } from 'vitest';
import { bulkUpdateTasksInputSchema, moveTaskInputSchema } from './tasks.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const move = { expectedRevision: 2, anchorTaskId: id(1), placement: 'after' as const };
const bulk = { projectId: id(1), tasks: [{ taskId: id(2), expectedRevision: 1 }], changes: { dueDate: null } };
describe('atomic assignee move and bulk contracts', () => {
  it('preserves the exact old move shape without an assignee default', () => {
    expect(moveTaskInputSchema.parse(move)).toEqual(move);
    expect(Object.hasOwn(moveTaskInputSchema.parse(move), 'responsibleMembershipId')).toBe(false);
    expect(moveTaskInputSchema.parse({ ...move, responsibleMembershipId: null }).responsibleMembershipId).toBeNull();
  });
  it('allows a null anchor only for explicit assignee group-end after', () => {
    for (const responsibleMembershipId of [null, id(4)]) expect(moveTaskInputSchema.parse({ ...move, anchorTaskId: null, responsibleMembershipId }).anchorTaskId).toBeNull();
    for (const body of [{ ...move, anchorTaskId: null }, { ...move, anchorTaskId: null, responsibleMembershipId: null, placement: 'before' }]) expect(moveTaskInputSchema.safeParse(body).success).toBe(false);
  });
  it('keeps absent fields distinct from explicit null and rejects empty or unknown bulk patches', () => {
    const parsed = bulkUpdateTasksInputSchema.parse(bulk);
    expect(parsed).toEqual(bulk);
    expect(Object.keys(parsed.changes)).toEqual(['dueDate']);
    for (const changes of [{}, { participantMembershipIds: [] }, { position: 0 }, { statusId: id(4) }]) expect(bulkUpdateTasksInputSchema.safeParse({ ...bulk, changes }).success).toBe(false);
    expect(bulkUpdateTasksInputSchema.safeParse({ ...bulk, actor: id(5) }).success).toBe(false);
  });
  it('requires one to100 unique canonical task IDs and actual date-only values', () => {
    for (const tasks of [[], Array.from({ length: 101 }, (_, i) => ({ taskId: id(i + 10), expectedRevision: 1 })), [bulk.tasks[0], bulk.tasks[0]]]) expect(bulkUpdateTasksInputSchema.safeParse({ ...bulk, tasks }).success).toBe(false);
    expect(bulkUpdateTasksInputSchema.safeParse({ ...bulk, tasks: Array.from({ length: 100 }, (_, i) => ({ taskId: id(i + 10), expectedRevision: 1 })) }).success).toBe(true);
    for (const dueDate of ['2026-02-30', '2026-10-19T00:00:00Z', 1]) expect(bulkUpdateTasksInputSchema.safeParse({ ...bulk, changes: { dueDate } }).success).toBe(false);
  });
});
