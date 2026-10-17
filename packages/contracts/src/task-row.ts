import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { manualPeriodWorkLogSchema } from './common/recorded-work.js';
import { taskFieldDataSchema, taskFieldValueSchema } from './fields.js';
import { periodCommitmentSchema } from './planning.js';
import { createTaskInputSchema, minutesSchema, revisionSchema, taskSchema } from './tasks.js';

/**
 * Atomic table-row creation: one task, its first custom field values, and optionally the explicit
 * personal plan and period actual with explicit chosen period and membership targets, committed in a single
 * transaction with one `task.row.create` receipt. Any failure leaves no task, package, sibling
 * renumbering, value, plan or actual behind.
 *
 * Nothing is implied: there is no selected week, person or "today". `plan` and `actual` carry
 * explicit period and membership IDs. `0` minutes, `null` and an absent key are different values.
 *
 * `plan` is the existing whole-package personal commitment of the created task's work package
 * (a detail subtask shares its parent's package), never a per-task allocation. When no commitment
 * exists for that package, period and member, `expectedRevision` must be `null` and one is created.
 * When an active one exists, `expectedRevision` must match it; its allocations and state are kept
 * and only `plannedMinutes` changes. A removed commitment is rejected, never silently restored.
 */
const reasonSchema = z.string().trim().min(1).max(1000);

export const taskRowFieldInputSchema = z.strictObject({
  fieldId: idSchema,
  expectedDefinitionRevision: revisionSchema,
  value: taskFieldDataSchema,
});

const taskRowFieldListSchema = z
  .array(taskRowFieldInputSchema)
  .max(200)
  .refine((fields) => new Set(fields.map((field) => field.fieldId)).size === fields.length, {
    error: 'Field IDs must be unique.',
  });

export const taskRowPlanInputSchema = z.strictObject({
  periodId: idSchema,
  membershipId: idSchema,
  expectedRevision: revisionSchema.nullable(),
  plannedMinutes: minutesSchema.nullable(),
});

export const taskRowActualInputSchema = z.strictObject({
  periodId: idSchema,
  membershipId: idSchema,
  minutes: minutesSchema,
  reason: reasonSchema.nullable().optional(),
});

export const createTaskRowInputSchema = z.strictObject({
  task: createTaskInputSchema,
  fields: taskRowFieldListSchema.optional(),
  plan: taskRowPlanInputSchema.optional(),
  actual: taskRowActualInputSchema.optional(),
});

export const taskRowCreatedSchema = z.strictObject({
  task: taskSchema,
  fields: z.array(taskFieldValueSchema),
  plan: periodCommitmentSchema.optional(),
  actual: manualPeriodWorkLogSchema.optional(),
});

export const taskRowResponseSchema = envelopeSchema(taskRowCreatedSchema);

export type TaskRowFieldInput = z.infer<typeof taskRowFieldInputSchema>;
export type TaskRowPlanInput = z.infer<typeof taskRowPlanInputSchema>;
export type TaskRowActualInput = z.infer<typeof taskRowActualInputSchema>;
export type CreateTaskRowInput = z.infer<typeof createTaskRowInputSchema>;
export type TaskRowCreatedDto = z.infer<typeof taskRowCreatedSchema>;
export type TaskRowResponse = z.infer<typeof taskRowResponseSchema>;
