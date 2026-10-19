import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';
import { calendarDateSchema } from './tasks.js';
import { leaveSettingsSchema, leaveProfileSchema, leaveRequestSchema, signedLeaveMicrodaysSchema, leaveBalanceMicrodaysSchema, leaveAdjustmentSchema, createLeaveRequestInputSchema, leaveChargeDaySchema } from './leave.js';
const unique = (ids: string[]) => new Set(ids).size === ids.length;
export const leavePeopleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('all_active') }),
  z.strictObject({ kind: z.literal('selected'), membershipIds: z.array(idSchema).min(1).max(100).refine(unique) }),
]);
/** Capacity is an independently chosen inclusive calendar range, never a mandatory planning week. */
export const leaveAvailabilityInputSchema = z.strictObject({ startDate: calendarDateSchema, endDate: calendarDateSchema, people: leavePeopleSchema }).superRefine((v,ctx)=>{
  if(v.startDate<'1900-01-01'||v.endDate>'2200-12-31')ctx.addIssue({code:'custom',path:['startDate'],message:'Time off calendars support years 1900 through 2200.'});
  const days = (Date.parse(v.endDate+'T00:00:00Z')-Date.parse(v.startDate+'T00:00:00Z'))/86400000+1;
  if (!Number.isInteger(days)||days<1||days>366) ctx.addIssue({code:'custom',path:['endDate'],message:'Choose an inclusive range of at most 366 days.'});
});
const minutes = z.number().int().nonnegative();
export const leaveAvailabilityDaySchema = z.strictObject({membershipId:idSchema,date:calendarDateSchema,scheduledMinutes:minutes,holidayMinutes:minutes,absenceMinutes:minutes,availableMinutes:minutes});
export const leaveCapacityMemberSchema = z.strictObject({membershipId:idSchema,displayName:z.string(),scheduleKnown:z.boolean(),scheduledMinutes:minutes.nullable(),holidayMinutes:minutes.nullable(),absenceMinutes:minutes.nullable(),availableMinutes:minutes.nullable()});
export const leaveAvailabilitySchema = z.strictObject({
  startDate:calendarDateSchema,endDate:calendarDateSchema,settingsConfigured:z.boolean(),sourceVersion:z.string().regex(/^[a-f0-9]{64}$/),
  days:z.array(leaveAvailabilityDaySchema).max(36600),members:z.array(leaveCapacityMemberSchema).max(100),
  totals:z.strictObject({scheduledMinutes:minutes,holidayMinutes:minutes,absenceMinutes:minutes,availableMinutes:minutes,unconfiguredMembers:minutes}),
  intervals:z.array(z.strictObject({membershipId:idSchema,startDate:calendarDateSchema,endDate:calendarDateSchema})).max(5000),
  companyHolidays:z.array(calendarDateSchema).max(366),
  /** Opaque revision digest plus daily input components pins report capacity without exposing private history counters. */
  inputVersions:z.strictObject({digest:z.string().regex(/^[a-f0-9]{64}$/).optional(),settingsRevision:z.number().int().nonnegative(),profiles:z.array(z.strictObject({membershipId:idSchema,revision:z.number().int().positive()})).max(100),requests:z.array(z.strictObject({id:idSchema,revision:z.number().int().positive()})).max(5000)}),
});
export const leaveBalanceSchema = z.strictObject({membershipId:idSchema,typeId:idSchema,asOf:calendarDateSchema,projectedThroughDate:calendarDateSchema,openingMicrodays:leaveBalanceMicrodaysSchema,earnedMicrodays:leaveBalanceMicrodaysSchema,adjustmentMicrodays:leaveBalanceMicrodaysSchema,takenMicrodays:leaveBalanceMicrodaysSchema,expiredMicrodays:leaveBalanceMicrodaysSchema,availableMicrodays:leaveBalanceMicrodaysSchema,reservedFutureMicrodays:leaveBalanceMicrodaysSchema,projectedAvailableMicrodays:leaveBalanceMicrodaysSchema});
export const leaveOverviewSchema = z.strictObject({
  ownMembershipId:idSchema,today:calendarDateSchema,settings:leaveSettingsSchema.nullable(),
  capabilities:z.strictObject({canManage:z.boolean(),canApprove:z.boolean(),canRequest:z.boolean()}),
  members:z.array(z.strictObject({id:idSchema,displayName:z.string(),avatarUrl:z.string().nullable(),today:calendarDateSchema})).max(100),
  profiles:z.array(leaveProfileSchema).max(100),requests:z.array(leaveRequestSchema).max(5000),balances:z.array(leaveBalanceSchema).max(3000),
});
export const applyLeaveTemplateInputSchema = z.strictObject({expectedRevision:z.literal(0),effectiveYear:z.number().int().min(1900).max(2200),includeCompanyHolidays:z.boolean().default(true)});
export const createLeaveAdjustmentInputSchema = z.strictObject({membershipId:idSchema,typeId:idSchema,effectiveDate:calendarDateSchema,deltaMicrodays:signedLeaveMicrodaysSchema,approveNegative:z.boolean().default(false),reason:z.string().trim().min(1).max(2000)});
export const bulkLeaveRequestInputSchema = z.strictObject({expectedSourceVersion:z.string().regex(/^[a-f0-9]{64}$/).optional(),membershipIds:z.array(idSchema).min(1).max(100).refine(unique),typeId:idSchema,startDate:calendarDateSchema,endDate:calendarDateSchema,note:z.string().max(4000).default(''),approveNegative:z.boolean().default(false),reason:z.string().trim().max(2000).default('')});
export const leaveOverviewResponseSchema = envelopeSchema(leaveOverviewSchema);
export const leaveAvailabilityResponseSchema = envelopeSchema(leaveAvailabilitySchema);
export const leaveSettingsResponseSchema = envelopeSchema(leaveSettingsSchema);
export const leaveProfileResponseSchema = envelopeSchema(leaveProfileSchema);
export const leaveRequestResponseSchema = envelopeSchema(leaveRequestSchema);
export const leaveRequestListResponseSchema = envelopeSchema(z.array(leaveRequestSchema));
export type LeaveAvailabilityInput = z.infer<typeof leaveAvailabilityInputSchema>;
export type LeaveAvailabilityDto = z.infer<typeof leaveAvailabilitySchema>;
export type LeaveOverviewDto = z.infer<typeof leaveOverviewSchema>;
export type ApplyLeaveTemplateInput = z.infer<typeof applyLeaveTemplateInputSchema>;
export type CreateLeaveAdjustmentInput = z.infer<typeof createLeaveAdjustmentInputSchema>;
export type BulkLeaveRequestInput = z.infer<typeof bulkLeaveRequestInputSchema>;

