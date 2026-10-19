import type { GenericComparisonDto, GenericGroupResultDto, GenericMeasureResultDto, GenericReportResultDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { personMetrics } from './dashboardMetrics';
import { amount, coverage, fact, plan, result } from './test/fixtures';

type Capacity = NonNullable<GenericReportResultDto['capacity']>;
type Member = Capacity['members'][number];
const ANNA = 'a1000000-0000-4000-8000-000000000001', BORIS = 'a1000000-0000-4000-8000-000000000002', CHEN = 'a1000000-0000-4000-8000-000000000003', DANA = 'a1000000-0000-4000-8000-000000000004';

const sum = (key: string, fieldId: string, value: number): GenericMeasureResultDto => ({ key, operation: 'sum', fieldId, unit: 'minutes', value: amount(value), coverage });
const pair = (planValue: number, factValue: number): GenericComparisonDto => ({ eligibleTasks: 2, pairedTasks: 1, plan: amount(planValue), fact: amount(factValue), difference: amount(factValue - planValue), ratio: null, unavailableReason: null, planCoverage: coverage, factCoverage: coverage });
const group = (key: string, label: string, taskCount: number, measures: GenericMeasureResultDto[], comparison: GenericComparisonDto | null = null): GenericGroupResultDto => ({ key, label, taskCount, measures, comparison, initialComparison: null });
const member = (membershipId: string, scheduleKnown: boolean, scheduledMinutes: number, absenceMinutes: number, availableMinutes: number): Member => ({ membershipId, displayName: membershipId, scheduleKnown, scheduledMinutes, holidayMinutes: 0, absenceMinutes, availableMinutes });
const capacity = (members: Member[], settingsConfigured = true): Capacity => ({ startDate: '2026-10-05', endDate: '2026-10-09', settingsConfigured, sourceVersion: 'c'.repeat(64), days: [], intervals: [], companyHolidays: [], inputVersions: { settingsRevision: 1, profiles: [], requests: [] }, members, totals: { scheduledMinutes: 2400, holidayMinutes: 0, absenceMinutes: 480, availableMinutes: 1920, unconfiguredMembers: 0 } });

/** Fixture report grouped by assignee with full-scope SUM measures for plan and fact; the fixture's loaded detail row is kept. */
function byAssignee(groups: GenericGroupResultDto[], authorized?: Capacity): GenericReportResultDto {
  const base = result();
  return { ...base, config: { ...base.config, groupBy: { kind: 'assignee' }, measures: [{ key: 'budget', operation: 'sum', fieldId: plan.id }, { key: 'spent', operation: 'sum', fieldId: fact.id }] }, groups, ...(authorized ? { capacity: authorized } : {}) };
}

describe('personMetrics', () => {
  it('takes plan and fact from full-scope group sums, not the paired comparison or loaded rows', () => {
    const anna = group(ANNA, 'Anna', 3, [sum('budget', plan.id, 600), sum('spent', fact.id, 800)], pair(100, 200));
    expect(personMetrics(byAssignee([anna]))).toEqual([{ key: ANNA, label: 'Anna', taskCount: 3, plan: amount(600), fact: amount(800), capacityMinutes: null, comparison: pair(100, 200) }]);
  });

  it('uses the member available minutes: a 40h week minus 8h absence is 1920', () => {
    const rows = personMetrics(byAssignee([group(ANNA, 'Anna', 1, [])], capacity([member(ANNA, true, 2400, 480, 1920)])));
    expect(rows.map(row => [row.key, row.capacityMinutes])).toEqual([[ANNA, 1920]]);
  });

  it('keeps a known zero schedule as 0 and an unknown schedule as null', () => {
    const rows = personMetrics(byAssignee([group(BORIS, 'Boris', 2, []), group(CHEN, 'Chen', 2, [])], capacity([member(BORIS, true, 0, 0, 0), member(CHEN, false, 0, 0, 0)])));
    expect(rows.map(row => [row.key, row.capacityMinutes])).toEqual([[BORIS, 0], [CHEN, null]]);
  });

  it('appends configured capacity members without tasks as zero-task rows with null plan and fact', () => {
    const rows = personMetrics(byAssignee([group(ANNA, 'Anna', 4, [sum('budget', plan.id, 600)])], capacity([member(ANNA, true, 2400, 0, 2400), member(CHEN, true, 2400, 480, 1920), member(BORIS, false, 0, 0, 0)])));
    expect(rows).toEqual([
      { key: ANNA, label: 'Anna', taskCount: 4, plan: amount(600), fact: null, capacityMinutes: 2400, comparison: null },
      { key: CHEN, label: '', taskCount: 0, plan: null, fact: null, capacityMinutes: 1920, comparison: null },
      { key: BORIS, label: '', taskCount: 0, plan: null, fact: null, capacityMinutes: null, comparison: null },
    ]);
  });

  it('keeps unassigned and former-member groups and matches capacity by ID, never by label', () => {
    const rows = personMetrics(byAssignee([group('unassigned', 'Unassigned', 2, [sum('spent', fact.id, 90)]), group(DANA, 'Anna', 1, [])], capacity([member(ANNA, true, 2400, 480, 1920)])));
    expect(rows).toEqual([
      { key: 'unassigned', label: 'Unassigned', taskCount: 2, plan: null, fact: amount(90), capacityMinutes: null, comparison: null },
      { key: DANA, label: 'Anna', taskCount: 1, plan: null, fact: null, capacityMinutes: null, comparison: null },
      { key: ANNA, label: '', taskCount: 0, plan: null, fact: null, capacityMinutes: 1920, comparison: null },
    ]);
  });

  it('keeps authorized capacity-only members visible with unknown capacity when settings are unconfigured', () => {
    const rows = personMetrics(byAssignee([group(ANNA, 'Anna', 1, [])], capacity([member(ANNA, true, 2400, 480, 1920), member(CHEN, true, 2400, 0, 2400)], false)));
    expect(rows.map(row => [row.key, row.capacityMinutes])).toEqual([[ANNA, null], [CHEN, null]]);
  });

  it('adds no capacity rows when the capacity DTO is not included', () => {
    expect(personMetrics(byAssignee([group(ANNA, 'Anna', 1, [])]))).toEqual([{ key: ANNA, label: 'Anna', taskCount: 1, plan: null, fact: null, capacityMinutes: null, comparison: null }]);
  });

  it('leaves plan and fact null when no matching sum measure exists, instead of 0 or the paired values', () => {
    const avg: GenericMeasureResultDto = { key: 'spentAvg', operation: 'avg', fieldId: fact.id, unit: 'minutes', value: amount(50), coverage };
    const [row] = personMetrics(byAssignee([group(ANNA, 'Anna', 2, [avg], pair(100, 200))]));
    expect(row).toMatchObject({ plan: null, fact: null, comparison: pair(100, 200) });
  });

  it('leaves plan and fact null when the report has no comparison fields', () => {
    const report = byAssignee([group(ANNA, 'Anna', 2, [sum('budget', plan.id, 600), sum('spent', fact.id, 800)])]);
    const [row] = personMetrics({ ...report, config: { ...report.config, comparison: null } });
    expect(row).toMatchObject({ plan: null, fact: null });
  });

  it('returns no rows unless the result is grouped by assignee', () => {
    const report = byAssignee([group(ANNA, 'Anna', 2, [sum('budget', plan.id, 600)])], capacity([member(CHEN, true, 2400, 0, 2400)]));
    expect(personMetrics({ ...report, config: { ...report.config, groupBy: { kind: 'none' } } })).toEqual([]);
    expect(personMetrics({ ...report, config: { ...report.config, groupBy: { kind: 'category', fieldId: plan.id } } })).toEqual([]);
  });
});
