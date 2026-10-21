import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { calendarDateSchema, revisionSchema, utcTimestampSchema } from './tasks.js';

/** All-day leave uses exact integer millionths; fractional accrued balances are not fractional requests. */
export const LEAVE_MICRODAYS_PER_DAY = 1_000_000;
export const leaveMicrodaysSchema = z.number().int().min(0).max(1_000_000_000_000);
export const signedLeaveMicrodaysSchema = z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000);
/** Calculated cumulative totals can exceed one bounded input amount; they remain exact safe integers. */
export const leaveBalanceMicrodaysSchema = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const leaveYearSchema = z.number().int().min(1900).max(2200);
export const leaveWeeklyMinutesSchema = z.tuple([
  z.number().int().min(0).max(1440), z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440), z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440), z.number().int().min(0).max(1440),
  z.number().int().min(0).max(1440),
]);
export const leaveTypeSchema = z.strictObject({
  id: idSchema, name: z.string().trim().min(1).max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  annualEntitlementMicrodays: leaveMicrodaysSchema,
  accrualMethod: z.enum(['daily', 'annual_upfront']),
  carryover: z.strictObject({
    mode: z.enum(['none', 'unlimited', 'capped']),
    capMicrodays: leaveMicrodaysSchema.nullable(),
    expiresAfterMonths: z.number().int().min(1).max(120).nullable(),
  }),
  allowNegative: z.boolean(), maxNegativeMicrodays: leaveMicrodaysSchema.nullable(),
  consumesBalance: z.boolean(), pausesAccrual: z.boolean(), capacityUnavailable: z.boolean(),
  requiresApproval: z.boolean(), archived: z.boolean(),
}).superRefine((value, ctx) => {
  if (value.carryover.mode === 'capped' && value.carryover.capMicrodays === null) {
    ctx.addIssue({ code: 'custom', path: ['carryover', 'capMicrodays'], message: 'Capped carryover requires a cap.' });
  }
});
export const leaveHolidaySchema = z.strictObject({
  id: idSchema, name: z.string().trim().min(1).max(120),
  rule: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('annual'), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }),
    z.strictObject({ kind: z.literal('date'), date: calendarDateSchema }),
  ]),
});
/** Year-effective snapshots inherit the latest preceding effectiveYear. Never rewrite prior annual rates implicitly. */
export const leavePolicyVersionSchema = z.strictObject({
  effectiveYear: leaveYearSchema, types: z.array(leaveTypeSchema).max(30),
  holidays: z.array(leaveHolidaySchema).max(200),
});
export const leaveSettingsSchema = z.strictObject({
  workspaceId: idSchema, revision: revisionSchema, timezone: z.string().min(1).max(100),
  defaultWeeklyMinutes: leaveWeeklyMinutesSchema,
  policyVersions: z.array(leavePolicyVersionSchema).min(1).max(100),
});
export const leaveProfileSchema = z.strictObject({
  workspaceId: idSchema, membershipId: idSchema, revision: revisionSchema,
  timezone: z.string().min(1).max(100), employmentStart: calendarDateSchema,
  employmentEnd: calendarDateSchema.nullable(), accountingStart: calendarDateSchema,
  openingBalances: z.array(z.strictObject({ typeId: idSchema, microdays: signedLeaveMicrodaysSchema })).max(30),
  schedulePeriods: z.array(z.strictObject({ effectiveFrom: calendarDateSchema, weeklyMinutes: leaveWeeklyMinutesSchema })).max(100),
});
export const leaveChargeDaySchema = z.strictObject({
  date: calendarDateSchema, microdays: leaveMicrodaysSchema, scheduledMinutes: z.number().int().min(0).max(1440),
});
/** Server-authored provenance for owner-imported past facts; ordinary request inputs cannot set it. */
export const leaveHistoricalImportSchema = z.strictObject({
  sourceFileSha256: z.string().regex(/^[0-9a-f]{64}$/), sheet: z.string().trim().min(1).max(200),
  sourceRows: z.array(z.number().int().min(1).max(1_048_576)).min(1).max(1000), importedAt: utcTimestampSchema,
});
export const leaveRequestSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, membershipId: idSchema, typeId: idSchema, revision: revisionSchema,
  startDate: calendarDateSchema, endDate: calendarDateSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  note: z.string().max(4000), createdBy: idSchema, createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  /** Snapshotted at approval; confirmed charges do not drift with later calendars or schedules. */
  consumesBalance: z.boolean(), pausesAccrual: z.boolean(), capacityUnavailable: z.boolean(),
  chargedDays: z.array(leaveChargeDaySchema).max(3660), negativeApproved: z.boolean(),
});
/** Internal persisted/domain snapshot. HTTP leave DTOs retain their existing strict shape. */
export const leaveStoredRequestSchema = leaveRequestSchema.extend({ historicalImport: leaveHistoricalImportSchema.optional() });
export type LeaveStoredRequestDto = z.infer<typeof leaveStoredRequestSchema>;
export const leaveAdjustmentSchema = z.strictObject({
  id: idSchema, membershipId: idSchema, typeId: idSchema, effectiveDate: calendarDateSchema,
  deltaMicrodays: signedLeaveMicrodaysSchema, reason: z.string().trim().min(1).max(2000),
});
export const leaveDateRangeSchema = z.strictObject({ startDate: calendarDateSchema, endDate: calendarDateSchema });
export const putLeaveSettingsInputSchema = leaveSettingsSchema.omit({ workspaceId: true, revision: true }).extend({
  expectedRevision: z.number().int().min(0), expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(), reason: z.string().trim().max(2000).default(''),
});
export const putLeaveProfileInputSchema = leaveProfileSchema.omit({ workspaceId: true, membershipId: true, revision: true }).extend({
  expectedRevision: z.number().int().min(0), expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(), reason: z.string().trim().max(2000).default(''),
});
export const createLeaveRequestInputSchema = leaveDateRangeSchema.extend({ expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(), membershipId: idSchema, typeId: idSchema, note: z.string().max(4000).default(''), reason: z.string().trim().max(2000).default('') });
export const updateLeaveRequestInputSchema = leaveDateRangeSchema.extend({ expectedRevision: revisionSchema, expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(), note: z.string().max(4000).default(''), reason: z.string().trim().max(2000).default('') });
export const decideLeaveRequestInputSchema = z.strictObject({ expectedRevision: revisionSchema, expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/).optional(), decision: z.enum(['approve', 'reject', 'cancel']), reason: z.string().trim().max(2000).default(''), approveNegative: z.boolean().default(false) });

