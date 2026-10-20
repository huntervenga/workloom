import { z } from 'zod';
import {leaveAvailabilityInputSchema,leaveAvailabilitySchema,leaveCapacityMemberSchema} from './leave-api.js';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { calendarDateSchema, revisionSchema, taskStatusGroupSchema, utcTimestampSchema } from './tasks.js';
import { projectColumnsSchema, taskFieldDefinitionSchema } from './fields.js';

const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/);
const name = z.string().trim().min(1).max(160);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
export const genericReportMeasureSchema = z.discriminatedUnion('operation', [
  z.strictObject({ key, operation: z.literal('sum'), fieldId: idSchema }),
  z.strictObject({ key, operation: z.literal('avg'), fieldId: idSchema }),
  z.strictObject({ key, operation: z.literal('min'), fieldId: idSchema }),
  z.strictObject({ key, operation: z.literal('max'), fieldId: idSchema }),
  z.strictObject({ key, operation: z.literal('count_values'), fieldId: idSchema }),
  z.strictObject({ key, operation: z.literal('count_tasks') }),
]);
export const genericReportMeasuresSchema = z.array(genericReportMeasureSchema).min(1).max(12).refine(v => unique(v.map(m => m.key)), 'Measure keys must be unique.');
export const genericReportGroupSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.literal('assignee') }),
  z.strictObject({ kind: z.literal('status') }), z.strictObject({ kind: z.literal('section') }),
  z.strictObject({ kind: z.literal('category'), fieldId: idSchema }),
]);
export const genericReportFiltersSchema = z.strictObject({
  statusGroups: z.array(taskStatusGroupSchema).max(4).refine(unique),
  tagIds: z.array(idSchema).max(20).refine(unique),
  assignee: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('all') }), z.strictObject({ kind: z.literal('unassigned') }), z.strictObject({ kind: z.literal('member'), membershipId: idSchema })]),
  dateRange: z.strictObject({ source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('due_date') }), z.strictObject({ kind: z.literal('field'), fieldId: idSchema })]), from: calendarDateSchema, to: calendarDateSchema }).refine(v => v.from <= v.to, 'Date range is inclusive and ordered.').nullable(),
});
export const genericReportConfigSchema = z.strictObject({
  projectId: idSchema,
  hierarchy: z.enum(['all_tasks', 'root_tasks']),
  measures: genericReportMeasuresSchema,
  comparison: z.strictObject({ planFieldId: idSchema, factFieldId: idSchema, completion: z.enum(['done_only', 'all_tasks']) }).refine(v => v.planFieldId !== v.factFieldId, 'Choose two different fields.').nullable(),
  groupBy: genericReportGroupSchema,
  filters: genericReportFiltersSchema,
  capacity: leaveAvailabilityInputSchema.optional(),
});
export const genericReportDefinitionSchema = z.strictObject({ id: idSchema, workspaceId: idSchema, projectId: idSchema, name, revision: revisionSchema, config: genericReportConfigSchema, archivedAt: utcTimestampSchema.nullable(), createdAt: utcTimestampSchema, updatedAt: utcTimestampSchema });
export const createGenericReportInputSchema = z.strictObject({ name, config: genericReportConfigSchema });
export const updateGenericReportInputSchema = z.strictObject({ expectedRevision: revisionSchema, name, config: genericReportConfigSchema, archived: z.boolean() });
export const genericReportListQuerySchema = z.strictObject({ projectId: idSchema });
export const genericReportPageSchema = z.strictObject({ offset: z.number().int().min(0).max(5000).default(0), limit: z.number().int().min(1).max(200).default(100), expectedSourceVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export const queryGenericReportInputSchema = genericReportPageSchema.extend({ expectedRevision: revisionSchema, snapshotId: idSchema.nullable().default(null) });
export const queryGenericAggregatesInputSchema = genericReportPageSchema.extend({ config: genericReportConfigSchema });
export const captureGenericInitialInputSchema = z.strictObject({ expectedRevision: revisionSchema, name, expectedSourceVersion: z.string().regex(/^[a-f0-9]{64}$/) });
export const genericInitialSnapshotSchema = z.strictObject({ id: idSchema, workspaceId: idSchema, reportId: idSchema, projectId: idSchema, name, definitionRevision: revisionSchema, config: genericReportConfigSchema, fields: z.array(taskFieldDefinitionSchema), capturedAt: utcTimestampSchema, capturedByUserId: idSchema, sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), taskCount: z.number().int().min(0).max(5000), capacity:leaveAvailabilitySchema.optional() });

/** Exact rational is authoritative. Decimal is a deterministic presentation rounded to at most 12 places. */
export const genericReportNumberSchema = z.strictObject({ numerator: z.string().regex(/^-?\d+$/), denominator: z.string().regex(/^[1-9]\d*$/), decimal: z.string().regex(/^-?\d+(?:\.\d+)?$/) });
export const genericCoverageSchema = z.strictObject({ tasks: z.number().int().nonnegative(), filled: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), null: z.number().int().nonnegative(), zero: z.number().int().nonnegative() });
export const genericMeasureResultSchema = z.strictObject({ key, operation: z.enum(['sum', 'avg', 'min', 'max', 'count_values', 'count_tasks']), fieldId: idSchema.nullable(), unit: z.enum(['minutes', 'number', 'tasks', 'values']), value: genericReportNumberSchema.nullable(), coverage: genericCoverageSchema });
export const genericComparisonSchema = z.strictObject({ eligibleTasks: z.number().int().nonnegative(), pairedTasks: z.number().int().nonnegative(), plan: genericReportNumberSchema.nullable(), fact: genericReportNumberSchema.nullable(), difference: genericReportNumberSchema.nullable(), ratio: genericReportNumberSchema.nullable(), unavailableReason: z.enum(['no_tasks', 'missing_plan', 'missing_fact', 'zero_plan']).nullable(), planCoverage: genericCoverageSchema, factCoverage: genericCoverageSchema });
export const genericReportCellSchema = z.strictObject({ fieldId: idSchema, state: z.enum(['missing', 'null', 'value', 'not_in_snapshot']), value: z.number().nullable(), valueRevision: z.number().int().nonnegative().nullable(), definitionVersionId: idSchema.nullable() });
export const genericReportRowSchema = z.strictObject({ taskId: idSchema, homeProjectId: idSchema, title: z.string(), taskRevision: revisionSchema, parentTaskId: idSchema.nullable(), primaryAssigneeId: idSchema.nullable(), statusGroup: taskStatusGroupSchema, dueDate: calendarDateSchema.nullable(), groupKey: z.string(), groupLabel: z.string(), placement: z.enum(['home', 'linked']), values: z.array(genericReportCellSchema), initialValues: z.array(genericReportCellSchema).nullable(), cohort: z.enum(['current', 'retained', 'added']), comparison: genericComparisonSchema.nullable(), initialComparison: genericComparisonSchema.nullable() });
export const genericGroupResultSchema = z.strictObject({ key: z.string(), label: z.string(), taskCount: z.number().int().nonnegative(), measures: z.array(genericMeasureResultSchema), comparison: genericComparisonSchema.nullable(), initialComparison: genericComparisonSchema.nullable() });
export const genericReportResultSchema = z.strictObject({
  reportId: idSchema.nullable(), definitionRevision: revisionSchema.nullable(), sourceVersion: z.string().regex(/^[a-f0-9]{64}$/), config: genericReportConfigSchema,
  scope: z.literal('project_presence_canonical_tasks'), hierarchy: z.enum(['all_tasks', 'root_tasks']), attribution: z.literal('primary_assignee'), fields: z.array(taskFieldDefinitionSchema),
  totalTasks: z.number().int().nonnegative(), measures: z.array(genericMeasureResultSchema), initialMeasures: z.array(genericMeasureResultSchema).nullable(), comparison: genericComparisonSchema.nullable(), initialComparison: genericComparisonSchema.nullable(), groups: z.array(genericGroupResultSchema), rows: z.array(genericReportRowSchema), offset: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  capacity:leaveAvailabilitySchema.optional(),initialCapacity:leaveAvailabilitySchema.optional(),
  initialSnapshot: genericInitialSnapshotSchema.nullable(), cohorts: z.strictObject({ initial: z.number().int().nonnegative(), retained: z.number().int().nonnegative(), added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).nullable(),
});
export const genericHeaderWidgetGroupSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('section'),sectionId:idSchema.nullable()}),
  z.strictObject({kind:z.literal('assignee'),membershipId:idSchema.nullable()}),
]);
const headerRangeSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('this_week')}),
  z.strictObject({kind:z.literal('project_dates')}),
  z.strictObject({kind:z.literal('dates'),from:calendarDateSchema,to:calendarDateSchema}).superRefine((v,ctx)=>{if(!leaveAvailabilityInputSchema.safeParse({startDate:v.from,endDate:v.to,people:{kind:'all_active'}}).success)ctx.addIssue({code:'custom',message:'Choose an inclusive range of at most 366 days.'});}),
]);
export const genericHeaderWidgetSchema=z.discriminatedUnion('kind',[
  z.strictObject({key,label:name.optional(),kind:z.literal('measure'),measure:genericReportMeasureSchema}),
  z.strictObject({key,label:name.optional(),kind:z.literal('capacity'),membershipId:idSchema,range:headerRangeSchema,override:z.strictObject({minutes:z.number().int().min(0).max(527040),note:z.string().trim().max(200).optional()}).optional()}),
]);
export const genericHeaderWidgetRuleSchema=z.strictObject({group:genericHeaderWidgetGroupSchema,widgets:z.array(genericHeaderWidgetSchema).max(4).refine(w=>unique(w.map(widget=>widget.key)),'Widget keys must be unique in a group.')});
export const genericHeaderWidgetsSchema=z.array(genericHeaderWidgetRuleSchema).max(100).refine(rules=>unique(rules.map(rule=>rule.group.kind+':'+(rule.group.kind==='section'?rule.group.sectionId:rule.group.membershipId))),'Each group may have only one header rule.').refine(rules=>new Set(rules.flatMap(rule=>rule.widgets.flatMap(widget=>widget.kind==='measure'&&widget.measure.operation!=='count_tasks'?[widget.measure.fieldId]:[]))).size<=12,'Choose at most 12 distinct metric fields across header widgets.');
export const queryGenericHeaderWidgetsInputSchema=z.strictObject({expectedSettingsRevision:z.number().int().nonnegative(),groupBy:z.enum(['section','assignee']),hierarchy:z.enum(['all_tasks','root_tasks']),filters:genericReportFiltersSchema,expectedSourceVersion:z.string().regex(/^[a-f0-9]{64}$/).optional()});
const headerMeasureResultSchema=z.strictObject({key,label:name.optional(),kind:z.literal('measure'),result:genericMeasureResultSchema.nullable(),unavailableReason:z.enum(['field_unavailable','group_unavailable']).nullable()});
const headerCapacityResultSchema=z.strictObject({key,label:name.optional(),kind:z.literal('capacity'),membershipId:idSchema,range:z.strictObject({from:calendarDateSchema,to:calendarDateSchema}).nullable(),person:leaveCapacityMemberSchema.nullable(),computedAvailableMinutes:z.number().int().nonnegative().nullable(),displayAvailableMinutes:z.number().int().nonnegative().nullable(),manualOverride:z.boolean(),overrideNote:z.string().max(200).optional(),unavailableReason:z.enum(['member_unavailable','schedule_unknown','group_unavailable','project_dates_missing','project_dates_too_long']).nullable()});
export const genericHeaderWidgetsResultSchema=z.strictObject({projectId:idSchema,settingsRevision:z.number().int().nonnegative(),sourceVersion:z.string().regex(/^[a-f0-9]{64}$/),groupBy:z.enum(['section','assignee']),hierarchy:z.enum(['all_tasks','root_tasks']),filters:genericReportFiltersSchema,groups:z.array(z.strictObject({group:genericHeaderWidgetGroupSchema,widgets:z.array(z.discriminatedUnion('kind',[headerMeasureResultSchema,headerCapacityResultSchema])).max(4)})).max(100)});
export const genericHeaderWidgetsResponseSchema=envelopeSchema(genericHeaderWidgetsResultSchema);
export const genericAggregateSettingsSchema = z.strictObject({ workspaceId: idSchema, projectId: idSchema, revision: z.number().int().nonnegative(), measures: z.array(genericReportMeasureSchema).max(12).refine(v => unique(v.map(m => m.key))), headerWidgets:genericHeaderWidgetsSchema.optional() });
export const setGenericAggregateSettingsInputSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), measures: z.array(genericReportMeasureSchema).max(12).refine(v => unique(v.map(m => m.key))), headerWidgets:genericHeaderWidgetsSchema.optional() });
export const planFactTemplateInputSchema = z.strictObject({ planName: name, factName: name, reportName: name, expectedColumnsRevision: revisionSchema }).refine(v => v.planName.toLowerCase() !== v.factName.toLowerCase(), 'Choose different field names.');
export const planFactTemplateResultSchema = z.strictObject({ fields: z.tuple([taskFieldDefinitionSchema, taskFieldDefinitionSchema]), columns: projectColumnsSchema, report: genericReportDefinitionSchema });
export const genericReportDefinitionResponseSchema = envelopeSchema(genericReportDefinitionSchema);
export const genericReportDefinitionListResponseSchema = envelopeSchema(z.array(genericReportDefinitionSchema));
export const genericReportResultResponseSchema = envelopeSchema(genericReportResultSchema);
export const genericInitialSnapshotResponseSchema = envelopeSchema(genericInitialSnapshotSchema);
export const genericInitialSnapshotListResponseSchema = envelopeSchema(z.array(genericInitialSnapshotSchema));
export const genericAggregateSettingsResponseSchema = envelopeSchema(genericAggregateSettingsSchema);
export const planFactTemplateResultResponseSchema = envelopeSchema(planFactTemplateResultSchema);
export type GenericReportConfig = z.infer<typeof genericReportConfigSchema>;
export type GenericReportMeasure = z.infer<typeof genericReportMeasureSchema>;
export type GenericReportDefinitionDto = z.infer<typeof genericReportDefinitionSchema>;
export type CreateGenericReportInput = z.infer<typeof createGenericReportInputSchema>;
export type UpdateGenericReportInput = z.infer<typeof updateGenericReportInputSchema>;
export type QueryGenericReportInput = z.infer<typeof queryGenericReportInputSchema>;
export type QueryGenericAggregatesInput = z.infer<typeof queryGenericAggregatesInputSchema>;
export type CaptureGenericInitialInput = z.infer<typeof captureGenericInitialInputSchema>;
export type GenericInitialSnapshotDto = z.infer<typeof genericInitialSnapshotSchema>;
export type GenericReportNumberDto = z.infer<typeof genericReportNumberSchema>;
export type GenericCoverageDto = z.infer<typeof genericCoverageSchema>;
export type GenericMeasureResultDto = z.infer<typeof genericMeasureResultSchema>;
export type GenericComparisonDto = z.infer<typeof genericComparisonSchema>;
export type GenericReportCellDto = z.infer<typeof genericReportCellSchema>;
export type GenericReportRowDto = z.infer<typeof genericReportRowSchema>;
export type GenericGroupResultDto = z.infer<typeof genericGroupResultSchema>;
export type GenericReportResultDto = z.infer<typeof genericReportResultSchema>;
export type GenericAggregateSettingsDto = z.infer<typeof genericAggregateSettingsSchema>;
export type SetGenericAggregateSettingsInput = z.infer<typeof setGenericAggregateSettingsInputSchema>;
export type PlanFactTemplateInput = z.infer<typeof planFactTemplateInputSchema>;
export type PlanFactTemplateResultDto = z.infer<typeof planFactTemplateResultSchema>;

export type GenericHeaderWidgetGroupDto=z.infer<typeof genericHeaderWidgetGroupSchema>;
export type GenericHeaderWidgetDto=z.infer<typeof genericHeaderWidgetSchema>;
export type GenericHeaderWidgetRuleDto=z.infer<typeof genericHeaderWidgetRuleSchema>;
export type QueryGenericHeaderWidgetsInput=z.infer<typeof queryGenericHeaderWidgetsInputSchema>;
export type GenericHeaderWidgetsResultDto=z.infer<typeof genericHeaderWidgetsResultSchema>;
