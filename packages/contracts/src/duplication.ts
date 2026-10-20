import {summaryTemplateBindingSchema,summaryTemplatePersonSchema} from './summary-templates.js';
import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { sectionSchema } from './tasks.js';
import { taskFieldDefinitionSchema } from './fields.js';
import { genericHeaderWidgetRuleSchema } from './generic-reports.js';
import { planningCheckRuleSchema } from './planning-checks.js';

export const DUPLICATION_LIMITS = { maxTasks: 100, maxSourceTasks: 5000, maxFields: 200 } as const;
const version = z.string().regex(/^[a-f0-9]{64}$/);
export const duplicationCopyOptionsSchema = z.strictObject({
  description: z.boolean(), assignee: z.boolean(), dates: z.boolean(), tags: z.boolean(),
  priority: z.boolean(), participants: z.boolean(), subtasks: z.boolean(),
  // Values are ordinary user data. No implicit copy-all or name-based plan/fact classification.
  customFieldIds: z.array(idSchema).max(DUPLICATION_LIMITS.maxFields).refine(ids => new Set(ids).size === ids.length, 'Choose each field once.').transform(ids => [...ids].sort()),
});
export const duplicateTaskPreviewInputSchema = z.strictObject({ projectId: idSchema, title: z.string().trim().min(1).max(500), copy: duplicationCopyOptionsSchema });
export const duplicateSectionPreviewInputSchema = z.strictObject({ name: z.string().trim().min(1).max(160), includeTasks: z.boolean(), includeSettings: z.boolean(), templateMode:z.enum(['keep_link','independent']).optional(),templatePerson:summaryTemplatePersonSchema.optional(), copy: duplicationCopyOptionsSchema });
export const duplicateTaskInputSchema = duplicateTaskPreviewInputSchema.extend({ expectedSourceVersion: version });
export const duplicateSectionInputSchema = duplicateSectionPreviewInputSchema.extend({ expectedSourceVersion: version });
export const duplicationPreviewSchema = z.strictObject({
  kind: z.enum(['task', 'section']), sourceId: idSchema, projectId: idSchema, sourceVersion: version,
  name: z.string(), taskCount: z.number().int().min(0).max(DUPLICATION_LIMITS.maxTasks), customValueCount: z.number().int().nonnegative(),
  copyableFields: z.array(taskFieldDefinitionSchema),
  settings: z.strictObject({
    aggregateRevision: z.number().int().nonnegative(), checksRevision: z.number().int().nonnegative(),
    headerWidgets: z.array(genericHeaderWidgetRuleSchema), balanceChecks: z.array(planningCheckRuleSchema),templateBinding:summaryTemplateBindingSchema.optional(),
  }).nullable(),
});
export const duplicationResultSchema = z.strictObject({ kind: z.enum(['task', 'section']), projectId: idSchema, rootTaskId: idSchema.nullable(), section: sectionSchema.nullable(), taskIds: z.array(idSchema).max(DUPLICATION_LIMITS.maxTasks) });
export const duplicationPreviewResponseSchema = envelopeSchema(duplicationPreviewSchema);
export const duplicationResultResponseSchema = envelopeSchema(duplicationResultSchema);
export type DuplicationCopyOptions = z.infer<typeof duplicationCopyOptionsSchema>;
export type DuplicateTaskPreviewInput = z.infer<typeof duplicateTaskPreviewInputSchema>;
export type DuplicateSectionPreviewInput = z.infer<typeof duplicateSectionPreviewInputSchema>;
export type DuplicateTaskInput = z.infer<typeof duplicateTaskInputSchema>;
export type DuplicateSectionInput = z.infer<typeof duplicateSectionInputSchema>;
export type DuplicationPreviewDto = z.infer<typeof duplicationPreviewSchema>;
export type DuplicationResultDto = z.infer<typeof duplicationResultSchema>;
