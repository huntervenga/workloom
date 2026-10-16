import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import {manualPeriodWorkLogSchema,recordedWorkLogSchema} from './common/recorded-work.js';
import {meetingSnapshotSchema} from './common/meeting.js';
import {recurrenceSnapshotSectionSchema} from './common/recurrence.js';
export {manualPeriodWorkLogSchema} from './common/recorded-work.js';
import { taskFieldDefinitionSchema, taskFieldValueSchema } from './fields.js';
import { calendarDateSchema, minutesSchema, revisionSchema, taskSchema, utcTimestampSchema } from './tasks.js';
import { membershipSchema } from './workspaces.js';

/** P2a: weekly commitments, immutable freezes, period-precision work and pinned weekly reports.
 * See docs/13-p2a-contract.md for the exact HTTP catalog and boundary semantics.
 * All mutations are keyed and actor/workspace context is always server-trusted.
 */
const nameSchema = z.string().trim().min(1).max(160);
const reasonSchema = z.string().trim().min(1).max(1000);
const uniqueIds = z.array(idSchema).max(100).refine((ids) => new Set(ids).size === ids.length, 'Duplicate IDs.');
export const planningTimezoneSchema = z.string().min(1).max(100).refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; }
}, 'Expected an IANA time zone.');
export const planningPageQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(4096).optional(),
});
export const planningPeriodListQuerySchema = planningPageQuerySchema.extend({ projectId: idSchema });
export const periodCommitmentListQuerySchema = planningPageQuerySchema.extend({ membershipId: idSchema.optional() });
export const workLogListQuerySchema = planningPageQuerySchema.extend({
  periodId: idSchema,
  taskId: idSchema.optional(),
  membershipId: idSchema.optional(),
});
export const reportRunListQuerySchema = planningPageQuerySchema.extend({ periodId: idSchema });

export const planningPeriodSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, name: nameSchema,
  localStart: calendarDateSchema, localEndExclusive: calendarDateSchema,
  timezone: planningTimezoneSchema, cutoffAt: utcTimestampSchema,
  state: z.enum(['planning', 'frozen']), revision: revisionSchema,
  protectedFieldIds: uniqueIds, protectEstimate: z.boolean(),
  projectBaselineId: idSchema.nullable(), createdAt: utcTimestampSchema, updatedAt: utcTimestampSchema,
});
export const createPlanningPeriodInputSchema = z.strictObject({
  projectId: idSchema, name: nameSchema, localStart: calendarDateSchema,
  timezone: planningTimezoneSchema, cutoffAt: utcTimestampSchema,
  protectedFieldIds: uniqueIds.default([]), protectEstimate: z.boolean().default(true),
});
export const updatePlanningPeriodInputSchema = z.strictObject({
  expectedRevision: revisionSchema, name: nameSchema.optional(), cutoffAt: utcTimestampSchema.optional(),
  protectedFieldIds: uniqueIds.optional(), protectEstimate: z.boolean().optional(),
}).refine((v) => v.name !== undefined || v.cutoffAt !== undefined || v.protectedFieldIds !== undefined || v.protectEstimate !== undefined, 'Provide a change.');

export const commitmentAllocationSchema = z.object({ taskId: idSchema, minutes: minutesSchema });
const allocationsSchema = z.array(commitmentAllocationSchema).max(100).refine((values) => new Set(values.map((v) => v.taskId)).size === values.length, 'Duplicate task allocation.');
export const periodCommitmentSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, periodId: idSchema,
  workPackageId: idSchema, membershipId: idSchema,
  plannedMinutes: minutesSchema.nullable(), allocations: allocationsSchema,
  unallocatedMinutes: minutesSchema.nullable(), state: z.enum(['active', 'removed']),
  revision: revisionSchema, classification: z.enum(['planned', 'added']),
  baselineIds: z.array(idSchema), createdAt: utcTimestampSchema, updatedAt: utcTimestampSchema,
});
export const createPeriodCommitmentInputSchema = z.strictObject({
  workPackageId: idSchema, membershipId: idSchema,
  expectedAbsent: z.literal(true), plannedMinutes: minutesSchema.nullable(), allocations: allocationsSchema.default([]),
});
export const updatePeriodCommitmentInputSchema = z.strictObject({
  expectedRevision: revisionSchema, plannedMinutes: minutesSchema.nullable(),
  allocations: allocationsSchema, state: z.enum(['active', 'removed']),
});

