import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { calendarDateSchema, createTaskInputSchema, revisionSchema, taskSchema, utcTimestampSchema } from './tasks.js';

const minutes = z.number().int().min(0).max(2147483647);
const nullableMinutes = minutes.nullable();
const optionalUrl = z.string().url().max(2048).refine(value=>/^https?:\/\//i.test(value),'Use an HTTP or HTTPS URL.').nullable();
const reason = z.string().trim().min(1).max(1000);
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;
export const sharedActivityCategorySnapshotSchema = z.strictObject({
  fieldId: idSchema.nullable(), optionId: idSchema.nullable(), label: z.string().nullable(), color: z.string().nullable(),
  definitionVersionId: idSchema.nullable(), valueRevision: z.number().int().nonnegative().nullable(),
});
export const sharedActivityConfigurationSchema = z.strictObject({
  planFieldId: idSchema, factFieldId: idSchema, categoryFieldId: idSchema.nullable(),
  organizerMembershipId: idSchema, attendeeMembershipIds: z.array(idSchema).min(1).max(100).refine(unique),
  occurrenceDate: calendarDateSchema, startAt: utcTimestampSchema.nullable(),
  recordingUrl: optionalUrl, summaryUrl: optionalUrl, summaryText: z.string().max(20000).nullable(),
  plannedOverrides: z.array(z.strictObject({ membershipId: idSchema, minutes: nullableMinutes })).max(0,'Personal plan overrides are not supported. Edit the bound ordinary plan field.').refine(rows => unique(rows.map(row => row.membershipId))),
}).superRefine((value, ctx) => {
  if (value.planFieldId === value.factFieldId) ctx.addIssue({ code: 'custom', path: ['factFieldId'], message: 'Choose different duration fields.' });
  for (const row of value.plannedOverrides) if (!value.attendeeMembershipIds.includes(row.membershipId)) ctx.addIssue({ code: 'custom', path: ['plannedOverrides'], message: 'Plan overrides must name current attendees.' });
});
export const sharedActivitySchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, projectId: idSchema, taskId: idSchema, revision: revisionSchema,
  planFieldId: idSchema, factFieldId: idSchema, categoryFieldId: idSchema.nullable(), organizerMembershipId: idSchema,
  occurrenceDate: calendarDateSchema, startAt: utcTimestampSchema.nullable(), recordingUrl: optionalUrl, summaryUrl: optionalUrl,
  summaryText: z.string().nullable(), createdAt: utcTimestampSchema, updatedAt: utcTimestampSchema,
});
export const sharedActivityContributionSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, activityId: idSchema, taskId: idSchema, membershipId: idSchema, revision: revisionSchema,
  rosterActive: z.boolean(), originalPlannedMinutes: nullableMinutes, currentPlannedMinutes: nullableMinutes,
  plannedOverride: z.boolean(), originalActivityRevision: revisionSchema, plannedActivityRevision: revisionSchema,
  attendance: z.enum(['unconfirmed', 'present', 'partial', 'absent']), postingState: z.enum(['unconfirmed', 'active', 'void']),
  minutes: nullableMinutes, confirmedActivityRevision: revisionSchema.nullable(), confirmedFactValueRevision: z.number().int().nonnegative().nullable(),
  confirmedDurationMinutes: nullableMinutes, confirmedOccurrenceDate: calendarDateSchema.nullable(), category: sharedActivityCategorySnapshotSchema.nullable(),
  reason: z.string().nullable(), updatedAt: utcTimestampSchema,
});
export const sharedActivityPermissionsSchema = z.strictObject({ selfMembershipId: idSchema, canWriteSelf: z.boolean(), canWriteOthers: z.boolean(), canEditActivity: z.boolean() });
export const sharedActivityRecordSchema = z.strictObject({
  activity: sharedActivitySchema, contributions: z.array(sharedActivityContributionSchema).max(1000), permissions: sharedActivityPermissionsSchema,
  plannedDurationMinutes: nullableMinutes, actualDurationMinutes: nullableMinutes,
  planValueRevision: z.number().int().nonnegative(), factValueRevision: z.number().int().nonnegative(),
});
export const configureSharedActivityInputSchema = z.strictObject({
  expectedTaskRevision: revisionSchema, expectedActivityRevision: z.number().int().nonnegative(), expectedPlanValueRevision: z.number().int().nonnegative(),
  configuration: sharedActivityConfigurationSchema,
});
const createDurationSchema = z.strictObject({ expectedDefinitionRevision: revisionSchema, minutes: nullableMinutes });
export const createSharedActivityInputSchema = z.strictObject({ task: createTaskInputSchema, configuration: sharedActivityConfigurationSchema, plan: createDurationSchema, fact: createDurationSchema });
export const createSharedActivityResultSchema = z.strictObject({ task: taskSchema, sharedActivity: sharedActivityRecordSchema });
export const confirmSharedActivityAttendanceInputSchema = z.strictObject({
  expectedActivityRevision: revisionSchema, expectedFactValueRevision: z.number().int().nonnegative(),
  rows: z.array(z.strictObject({ contributionId: idSchema, expectedRevision: revisionSchema, attendance: z.enum(['unconfirmed', 'present', 'partial', 'absent']),
    minutes: minutes.optional(), void: z.boolean().optional(), reason: reason.optional(), recategorize: z.literal(true).optional(),
  })).min(1).max(100).refine(rows => unique(rows.map(row => row.contributionId))),
});
export const sharedActivityHistorySchema = z.strictObject({
  id: idSchema, contribution: sharedActivityContributionSchema, actorUserId: idSchema, recordedAt: utcTimestampSchema, changeSeq: z.string().regex(/^\d+$/),
});
export const personalEffortContributionSchema = z.strictObject({
  sourceKey: z.string(), sourceKind: z.enum(['ordinary_task', 'shared_plan', 'shared_attendance']), taskId: idSchema, membershipId: idSchema.nullable(), fieldId: idSchema,
  minutes: nullableMinutes, state: z.enum(['value', 'missing', 'null', 'unknown', 'void']), sourceRevision: z.number().int().nonnegative().nullable(),
  activityRevision: z.number().int().positive().nullable(), occurrenceDate: calendarDateSchema.nullable(), category: sharedActivityCategorySnapshotSchema.nullable(),
});
export const personalEffortResultSchema = z.strictObject({
  minutes: nullableMinutes, canonicalTaskCount: z.number().int().nonnegative(), participationCount: z.number().int().nonnegative(),
  coverage: z.strictObject({ sources: z.number().int().nonnegative(), known: z.number().int().nonnegative(), unknown: z.number().int().nonnegative(), zero: z.number().int().nonnegative(), void: z.number().int().nonnegative() }),
  contributions: z.array(personalEffortContributionSchema).max(50000),
});
export const sharedActivityResponseSchema = envelopeSchema(sharedActivityRecordSchema);
export const createSharedActivityResponseSchema = envelopeSchema(createSharedActivityResultSchema);
export const sharedActivityHistoryResponseSchema = envelopeSchema(z.array(sharedActivityHistorySchema));
export type SharedActivityConfiguration = z.infer<typeof sharedActivityConfigurationSchema>;
export type SharedActivityDto = z.infer<typeof sharedActivitySchema>;
export type SharedActivityContributionDto = z.infer<typeof sharedActivityContributionSchema>;
export type SharedActivityCategorySnapshotDto = z.infer<typeof sharedActivityCategorySnapshotSchema>;
export type SharedActivityRecordDto = z.infer<typeof sharedActivityRecordSchema>;
export type ConfigureSharedActivityInput = z.infer<typeof configureSharedActivityInputSchema>;
export type CreateSharedActivityInput = z.infer<typeof createSharedActivityInputSchema>;
export type CreateSharedActivityResultDto = z.infer<typeof createSharedActivityResultSchema>;
export type ConfirmSharedActivityAttendanceInput = z.infer<typeof confirmSharedActivityAttendanceInputSchema>;
export type SharedActivityHistoryDto = z.infer<typeof sharedActivityHistorySchema>;
export type PersonalEffortContributionDto = z.infer<typeof personalEffortContributionSchema>;
export type PersonalEffortResultDto = z.infer<typeof personalEffortResultSchema>;
