import {
  createRecurrenceSeriesInputSchema,
  recurrenceCreatePreviewInputSchema,
  recurrenceCreatePreviewSchema,
  recurrenceInstanceSchema,
  recurrenceMaterializationResultSchema,
  recurrenceReadinessSchema,
  recurrencePlannedCalendarSchema,
  recurrenceSeriesSchema,
  type CreateRecurrenceSeriesInput,
  type RecurrenceBindingProgressDto,
  type RecurrenceCandidateDto,
  type RecurrenceCreatePreviewDto,
  type RecurrenceCreatePreviewInput,
  type RecurrenceInstanceDto,
  type RecurrenceMaterializationResultDto,
  type RecurrenceReadinessDto,
  type RecurrencePlannedCalendarDto,
  type RecurrenceResolutionDto,
  type RecurrenceScheduleInput,
  type RecurrenceSeriesDto,
  type RecurrenceTemplateInput,
  type RecurrenceTimezoneProvenance,
} from '@workloom/contracts';
import { alpha, alphaMembers, anna } from '../../../test/fakeApi';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, STAMP, task } from '../../planning/test/fixtures';
import type { RecurrenceCreateDefaults } from '../useRecurrenceWorkspace';

/*
 * Test-only synthetic P3b DTOs. Every builder is typed by the frozen contract and parsed by its real
 * schema, so a fixture that drifts from the contract fails loudly instead of feeding a lenient test.
 * Nothing here is a resolver: dates and instants are hand-written for Europe/Moscow (+03:00, no DST).
 */

export const SERIES_ID = 'ab000000-0000-4000-8000-000000000001';
export const SERIES_B_ID = 'ab000000-0000-4000-8000-000000000002';
export const VERSION_ID = 'ab100000-0000-4000-8000-000000000001';
export const BINDING_ID = 'ab200000-0000-4000-8000-000000000001';
export const MEETING_ID = 'ab400000-0000-4000-8000-000000000001';
export const MEETING_TASK_ID = 'ab500000-0000-4000-8000-000000000001';
export const MEETING_PACKAGE_ID = 'ab600000-0000-4000-8000-000000000001';
export const STATUS_ID = task.statusId;
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
/** Explicitly chosen attendees; the organizer is listed because it was checked, not implicitly. */
export const ATTENDEE_IDS = alphaMembers.slice(0, 2).map((member) => member.id);
export const seriesListPath = `/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/recurrence-series`;
export const createPreviewPath = `/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/recurrence-preview`;
export const instancesPath = (seriesId = SERIES_ID) => `/api/v1/workspaces/${alpha.id}/recurrence-series/${seriesId}/instances`;
export const materializePath = (periodId: string) => `/api/v1/workspaces/${alpha.id}/periods/${periodId}/materialize-meetings`;
export const readinessPath = (periodId: string) => `/api/v1/workspaces/${alpha.id}/periods/${periodId}/recurrence-readiness`;

export const createDefaults: RecurrenceCreateDefaults = { timezone: alpha.timezone, statusId: STATUS_ID, organizerMembershipId: MEMBER_ID };

const provenance: RecurrenceTimezoneProvenance = { timezone: alpha.timezone, implementation: 'test-fixture', tzdataVersion: null, icuVersion: null };

export function scheduleInput(): RecurrenceScheduleInput {
  return {
    startDate: '2026-10-19',
    localTime: '10:00',
    timezone: alpha.timezone,
    frequency: 'weekly',
    weekdays: [1, 3],
    plannedDurationMinutes: 60,
    end: { kind: 'after_count', count: 4 },
  };
}

export function templateInput(): RecurrenceTemplateInput {
  return {
    title: 'Синхронизация серии',
    statusId: STATUS_ID,
    sectionId: null,
    organizerMembershipId: MEMBER_ID,
    attendeeMembershipIds: [...ATTENDEE_IDS],
    joinUrl: null,
  };
}

export function plannedCalendar(overrides: Partial<RecurrencePlannedCalendarDto> = {}): RecurrencePlannedCalendarDto {
  return recurrencePlannedCalendarSchema.parse({
    timezone: alpha.timezone,
    plannedDurationMinutes: 60,
    organizerMembershipId: MEMBER_ID,
    attendeeMembershipIds: [...ATTENDEE_IDS],
    ...overrides,
  });
}

export function createPreviewInput(targetPeriodIds: string[] = [PERIOD_A]): RecurrenceCreatePreviewInput {
  const value: RecurrenceCreatePreviewInput = { schedule: scheduleInput(), template: templateInput(), targetPeriodIds };
  return recurrenceCreatePreviewInputSchema.parse(value);
}

export function createInput(previewHash = HASH_A, preview: RecurrenceCreatePreviewInput = createPreviewInput()): CreateRecurrenceSeriesInput {
  const value: CreateRecurrenceSeriesInput = { ...preview, previewHash };
  return createRecurrenceSeriesInputSchema.parse(value);
}

/** 10:00 Moscow on `date`; a fixed +03:00 offset, so no gap/overlap warning. */
export function resolution(date: string): RecurrenceResolutionDto {
  return {
    policyVersion: 'first_valid_gap_earlier_overlap_v1',
    intendedLocalDate: date,
    intendedLocalTime: '10:00',
    resolvedStartAt: `${date}T07:00:00.000Z`,
    resolvedEndAt: `${date}T08:00:00.000Z`,
    resolvedLocalDate: date,
    resolvedLocalTime: '10:00',
    resolvedOffset: '+03:00',
    plannedDurationMinutes: 60,
    warning: null,
    provenance,
  };
}