export const previewLeaveRequestInputSchema = createLeaveRequestInputSchema.extend({excludeRequestId:idSchema.optional(),approveNegative:z.boolean().default(false)});
export const leaveRequestPreviewSchema = z.strictObject({sourceVersion:z.string().regex(/^[a-f0-9]{64}$/),today:calendarDateSchema,chargedDays:z.array(leaveChargeDaySchema),totalMicrodays:z.number().int().nonnegative(),unavailableMinutes:minutes,overlappingRequestIds:z.array(idSchema),pausesAccrual:z.boolean(),balancesBefore:z.array(leaveBalanceSchema),balancesAfter:z.array(leaveBalanceSchema),deficits:z.array(z.strictObject({requestId:idSchema,membershipId:idSchema,typeId:idSchema,date:calendarDateSchema,availableMicrodays:leaveBalanceMicrodaysSchema,negativeAllowed:z.boolean(),negativeApprovalRequired:z.boolean()}))});
export const leaveRequestPreviewResponseSchema=envelopeSchema(leaveRequestPreviewSchema);
export type PreviewLeaveRequestInput=z.infer<typeof previewLeaveRequestInputSchema>;
export type LeaveRequestPreviewDto=z.infer<typeof leaveRequestPreviewSchema>;

export const leaveBulkPreviewSchema=z.strictObject({sourceVersion:z.string().regex(/^[a-f0-9]{64}$/),previews:z.array(z.strictObject({membershipId:idSchema,preview:leaveRequestPreviewSchema})).max(100)});
export const leaveBulkPreviewResponseSchema=envelopeSchema(leaveBulkPreviewSchema);
export type LeaveBulkPreviewDto=z.infer<typeof leaveBulkPreviewSchema>;
export const leaveRecalculationPreviewSchema=z.strictObject({sourceVersion:z.string().regex(/^[a-f0-9]{64}$/),balancesBefore:z.array(leaveBalanceSchema),balancesAfter:z.array(leaveBalanceSchema),deficits:leaveRequestPreviewSchema.shape.deficits});
export const leaveRecalculationPreviewResponseSchema=envelopeSchema(leaveRecalculationPreviewSchema);
export type LeaveRecalculationPreviewDto=z.infer<typeof leaveRecalculationPreviewSchema>;

export const leaveAdjustmentResponseSchema=envelopeSchema(leaveAdjustmentSchema);
