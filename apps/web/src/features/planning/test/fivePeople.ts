import type { WeeklyPlanFactReportRunDto, WeeklyPlanFactSummaryDto, WorkTypeReportRunDto } from '@workloom/contracts';
import { alpha, anna } from '../../../test/fakeApi';
import { BASELINE_ID, PERIOD_A, PROJECT_ID, RUN_ID, period } from './fixtures';

/** Report-specific five-person snapshot. Server order is deliberately neither alphabetical nor by variance. */
export const ALICE = 'c1000000-0000-4000-8000-000000000002';
export const BEATRIZ = 'c1000000-0000-4000-8000-000000000004';
export const CHEN = 'c1000000-0000-4000-8000-000000000003';
export const DMITRI = 'c1000000-0000-4000-8000-000000000001';
export const ERIK = 'c1000000-0000-4000-8000-000000000005';
export const CREATED = '2026-10-19T13:30:00.000Z';
export const AS_OF = '2026-10-19T12:00:00.000Z';

/** A zone that differs from the host running the test, so period-zone formatting is observable. */
export const REPORT_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone === 'Pacific/Auckland' ? 'America/Los_Angeles' : 'Pacific/Auckland';
export function zonedPeriod() { return { ...period(), timezone: REPORT_ZONE, projectBaselineId: BASELINE_ID }; }

function personSummary(input: { known: [number, number]; plan: number; recorded: [number, number]; actual: number; variance: number | null; percent: number | null; added: number; unplanned: number; total: number }): WeeklyPlanFactSummaryDto {
  const [knownItemCount, planItems] = input.known;
  const [recordedItemCount, factItems] = input.recorded;
  return {
    knownPlannedMinutes: input.plan, actualMinutes: input.actual, missingEstimateCount: planItems - knownItemCount,
    baselineCompleteness: { knownItemCount, totalItemCount: planItems, ratio: planItems === 0 ? null : knownItemCount / planItems, complete: knownItemCount === planItems },
    factCoverage: { recordedItemCount, totalItemCount: factItems, ratio: factItems === 0 ? null : recordedItemCount / factItems, complete: recordedItemCount === factItems },
    totalVarianceMinutes: input.variance, totalVariancePercent: input.percent,
    addedActualMinutes: input.added, unplannedActualMinutes: input.unplanned, totalActualMinutes: input.total,
  };
}

export const dmitri = { membershipId: DMITRI, memberName: 'Dmitri', summary: personSummary({ known: [2, 2], plan: 600, recorded: [2, 2], actual: 720, variance: 120, percent: 20, added: 0, unplanned: 30, total: 750 }) };
/** No known plan, but a recorded active zero: plan Not known, actual 0m. */
export const alice = { membershipId: ALICE, memberName: 'Alice', summary: personSummary({ known: [0, 1], plan: 0, recorded: [1, 1], actual: 0, variance: null, percent: null, added: 60, unplanned: 0, total: 60 }) };
/** Added/unplanned only: no baseline rows at all. */
export const chen = { membershipId: CHEN, memberName: 'Chen', summary: personSummary({ known: [0, 0], plan: 0, recorded: [0, 0], actual: 0, variance: null, percent: null, added: 240, unplanned: 15, total: 255 }) };
/** Known zero plan: a difference exists, a percentage does not. */
export const beatriz = { membershipId: BEATRIZ, memberName: 'Beatriz', summary: personSummary({ known: [1, 1], plan: 0, recorded: [1, 1], actual: 90, variance: 90, percent: null, added: 0, unplanned: 0, total: 90 }) };
/** Known plan, nothing recorded. */
export const erik = { membershipId: ERIK, memberName: 'Erik', summary: personSummary({ known: [1, 1], plan: 300, recorded: [0, 1], actual: 0, variance: null, percent: null, added: 0, unplanned: 0, total: 0 }) };

export const serverSummary = personSummary({ known: [4, 5], plan: 900, recorded: [4, 5], actual: 810, variance: null, percent: null, added: 300, unplanned: 45, total: 1155 });

export function fivePersonReport(overrides: Partial<WeeklyPlanFactReportRunDto> = {}): WeeklyPlanFactReportRunDto {
  return {
    id: RUN_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, baselineId: BASELINE_ID, metricVersion: 'weekly_plan_fact_v1',
    createdAt: CREATED, actorUserId: anna.id, factCutoffAt: AS_OF, factChangeSeq: '7', membershipIds: [], knownEstimatesOnly: false,
    cohort: { selectedItemCount: 5, originalItemCount: 5 }, summary: serverSummary,
    byPerson: [dmitri, erik, chen, alice, beatriz], rowCount: 12, workLogRevisionIds: [],
    ...overrides,
  };
}

/** Uncategorized minutes are part of the server share denominator (400m = 300m categorized + 100m uncategorized). */
export function twoPersonWorkTypeReport(): WorkTypeReportRunDto {
  const development: WorkTypeReportRunDto['byCategory'][number] = { key: 'dev', fieldId: 'd1000000-0000-4000-8000-000000000001', optionId: 'd2000000-0000-4000-8000-000000000001', label: 'Development', color: null, minutes: 300, sharePercent: 75 };
  const uncategorized: WorkTypeReportRunDto['byCategory'][number] = { key: 'uncategorized', fieldId: null, optionId: null, label: 'stored label is not shown', color: null, minutes: 100, sharePercent: 25 };
  return {
    id: RUN_ID, workspaceId: alpha.id, projectId: PROJECT_ID, periodId: PERIOD_A, metricVersion: 'weekly_work_type_v1',
    createdAt: CREATED, actorUserId: anna.id, factCutoffAt: AS_OF, factChangeSeq: '7', membershipIds: [ERIK, ALICE],
    totalActualMinutes: 400, activeSourceCount: 6, categorizedMinutes: 300, uncategorizedMinutes: 100,
    byCategory: [development, uncategorized],
    byPerson: [
      { membershipId: ERIK, memberName: 'Erik', totalActualMinutes: 0, activeSourceCount: 0, byCategory: [] },
      { membershipId: ALICE, memberName: 'Alice', totalActualMinutes: 400, activeSourceCount: 6, byCategory: [development, uncategorized] },
    ],
    rowCount: 6, workLogRevisionIds: [], labelPolicy: 'highest_option_revision_then_change_seq_then_id',
  };
}