/** Whole-package current values; one row per package, never multiplied by participants/children. */
export const planningPackageSchema = z.object({
  id: idSchema, projectId: idSchema, revision: revisionSchema,
  estimateMinutes: minutesSchema.nullable(), createdAt: utcTimestampSchema,
  packageBaselineId: idSchema.nullable(), title: z.string(),
});
export const planningPackageListQuerySchema = planningPageQuerySchema.extend({ projectId: idSchema });
export const packageBaselineSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, workPackageId: idSchema,
  estimateMinutes: minutesSchema, sourcePackageRevision: revisionSchema,
  acceptedAt: utcTimestampSchema, sourceBaselineId: idSchema,
  provenance: z.literal('first_known_plan_freeze'),
});
export const snapshotFieldValueSchema = z.object({
  taskId: idSchema, fieldId: idSchema,
  /** null means no row; a present typed-null remains a complete TaskFieldValueDto. */
  value: taskFieldValueSchema.nullable(),
});
export const planningSnapshotSchema = z.object({
  schemaVersion: z.literal(1), period: planningPeriodSchema,
  commitments: z.array(periodCommitmentSchema), packages: z.array(planningPackageSchema),
  /** All package IDs already present in the project, including work with no commitment. */
  projectPackageIds: z.array(idSchema),
  tasks: z.array(taskSchema), memberships: z.array(membershipSchema),
  fieldDefinitions: z.array(taskFieldDefinitionSchema), fieldValues: z.array(snapshotFieldValueSchema),
  sourcePersonalBaselineIds: z.array(idSchema),
  /** Optional without default: historical pinned JSON remains unchanged. */
  meetings:z.array(meetingSnapshotSchema).optional(),
  /** P3b calendar-only recurrence census; optional without default, never a personal plan or minute cohort. */
  recurrence:recurrenceSnapshotSectionSchema.optional(),
});
export const freezeScopeSchema = z.enum(['self', 'project']);
export const freezePreviewInputSchema = z.strictObject({ scope: freezeScopeSchema });
export const freezePreviewSchema = z.object({
  periodId: idSchema, scope: freezeScopeSchema, membershipId: idSchema.nullable(),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/), snapshot: planningSnapshotSchema,
  existingBaselineId: idSchema.nullable(),
});
export const freezePlanInputSchema = z.strictObject({
  scope: freezeScopeSchema, previewHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const planBaselineSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, periodId: idSchema,
  scope: freezeScopeSchema, membershipId: idSchema.nullable(),
  mode: z.enum(['manual', 'cutoff']), requestedCutoffAt: utcTimestampSchema,
  frozenAt: utcTimestampSchema, actorUserId: idSchema, source: z.enum(['web', 'api', 'mcp', 'job', 'import']),
  changeSeq: z.string().regex(/^[1-9][0-9]*$/), snapshot: planningSnapshotSchema,
});

export const setManualPeriodWorkInputSchema = z.strictObject({
  expectedRevision: revisionSchema.nullable(), minutes: minutesSchema,
  state: z.enum(['active', 'void']).default('active'), reason: reasonSchema.nullable().optional().default(null),
});

export const completenessSchema = z.object({
  knownItemCount: z.number().int().nonnegative(), totalItemCount: z.number().int().nonnegative(),
  ratio: z.number().min(0).max(1).nullable(), complete: z.boolean(),
});
export const factCoverageSchema = z.object({
  recordedItemCount: z.number().int().nonnegative(), totalItemCount: z.number().int().nonnegative(),
  ratio: z.number().min(0).max(1).nullable(), complete: z.boolean(),
});
export const weeklyPlanFactSummarySchema = z.object({
  knownPlannedMinutes: z.number().int().nonnegative(), actualMinutes: z.number().int().nonnegative(),
  missingEstimateCount: z.number().int().nonnegative(),
  baselineCompleteness: completenessSchema, factCoverage: factCoverageSchema,
  totalVarianceMinutes: z.number().int().nullable(), totalVariancePercent: z.number().finite().nullable(),
  addedActualMinutes: z.number().int().nonnegative(), unplannedActualMinutes: z.number().int().nonnegative(),
  totalActualMinutes: z.number().int().nonnegative(),
});
export const weeklyPlanFactRowSchema = z.object({
  id: z.string().min(1).max(200), scope: z.enum(['original', 'added_scope', 'unplanned']),
  commitmentId: idSchema.nullable(), workPackageId: idSchema, membershipId: idSchema,
  title: z.string(), memberName: z.string(),
  plannedMinutes: minutesSchema.nullable(), actualMinutes: z.number().int().nonnegative(),
  factRecorded: z.boolean(), varianceMinutes: z.number().int().nullable(),
  /** Immutable original package-baseline estimate, never the current mutable estimate. */
  packageEstimateMinutes: minutesSchema.nullable(), packageBaselineId: idSchema.nullable(),
  taskIds: z.array(idSchema), workLogs: z.array(recordedWorkLogSchema),
});
export const weeklyPlanFactReportRunSchema = z.object({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, periodId: idSchema,
  baselineId: idSchema, metricVersion: z.literal('weekly_plan_fact_v1'),
  createdAt: utcTimestampSchema, actorUserId: idSchema,
  factCutoffAt: utcTimestampSchema, factChangeSeq: z.string().regex(/^(0|[1-9][0-9]*)$/),
  membershipIds: z.array(idSchema), knownEstimatesOnly: z.boolean(),
  cohort: z.object({ selectedItemCount: z.number().int().nonnegative(), originalItemCount: z.number().int().nonnegative() }),
  summary: weeklyPlanFactSummarySchema,
  /** Authoritative pinned per-person aggregates; rows remain independently paginated. */
  byPerson: z.array(z.object({ membershipId: idSchema, memberName: z.string(), summary: weeklyPlanFactSummarySchema })).max(1000),
  rowCount: z.number().int().nonnegative(),
  /** Immutable revision manifest, never resolved to current mutable worklog values. */
  workLogRevisionIds: z.array(idSchema),
});
export const createWeeklyPlanFactReportInputSchema = z.strictObject({
  baselineId: idSchema, membershipIds: uniqueIds.default([]), knownEstimatesOnly: z.boolean().default(false),
});