/** Mon/Wed of two weeks: the first week is bound to `periodId`, the second has no chosen period. */
export function createPreview(previewHash = HASH_A, periodId = PERIOD_A): RecurrenceCreatePreviewDto {
  const dates = ['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28'];
  const candidates: RecurrenceCandidateDto[] = dates.map((date, index) => ({
    occurrenceKey: date,
    nominalSequence: index + 1,
    resolution: resolution(date),
    periodId: index < 2 ? periodId : null,
    collidesWithOccurrenceKeys: [],
  }));
  const value: RecurrenceCreatePreviewDto = {
    projectId: PROJECT_ID,
    previewHash,
    policyVersion: 'first_valid_gap_earlier_overlap_v1',
    provenance,
    counts: { nominalCount: 4, consumedNominalCount: 0, remainingNominalCount: 4, skippedCount: 0, cancelledCount: 0 },
    candidates,
    periods: [{ periodId, periodRevision: 1, candidateCount: 2 }],
    unboundCandidateCount: 2,
    warnings: [],
  };
  return recurrenceCreatePreviewSchema.parse(value);
}

/** A created series as the server answers it: bound periods are exactly the submitted ones. */
export function series(input: RecurrenceCreatePreviewInput = createPreviewInput(), id = SERIES_ID): RecurrenceSeriesDto {
  const value: RecurrenceSeriesDto = {
    id,
    workspaceId: alpha.id,
    projectId: PROJECT_ID,
    revision: 1,
    state: 'active',
    currentVersion: {
      id: VERSION_ID,
      seriesId: id,
      revision: 1,
      effectiveFromNominalDate: input.schedule.startDate,
      schedule: input.schedule,
      template: input.template,
      policyVersion: 'first_valid_gap_earlier_overlap_v1',
      actorUserId: anna.id,
      createdAt: STAMP,
      changeSeq: '1',
    },
    generation: { authorizationId: null, authorizationRevision: null, authorizerMembershipId: null, state: 'blocked', blockedCode: 'authorization_missing' },
    boundPeriodIds: [...input.targetPeriodIds],
    boundPeriodCount: input.targetPeriodIds.length,
    nominalCandidateCount: 4,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
  return recurrenceSeriesSchema.parse(value);
}

/**
 * A reserved header. Without `materialized` every real locator stays null: a header that exists
 * before materialization has no meeting, task or package identity.
 */
export function instance(occurrenceKey: string, options: { ordinal: number; materialized?: boolean; cancelled?: boolean }): RecurrenceInstanceDto {
  const materialized = options.materialized ?? false;
  const value: RecurrenceInstanceDto = {
    id: `ab300000-0000-4000-8000-${String(options.ordinal).padStart(12, '0')}`,
    workspaceId: alpha.id,
    projectId: PROJECT_ID,
    seriesId: SERIES_ID,
    bindingId: BINDING_ID,
    plannedPeriodId: PERIOD_A,
    occurrenceKey,
    nominalSequence: options.ordinal,
    sourceVersionId: VERSION_ID,
    revision: 1,
    calendarState: options.cancelled ? 'cancelled' : 'scheduled',
    meetingId: materialized ? MEETING_ID : null,
    taskId: materialized ? MEETING_TASK_ID : null,
    workPackageId: materialized ? MEETING_PACKAGE_ID : null,
    meetingRevision: materialized ? 1 : null,
    resolution: resolution(occurrenceKey),
    exception: options.cancelled
      ? { versionId: 'ab700000-0000-4000-8000-000000000001', revision: 1, kind: 'skip', reason: 'Праздник', actorUserId: anna.id, recordedAt: STAMP }
      : null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
  return recurrenceInstanceSchema.parse(value);
}

function progress(remainingCount: number, createdCount: number): RecurrenceBindingProgressDto {
  return {
    bindingId: BINDING_ID,
    seriesId: SERIES_ID,
    sourceManifestHash: HASH_A,
    state: remainingCount === 0 ? 'complete' : 'pending',
    createdCount,
    remainingCount,
    blockedCode: null,
  };
}

export function readiness(periodId: string, missingCount = 2): RecurrenceReadinessDto {
  const value: RecurrenceReadinessDto = {
    periodId,
    periodRevision: 1,
    state: missingCount === 0 ? 'complete' : 'pending',
    missingCount,
    blockedCount: 0,
    bindings: [progress(missingCount, 0)],
    truncated: false,
  };
  return recurrenceReadinessSchema.parse(value);
}

/** One chunk outcome; a non-null `nextCursor` is an opaque server token the caller may send later. */
export function materialization(periodId: string, options: { createdCount: number; remainingCount: number; nextCursor: string | null }): RecurrenceMaterializationResultDto {
  const value: RecurrenceMaterializationResultDto = {
    periodId,
    status: options.remainingCount === 0 ? 'complete' : 'pending',
    createdCount: options.createdCount,
    remainingCount: options.remainingCount,
    nextCursor: options.nextCursor,
    bindings: [progress(options.remainingCount, options.createdCount)],
    truncated: false,
    frozenBaselineIds: [],
  };
  return recurrenceMaterializationResultSchema.parse(value);
}