const leaveHistoryRowSchema = leaveDateRangeSchema.extend({
  membershipId: idSchema, typeId: idSchema, note: z.string().max(4000).default(''),
  sourceRows: z.array(z.number().int().min(1).max(1_048_576)).min(1).max(1000),
});
export const previewLeaveHistoryInputSchema = z.strictObject({
  source: z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), sheet: z.string().trim().min(1).max(200) }),
  rows: z.array(leaveHistoryRowSchema).min(1).max(50), reason: z.string().trim().min(1).max(2000),
}).superRefine((value, ctx) => {
  const rows = value.rows.flatMap(row => row.sourceRows);
  if (new Set(rows).size !== rows.length) ctx.addIssue({ code: 'custom', path: ['rows'], message: 'Every source row must occur exactly once in a history batch.' });
});
export const importLeaveHistoryInputSchema = previewLeaveHistoryInputSchema.safeExtend({ expectedSourceVersion: z.string().regex(/^[0-9a-f]{64}$/) });
export type PreviewLeaveHistoryInput = z.infer<typeof previewLeaveHistoryInputSchema>;
export type ImportLeaveHistoryInput = z.infer<typeof importLeaveHistoryInputSchema>;
export interface LeaveHistoryPreviewDto {
  sourceVersion: string;
  rows: Array<LeaveChargePreviewDto & { sourceRows: number[]; membershipId: string; typeId: string; startDate: string; endDate: string }>;
}

