import type { PlanningPeriodDto, WeeklyPlanFactReportRunDto, WeeklyPlanFactSummaryDto, WorkTypeReportRunDto } from '@workloom/contracts';
import { alpha, anna } from '../../../test/fakeApi';
import { BASELINE_ID, PERIOD_A, PROJECT_ID, RUN_ID, period } from './fixtures';

/**
 * Independent five-person saved weekly report for presentation tests. Every summary field is a literal
 * server value; nothing here is derived from the people rows. Server order is neither by name nor by variance.
 */
export const AVERY = 'a7000000-0000-4000-8000-000000000001';
export const BLAIR = 'a7000000-0000-4000-8000-000000000002';
export const CASEY = 'a7000000-0000-4000-8000-000000000003';
export const DEVON = 'a7000000-0000-4000-8000-000000000004';
export const ELLIS = 'a7000000-0000-4000-8000-000000000005';
export const NICOSIA = 'Asia/Nicosia';
/** 2026-05-09 00:30 in Nicosia (UTC+3), still 2026-05-08 in UTC. */
export const CREATED_AT = '2026-05-08T21:30:00.000Z';
/** 2026-05-08 21:00 in Nicosia. */
export const AS_OF = '2026-05-08T18:00:00.000Z';

/** Sunday 2026-05-03 through Saturday 2026-05-09; 2026-05-10 is the exclusive end. */
export function nicosiaPeriod(): PlanningPeriodDto {
  return { ...period(), name: 'Week 19', localStart: '2026-05-03', localEndExclusive: '2026-05-10', timezone: NICOSIA, projectBaselineId: BASELINE_ID };
}

type Counts = { plan: number; known: number; plans: number; actual: number; recorded: number; facts: number; variance: number | null; percent: number | null; added: number; unplanned: number; total: number };

export function savedSummary(input: Counts): WeeklyPlanFactSummaryDto {
  return {
    knownPlannedMinutes: input.plan, actualMinutes: input.actual, missingEstimateCount: input.plans - input.known,
    baselineCompleteness: { knownItemCount: input.known, totalItemCount: input.plans, ratio: input.plans === 0 ? null : input.known / input.plans, complete: input.known === input.plans },
    factCoverage: { recordedItemCount: input.recorded, totalItemCount: input.facts, ratio: input.facts === 0 ? null : input.recorded / input.facts, complete: input.recorded === input.facts },
    totalVarianceMinutes: input.variance, totalVariancePercent: input.percent,
    addedActualMinutes: input.added, unplannedActualMinutes: input.unplanned, totalActualMinutes: input.total,
  };
}

/** Plan 120m, actual 150m: +30m, 25%. */
export const avery = { membershipId: AVERY, memberName: 'Avery', summary: savedSummary({ plan: 120, known: 1, plans: 1, actual: 150, recorded: 1, facts: 1, variance: 30, percent: 25, added: 0, unplanned: 0, total: 150 }) };
/** Plan 60m, a recorded active zero: −60m, −100%. */
export const blair = { membershipId: BLAIR, memberName: 'Blair', summary: savedSummary({ plan: 60, known: 1, plans: 1, actual: 0, recorded: 1, facts: 1, variance: -60, percent: -100, added: 0, unplanned: 0, total: 0 }) };
/** Plan 90m, actual hours missing: Not recorded, never 0m. */
export const casey = { membershipId: CASEY, memberName: 'Casey', summary: savedSummary({ plan: 90, known: 1, plans: 1, actual: 0, recorded: 0, facts: 1, variance: null, percent: null, added: 0, unplanned: 0, total: 0 }) };
/** Plan unknown, actual 45m. */
export const devon = { membershipId: DEVON, memberName: 'Devon', summary: savedSummary({ plan: 0, known: 0, plans: 1, actual: 45, recorded: 1, facts: 1, variance: null, percent: null, added: 0, unplanned: 0, total: 45 }) };
/** No original baseline rows: added 20m, unplanned 10m, all recorded 30m. */
export const ellis = { membershipId: ELLIS, memberName: 'Ellis', summary: savedSummary({ plan: 0, known: 0, plans: 0, actual: 0, recorded: 0, facts: 0, variance: null, percent: null, added: 20, unplanned: 10, total: 30 }) };

/** The server's overall aggregate, written out literally: known 270m, actual 195m, 3/4 and 3/4, all recorded 225m. */
export const overall = savedSummary({ plan: 270, known: 3, plans: 4, actual: 195, recorded: 3, facts: 4, variance: null, percent: null, added: 20, unplanned: 10, total: 225 });

/** The backend stores the effective people list, so membershipIds holds all five even for a default run. */
export function fiveReport(overrides: Partial<WeeklyPlanFactReportRunDto> = {}): WeeklyPlanFactReportRunDto {
  return {
    id: RUN_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, baselineId: BASELINE_ID, metricVersion: 'weekly_plan_fact_v1',
    createdAt: CREATED_AT, actorUserId: anna.id, factCutoffAt: AS_OF, factChangeSeq: '11', membershipIds: [DEVON, ELLIS, BLAIR, CASEY, AVERY], knownEstimatesOnly: false,
    cohort: { selectedItemCount: 4, originalItemCount: 4 }, summary: overall,
    byPerson: [devon, ellis, blair, casey, avery], rowCount: 9, workLogRevisionIds: [],
    ...overrides,
  };
}

/** Saved shares use the server denominator of 200m, which includes 50m uncategorized. */
export function workTypeRun(overrides: Partial<WorkTypeReportRunDto> = {}): WorkTypeReportRunDto {
  const development: WorkTypeReportRunDto['byCategory'][number] = { key: 'dev', fieldId: 'd7000000-0000-4000-8000-000000000001', optionId: 'd8000000-0000-4000-8000-000000000001', label: 'Development', color: null, minutes: 150, sharePercent: 75 };
  const uncategorized: WorkTypeReportRunDto['byCategory'][number] = { key: 'uncategorized', fieldId: null, optionId: null, label: 'stored label is not shown', color: null, minutes: 50, sharePercent: 25 };
  return {
    id: RUN_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, metricVersion: 'weekly_work_type_v1',
    createdAt: CREATED_AT, actorUserId: anna.id, factCutoffAt: AS_OF, factChangeSeq: '11', membershipIds: [CASEY, AVERY],
    totalActualMinutes: 200, activeSourceCount: 4, categorizedMinutes: 150, uncategorizedMinutes: 50,
    byCategory: [development, uncategorized],
    byPerson: [
      { membershipId: CASEY, memberName: 'Casey', totalActualMinutes: 0, activeSourceCount: 0, byCategory: [] },
      { membershipId: AVERY, memberName: 'Avery', totalActualMinutes: 200, activeSourceCount: 4, byCategory: [development, uncategorized] },
    ],
    rowCount: 4, workLogRevisionIds: [], labelPolicy: 'highest_option_revision_then_change_seq_then_id',
    ...overrides,
  };
}
