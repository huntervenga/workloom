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
/** How a person-like attribute of a new task is chosen: nothing, the same as the task above it, or a fixed value. */
const maxDays = 366;
export const taskDefaultAssigneeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('above') }),
  z.strictObject({ kind: z.literal('fixed'), membershipId: idSchema }),
]);
export const taskDefaultTagsSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('above') }),
  z.strictObject({ kind: z.literal('fixed'), tagIds: z.array(idSchema).max(20) }),
]);
/** A due date is never a fixed day: it is today (plus a number of days) in the workspace time zone, or the date above. */
export const taskDefaultDueDateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('today'), offsetDays: z.number().int().min(0).max(maxDays) }),
  z.strictObject({ kind: z.literal('above') }),
]);
/** What is taken from the task directly above in the same section (or, without sections, in the same list). */
export const taskDefaultFromAboveSchema = z.strictObject({
  priority: z.boolean(),
  estimate: z.boolean(),
  fieldIds: z.array(idSchema).max(TASK_DEFAULT_LIMITS.fieldValues),
});
export const taskDefaultTodayFieldSchema = z.strictObject({ fieldId: idSchema, offsetDays: z.number().int().min(0).max(maxDays) });

export const taskDefaultsConfigSchema = z.strictObject({
  /** The following are optional so settings saved before they existed keep working unchanged. */
  assignee: taskDefaultAssigneeSchema.optional(),
  tags: taskDefaultTagsSchema.optional(),
  dueDate: taskDefaultDueDateSchema.optional(),
  fromAbove: taskDefaultFromAboveSchema.optional(),
  /** Date fields that start as today plus a number of days. */
  todayFields: z.array(taskDefaultTodayFieldSchema).max(20).optional(),
  /** Status of a new task created without an explicit one. */
  statusId: idSchema.nullable(),
  priority: taskPrioritySchema.nullable(),
  /** Team estimate of a new top-level task, in minutes. */
  estimateMinutes: minutesSchema.nullable(),
  /** Initial values of ordinary fields, written once when the task is created. */
  fieldValues: z.array(taskDefaultFieldValueSchema).max(TASK_DEFAULT_LIMITS.fieldValues),
}).superRefine((config, ctx) => {
  if (new Set(config.fieldValues.map(item => item.fieldId.toLowerCase())).size !== config.fieldValues.length) ctx.addIssue({ code: 'custom', message: 'Each field can have only one default.' });
  const dynamic = [...(config.fromAbove?.fieldIds ?? []), ...(config.todayFields ?? []).map(item => item.fieldId)].map(id => id.toLowerCase());
  if (new Set(dynamic).size !== dynamic.length) ctx.addIssue({ code: 'custom', message: 'A field can take its value from the task above or from today, not both.' });
});
export const EMPTY_TASK_DEFAULTS = { statusId: null, priority: null, estimateMinutes: null, fieldValues: [] } as const;

export const taskDefaultsSchema = z.strictObject({ workspaceId: idSchema, projectId: idSchema, revision: z.number().int().nonnegative(), config: taskDefaultsConfigSchema });
export const setTaskDefaultsInputSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), config: taskDefaultsConfigSchema });
export const taskDefaultsResponseSchema = envelopeSchema(taskDefaultsSchema);

export type TaskDefaultsConfig = z.infer<typeof taskDefaultsConfigSchema>;
export type TaskDefaultsDto = z.infer<typeof taskDefaultsSchema>;
export type SetTaskDefaultsInput = z.infer<typeof setTaskDefaultsInputSchema>;
