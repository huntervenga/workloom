import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { setTaskFieldValueInputSchema } from './fields.js';
import { utcTimestampSchema } from './tasks.js';

/** Separate from immutable field definitions: old value bodies, receipts and snapshots are unchanged. */
export const taskFieldPolicySchema = z.strictObject({
  workspaceId: idSchema, projectId: idSchema, fieldId: idSchema,
  revision: z.number().int().min(0).max(2_147_483_647),
  lockAt: utcTimestampSchema.nullable(),
  maxChangesPerActor: z.number().int().min(0).max(1_000_000).nullable(),
  /** First activation is retained when rules are disabled, re-enabled or edited. */
  activatedAt: utcTimestampSchema.nullable(),
  updatedAt: utcTimestampSchema.nullable(), updatedByUserId: idSchema.nullable(),
});
export type TaskFieldPolicyDto = z.infer<typeof taskFieldPolicySchema>;
export const setTaskFieldPolicyInputSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
  lockAt: utcTimestampSchema.nullable(),
  maxChangesPerActor: z.number().int().min(0).max(1_000_000).nullable(),
});
export type SetTaskFieldPolicyInput = z.infer<typeof setTaskFieldPolicyInputSchema>;
export const taskFieldPolicyStateSchema = z.strictObject({
  policy: taskFieldPolicySchema,
  currentActorChangesUsed: z.number().int().min(0),
});
export type TaskFieldPolicyStateDto = z.infer<typeof taskFieldPolicyStateSchema>;
/** A single explicit owner command; it never changes the persistent policy or a frozen original. */
export const setTaskFieldValueExceptionInputSchema = setTaskFieldValueInputSchema.extend({
  expectedPolicyRevision: z.number().int().min(0).max(2_147_483_647),
  reason: z.string().trim().min(1).max(500),
}).strict();
export type SetTaskFieldValueExceptionInput = z.infer<typeof setTaskFieldValueExceptionInputSchema>;
export const taskFieldPolicyResponseSchema = envelopeSchema(taskFieldPolicySchema);
export const taskFieldPolicyStateResponseSchema = envelopeSchema(taskFieldPolicyStateSchema);
