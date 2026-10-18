import { describe, expect, it } from 'vitest';
import { weeklyPlanFactRowSchema } from './planning.js';
const id = '5eed0000-0000-4000-8000-000000000001';
const old = { id: 'row', scope: 'original', commitmentId: id, workPackageId: id, membershipId: id, title: 'Saved work', memberName: 'Saved person', plannedMinutes: 60, actualMinutes: 0, factRecorded: false, varianceMinutes: null, packageEstimateMinutes: null, packageBaselineId: null, taskIds: [id], workLogs: [] };
describe('optional pinned completion projection', () => {
  it('preserves the exact old row serialization without injecting completion', () => {
    const parsed = weeklyPlanFactRowSchema.parse(old);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(old));
    expect(Object.hasOwn(parsed, 'completionAtCalculation')).toBe(false);
  });
  it('retains a versioned captured rule and rejects an unknown rule or negative census', () => {
    expect(weeklyPlanFactRowSchema.parse({ ...old, completionAtCalculation: { rule: 'all_nonarchived_package_tasks_v1', state: 'done', taskCount: 2 } }).completionAtCalculation?.state).toBe('done');
    expect(weeklyPlanFactRowSchema.safeParse({ ...old, completionAtCalculation: { rule: 'guessed_current_state', state: 'done', taskCount: 2 } }).success).toBe(false);
    expect(weeklyPlanFactRowSchema.safeParse({ ...old, completionAtCalculation: { rule: 'all_nonarchived_package_tasks_v1', state: 'done', taskCount: -1 } }).success).toBe(false);
  });
});
