import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';
import { taskFieldDataSchema } from './fields.js';
import { minutesSchema, taskPrioritySchema } from './tasks.js';

/**
 * What a new task starts with in a project. A value that is not set here is simply not applied: an unset default never
 * writes anything, and a person (or API caller) can always give an explicit value instead.
 */
export const TASK_DEFAULT_LIMITS = { fieldValues: 50 } as const;

export const taskDefaultFieldValueSchema = z.strictObject({
  fieldId: idSchema,
  value: taskFieldDataSchema.refine(data => data.value !== null, 'A default needs a value; leave the field out to have no default.'),
});
export const taskDefaultsConfigSchema = z.strictObject({
  /** Status of a new task created without an explicit one. */
  statusId: idSchema.nullable(),
  priority: taskPrioritySchema.nullable(),
  /** Team estimate of a new top-level task, in minutes. */
  estimateMinutes: minutesSchema.nullable(),
  /** Initial values of ordinary fields, written once when the task is created. */
  fieldValues: z.array(taskDefaultFieldValueSchema).max(TASK_DEFAULT_LIMITS.fieldValues),
}).superRefine((config, ctx) => {
  if (new Set(config.fieldValues.map(item => item.fieldId.toLowerCase())).size !== config.fieldValues.length) ctx.addIssue({ code: 'custom', message: 'Each field can have only one default.' });
});
export const EMPTY_TASK_DEFAULTS = { statusId: null, priority: null, estimateMinutes: null, fieldValues: [] } as const;

export const taskDefaultsSchema = z.strictObject({ workspaceId: idSchema, projectId: idSchema, revision: z.number().int().nonnegative(), config: taskDefaultsConfigSchema });
export const setTaskDefaultsInputSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), config: taskDefaultsConfigSchema });
export const taskDefaultsResponseSchema = envelopeSchema(taskDefaultsSchema);

export type TaskDefaultsConfig = z.infer<typeof taskDefaultsConfigSchema>;
export type TaskDefaultsDto = z.infer<typeof taskDefaultsSchema>;
export type SetTaskDefaultsInput = z.infer<typeof setTaskDefaultsInputSchema>;
