import { z } from 'zod';

/** Dependency-free, privacy-safe presentation diagnostics; never an authorization input. */
export const leaveWarningCodeSchema = z.enum([
  'ACCOUNTING_BEFORE_EMPLOYMENT', 'OUTSIDE_EMPLOYMENT', 'BEFORE_ACCOUNTING',
  'MISSING_POLICY', 'MISSING_TYPE', 'ARCHIVED_TYPE', 'TYPE_BEHAVIOR_CHANGED',
  'OVERLAP', 'NEGATIVE_BALANCE', 'PAID_POOL_DEBT', 'NEGATIVE_OPENING',
  'ADJUSTMENT_BEFORE_ACCOUNTING',
]);
export type LeaveWarningCode = z.infer<typeof leaveWarningCodeSchema>;
const warningDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const warningId = z.uuid();
export const leaveWarningSchema = z.strictObject({
  code: leaveWarningCodeSchema,
  entity: z.enum(['profile', 'request', 'adjustment', 'settings']),
  entityId: warningId.nullable(),
  membershipId: warningId.nullable(),
  startDate: warningDate.nullable(),
  endDate: warningDate.nullable(),
  typeId: warningId.nullable(),
  availableMicrodays: z.number().int().safe().nullable(),
});
export type LeaveWarningDto = z.infer<typeof leaveWarningSchema>;
export const leaveWarningsSchema = z.strictObject({
  warnings: z.array(leaveWarningSchema).max(100),
  truncated: z.boolean(),
  totalCount: z.number().int().nonnegative().safe(),
});
export type LeaveWarningsDto = z.infer<typeof leaveWarningsSchema>;
export type LeaveWithWarnings<T> = T & { warnings?: LeaveWarningsDto };
export const leaveAcceptedWarningsSchema = z.strictObject({
  codes: z.array(leaveWarningCodeSchema).max(12),
  count: z.number().int().nonnegative().safe(),
});
export type LeaveAcceptedWarningsDto = z.infer<typeof leaveAcceptedWarningsSchema>;
