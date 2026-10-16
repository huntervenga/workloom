import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
export const taskTableBuiltinColumnSchema = z.enum(['title', 'status', 'responsible', 'participants', 'dueDate', 'tags', 'priority', 'estimate', 'weeklyPlan', 'weeklyActual']);
export const tableColumnRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('builtin'), key: taskTableBuiltinColumnSchema }),
  z.strictObject({ kind: z.literal('field'), fieldId: idSchema }),
]);
export const columnChoiceSchema = z.strictObject({ column: tableColumnRefSchema, visible: z.boolean() });
const choices = z.array(columnChoiceSchema).min(1).max(210).superRefine((value, ctx) => {
  const first = value[0];
  if (!first || first.column.kind !== 'builtin' || first.column.key !== 'title' || !first.visible) ctx.addIssue({ code: 'custom', path: [0], message: 'The title column must be first and visible.' });
  const keys = value.map(choice => choice.column.kind === 'builtin' ? `builtin:${choice.column.key}` : `field:${choice.column.fieldId}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Column references must be unique.' });
  if (value.filter(choice => choice.column.kind === 'field').length > 200) ctx.addIssue({ code: 'custom', message: 'At most 200 custom columns are allowed.' });
});
const revision = z.number().int().min(0).max(2147483647);
/** Null follows current project defaults; revision zero is a read-only absent row. */
export const personalTablePreferenceSchema = z.strictObject({ workspaceId: idSchema, projectId: idSchema, membershipId: idSchema, revision, columns: choices.nullable() }).refine(value => value.revision !== 0 || value.columns === null, 'An absent preference must follow defaults.');
export const updatePersonalTablePreferenceInputSchema = z.strictObject({ expectedRevision: revision, columns: choices.nullable() });
export const personalTablePreferenceResponseSchema = envelopeSchema(personalTablePreferenceSchema);
export type TaskTableBuiltinColumn = z.infer<typeof taskTableBuiltinColumnSchema>;
export type TableColumnRef = z.infer<typeof tableColumnRefSchema>;
export type ColumnChoice = z.infer<typeof columnChoiceSchema>;
export type PersonalTablePreferenceDto = z.infer<typeof personalTablePreferenceSchema>;
export type UpdatePersonalTablePreferenceInput = z.infer<typeof updatePersonalTablePreferenceInputSchema>;