export const planningPeriodResponseSchema = envelopeSchema(planningPeriodSchema);
export const planningPeriodListResponseSchema = envelopeSchema(z.array(planningPeriodSchema));
export const periodCommitmentResponseSchema = envelopeSchema(periodCommitmentSchema);
export const periodCommitmentListResponseSchema = envelopeSchema(z.array(periodCommitmentSchema));
export const planningPackageListResponseSchema = envelopeSchema(z.array(planningPackageSchema));
export const freezePreviewResponseSchema = envelopeSchema(freezePreviewSchema);
export const planBaselineResponseSchema = envelopeSchema(planBaselineSchema);
export const planBaselineListResponseSchema = envelopeSchema(z.array(planBaselineSchema));
export const packageBaselineResponseSchema = envelopeSchema(packageBaselineSchema);
export const manualPeriodWorkLogResponseSchema = envelopeSchema(manualPeriodWorkLogSchema);
export const manualPeriodWorkLogListResponseSchema = envelopeSchema(z.array(manualPeriodWorkLogSchema));
export const weeklyPlanFactReportRunResponseSchema = envelopeSchema(weeklyPlanFactReportRunSchema);
export const weeklyPlanFactReportRunListResponseSchema = envelopeSchema(z.array(weeklyPlanFactReportRunSchema));
export const weeklyPlanFactRowListResponseSchema = envelopeSchema(z.array(weeklyPlanFactRowSchema));

export type PlanningPageQuery = z.infer<typeof planningPageQuerySchema>;
export type PlanningPeriodListQuery = z.infer<typeof planningPeriodListQuerySchema>;
export type PeriodCommitmentListQuery = z.infer<typeof periodCommitmentListQuerySchema>;
export type WorkLogListQuery = z.infer<typeof workLogListQuerySchema>;
export type ReportRunListQuery = z.infer<typeof reportRunListQuerySchema>;
export type PlanningPackageListQuery = z.infer<typeof planningPackageListQuerySchema>;
export type PlanningPeriodDto = z.infer<typeof planningPeriodSchema>;
export type CreatePlanningPeriodInput = z.infer<typeof createPlanningPeriodInputSchema>;
export type UpdatePlanningPeriodInput = z.infer<typeof updatePlanningPeriodInputSchema>;
export type CommitmentAllocationDto = z.infer<typeof commitmentAllocationSchema>;
export type PeriodCommitmentDto = z.infer<typeof periodCommitmentSchema>;
export type CreatePeriodCommitmentInput = z.infer<typeof createPeriodCommitmentInputSchema>;
export type UpdatePeriodCommitmentInput = z.infer<typeof updatePeriodCommitmentInputSchema>;
export type PlanningPackageDto = z.infer<typeof planningPackageSchema>;
export type PackageBaselineDto = z.infer<typeof packageBaselineSchema>;
export type PlanningSnapshotDto = z.infer<typeof planningSnapshotSchema>;
export type FreezeScope = z.infer<typeof freezeScopeSchema>;
export type FreezePreviewInput = z.infer<typeof freezePreviewInputSchema>;
export type FreezePreviewDto = z.infer<typeof freezePreviewSchema>;
export type FreezePlanInput = z.infer<typeof freezePlanInputSchema>;
export type PlanBaselineDto = z.infer<typeof planBaselineSchema>;
export type ManualPeriodWorkLogDto = z.infer<typeof manualPeriodWorkLogSchema>;
export type SetManualPeriodWorkInput = z.infer<typeof setManualPeriodWorkInputSchema>;
export type WeeklyPlanFactSummaryDto = z.infer<typeof weeklyPlanFactSummarySchema>;
export type WeeklyPlanFactRowDto = z.infer<typeof weeklyPlanFactRowSchema>;
export type WeeklyPlanFactReportRunDto = z.infer<typeof weeklyPlanFactReportRunSchema>;
export type CreateWeeklyPlanFactReportInput = z.infer<typeof createWeeklyPlanFactReportInputSchema>;