export type LeaveTypeDto = z.infer<typeof leaveTypeSchema>;
export type LeaveHolidayDto = z.infer<typeof leaveHolidaySchema>;
export type LeavePolicyVersionDto = z.infer<typeof leavePolicyVersionSchema>;
export type LeaveSettingsDto = z.infer<typeof leaveSettingsSchema>;
export type LeaveProfileDto = z.infer<typeof leaveProfileSchema>;
export type LeaveRequestDto = z.infer<typeof leaveRequestSchema>;
/** A reasoned hire-date correction cannot smuggle schedule, opening-credit or timezone changes. */
export function isLeaveEmploymentStartCorrection(
  before: LeaveProfileDto | undefined,
  next: Pick<LeaveProfileDto, 'employmentStart' | 'accountingStart' | 'employmentEnd' | 'timezone' | 'openingBalances' | 'schedulePeriods'>,
): boolean {
  if (!before || before.employmentStart === next.employmentStart || before.timezone !== next.timezone || before.employmentEnd !== next.employmentEnd) return false;
  if (next.accountingStart !== before.accountingStart && !(before.accountingStart === before.employmentStart && next.accountingStart === next.employmentStart)) return false;
  // The balance engine treats a missing opening as zero; existing editors omit zero rows.
  const openings = (profile: typeof next) => profile.openingBalances.filter(value => value.microdays !== 0).map(value => ({ typeId: value.typeId.toLowerCase(), microdays: value.microdays })).sort((a, b) => a.typeId.localeCompare(b.typeId));
  const schedules = (profile: typeof next) => profile.schedulePeriods.map(period => ({ effectiveFrom: period.effectiveFrom, weeklyMinutes: period.weeklyMinutes })).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return JSON.stringify(openings(before)) === JSON.stringify(openings(next)) && JSON.stringify(schedules(before)) === JSON.stringify(schedules(next));
}
export type LeaveChargeDayDto = z.infer<typeof leaveChargeDaySchema>;
export type LeaveAdjustmentDto = z.infer<typeof leaveAdjustmentSchema>;
export type LeaveWeeklyMinutes = z.infer<typeof leaveWeeklyMinutesSchema>;

/** An administrator correcting fully elapsed approved dates with a mandatory reason. */
export interface LeaveHistoricalAbsenceCorrectionContext {
  canManage: boolean;
  today: string;
  reason: string;
}
/**
 * Derives whether an update qualifies as a bounded historical absence correction.
 * Eligible: manager(scope); before exists; both statuses approved; actual date change;
 * same membershipId AND typeId; both OLD endDate and NEW endDate strictly before today; reason nonempty.
 * No bypass flag, DTO field or caller boolean accepted.
 */
export function isLeaveHistoricalAbsenceCorrection(
  before: LeaveRequestDto | undefined,
  proposed: Pick<LeaveRequestDto, 'membershipId' | 'typeId' | 'startDate' | 'endDate' | 'status'>,
  context: LeaveHistoricalAbsenceCorrectionContext,
): boolean {
  if (!context.canManage || !context.reason.trim()) return false;
  if (!before) return false;
  if (before.status !== 'approved' || proposed.status !== 'approved') return false;
  if (before.membershipId !== proposed.membershipId || before.typeId !== proposed.typeId) return false;
  if (before.startDate === proposed.startDate && before.endDate === proposed.endDate) return false;
  if (before.endDate >= context.today || proposed.endDate >= context.today) return false;
  return true;
}
export type PutLeaveSettingsInput = z.infer<typeof putLeaveSettingsInputSchema>;
export type PutLeaveProfileInput = z.infer<typeof putLeaveProfileInputSchema>;
export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestInputSchema>;
export type UpdateLeaveRequestInput = z.infer<typeof updateLeaveRequestInputSchema>;
export type DecideLeaveRequestInput = z.infer<typeof decideLeaveRequestInputSchema>;

/** The service supplies authorized full source and a trusted per-person local asOf date. */
export interface LeaveCalculationSource {
  settings: LeaveSettingsDto;
  profiles: LeaveProfileDto[];
  requests: LeaveRequestDto[];
  adjustments: LeaveAdjustmentDto[];
}
export interface LeaveBalanceDto {
  membershipId: string; typeId: string; asOf: string;
  openingMicrodays: number; earnedMicrodays: number; adjustmentMicrodays: number;
  takenMicrodays: number; expiredMicrodays: number; availableMicrodays: number;
  reservedFutureMicrodays: number; projectedAvailableMicrodays: number; projectedThroughDate: string;
}
export interface LeaveAvailabilityDayDto {
  membershipId: string; date: string; scheduledMinutes: number;
  holidayMinutes: number; absenceMinutes: number; availableMinutes: number;
}
export interface LeaveChargePreviewDto {
  chargedDays: LeaveChargeDayDto[]; totalMicrodays: number; unavailableMinutes: number; overlappingRequestIds: string[];
}
export interface LeaveProjectionDeficitDto {
  membershipId: string; typeId: string; requestId: string; date: string; availableMicrodays: number;
  negativeAllowed: boolean; negativeApprovalRequired: boolean;
}
