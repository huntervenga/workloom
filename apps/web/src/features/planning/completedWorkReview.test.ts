import type { WeeklyPlanFactRowDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { completedWorkReview } from './completedWorkReview';
const row = (patch: Partial<WeeklyPlanFactRowDto> = {}): WeeklyPlanFactRowDto => ({ id: 'row', scope: 'original', commitmentId: null, workPackageId: 'package', membershipId: 'member', title: 'Work', memberName: 'Person', plannedMinutes: 60, actualMinutes: 0, factRecorded: true, varianceMinutes: -60, packageEstimateMinutes: 180, packageBaselineId: null, taskIds: ['task'], workLogs: [], completionAtCalculation: { rule: 'all_nonarchived_package_tasks_v1', state: 'done', taskCount: 1 }, ...patch });
describe('completed personal-plan review', () => {
  it('distinguishes completed recorded zero from missing work', () => {
    expect(completedWorkReview(row())).toEqual({ state: 'completed', deltaMinutes: -60, actualToPlanRatio: 0 });
    expect(completedWorkReview(row({ factRecorded: false }))).toEqual({ state: 'unreported' });
  });
  it('never judges ongoing work as overestimated because its actual is zero or missing', () => {
    const completionAtCalculation = { rule: 'all_nonarchived_package_tasks_v1' as const, state: 'not_done' as const, taskCount: 2 };
    expect(completedWorkReview(row({ completionAtCalculation }))).toEqual({ state: 'in_progress' });
    expect(completedWorkReview(row({ completionAtCalculation, factRecorded: false }))).toEqual({ state: 'unreported' });
  });
  it('keeps old rows and unknown personal plans unknown, without substituting the package budget', () => {
    expect(completedWorkReview(row({ completionAtCalculation: undefined }))).toEqual({ state: 'unknown_completion' });
    expect(completedWorkReview(row({ plannedMinutes: null }))).toEqual({ state: 'unknown_plan' });
    expect(completedWorkReview(row({ actualMinutes: 90 }))).toMatchObject({ deltaMinutes: 30, actualToPlanRatio: 1.5 });
  });
  it('has no ratio for a zero plan and never assesses added work as original', () => {
    expect(completedWorkReview(row({ plannedMinutes: 0 }))).toMatchObject({ actualToPlanRatio: null });
    expect(completedWorkReview(row({ scope: 'added_scope' }))).toEqual({ state: 'not_original' });
  });
});
