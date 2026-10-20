import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';
import { utcTimestampSchema } from './tasks.js';
import { genericHeaderWidgetGroupSchema, genericHeaderWidgetSchema, genericReportMeasureSchema, genericReportFiltersSchema } from './generic-reports.js';
import { planningCheckRuleSchema, planningCheckRangeSchema, planningCheckBandSchema, planningCheckDateSourceSchema } from './planning-checks.js';
const name=z.string().trim().min(1).max(160), key=z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/), revision=z.number().int().nonnegative(), version=z.string().regex(/^[a-f0-9]{64}$/);
export const summaryTemplatePersonSchema=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('selected'),membershipId:idSchema}),z.strictObject({kind:z.literal('group_assignee')})]).nullable();
export const summaryTemplateWidgetSchema=z.discriminatedUnion('kind',[
 z.strictObject({key,label:name.optional(),kind:z.literal('measure'),measure:genericReportMeasureSchema}),
 z.strictObject({key,label:name.optional(),kind:z.literal('capacity'),override:z.strictObject({minutes:z.number().int().min(0).max(527040),note:z.string().trim().max(200).optional()}).optional()}),
 z.strictObject({key,label:name.optional(),kind:z.literal('personal_effort'),fieldId:idSchema}),
]);
export const summaryTemplateBalanceCheckSchema=z.strictObject({id:idSchema,name,enabled:z.boolean(),kind:z.literal('balance'),hierarchy:z.enum(['all_tasks','root_tasks']),filters:genericReportFiltersSchema,sumFieldId:idSchema,source:z.literal('personal_effort').optional(),cohort:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('all_tasks')}),z.strictObject({kind:z.literal('task_dates'),source:planningCheckDateSourceSchema,range:planningCheckRangeSchema})]),missingPlan:z.enum(['unknown','known_only']),target:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('capacity'),basis:z.enum(['computed','configured_manual']),manualMinutes:z.number().int().min(0).max(527040).optional()}),z.strictObject({kind:z.literal('fixed'),unit:z.enum(['number','minutes']),value:z.number().finite().min(0).max(1_000_000_000_000)})]),under:planningCheckBandSchema,over:planningCheckBandSchema});
const parts={widgets:z.array(summaryTemplateWidgetSchema).max(4).refine(v=>new Set(v.map(w=>w.key)).size===v.length,'Widget keys must be unique.'),balanceChecks:z.array(summaryTemplateBalanceCheckSchema).max(50).refine(v=>new Set(v.map(w=>w.id)).size===v.length,'Check keys must be unique.'),taskScope:z.enum(['group','selected_person_project']),period:planningCheckRangeSchema};
export const summaryTemplateContentSchema=z.strictObject(parts);
export const summaryTemplateOverridesSchema=z.strictObject({widgets:parts.widgets.optional(),balanceChecks:parts.balanceChecks.optional(),taskScope:parts.taskScope.optional(),period:parts.period.optional()});
export const summaryTemplateDefinitionSchema=z.strictObject({id:idSchema,workspaceId:idSchema,projectId:idSchema,name,revision:revision.min(1),content:summaryTemplateContentSchema,createdAt:utcTimestampSchema,updatedAt:utcTimestampSchema});
export const summaryTemplateBindingSchema=z.strictObject({id:idSchema,workspaceId:idSchema,projectId:idSchema,group:genericHeaderWidgetGroupSchema,templateId:idSchema,revision:revision.min(1),templateRevision:revision.min(1),person:summaryTemplatePersonSchema,overrides:summaryTemplateOverridesSchema,ruleIds:z.record(idSchema,idSchema),resolved:z.strictObject({widgets:z.array(genericHeaderWidgetSchema).max(4),balanceChecks:z.array(planningCheckRuleSchema).max(50)}),detached:z.boolean()});
export const summaryTemplateCatalogSchema=z.strictObject({templates:z.array(summaryTemplateDefinitionSchema).max(100),bindings:z.array(summaryTemplateBindingSchema).max(100),aggregateRevision:revision,checksRevision:revision,sourceVersion:version});
const bind={group:genericHeaderWidgetGroupSchema,person:summaryTemplatePersonSchema};
export const createSummaryTemplateInputSchema=z.strictObject({expectedSourceVersion:version,name,content:summaryTemplateContentSchema,bind:z.strictObject(bind).optional()});
export const updateSummaryTemplateInputSchema=z.strictObject({expectedSourceVersion:version,expectedRevision:revision.min(1),name,content:summaryTemplateContentSchema});
export const bindSummaryTemplateInputSchema=z.strictObject({expectedSourceVersion:version,...bind,templateId:idSchema,expectedTemplateRevision:revision.min(1),overrides:summaryTemplateOverridesSchema});
export const customizeSummaryTemplateInputSchema=z.strictObject({expectedSourceVersion:version,expectedRevision:revision.min(1),person:summaryTemplatePersonSchema,overrides:summaryTemplateOverridesSchema});
export const resetSummaryTemplateInputSchema=z.strictObject({expectedSourceVersion:version,expectedRevision:revision.min(1)});
export const summaryTemplateCatalogResponseSchema=envelopeSchema(summaryTemplateCatalogSchema);
export type SummaryTemplateWidgetDto=z.infer<typeof summaryTemplateWidgetSchema>;
export type SummaryTemplateBalanceCheckDto=z.infer<typeof summaryTemplateBalanceCheckSchema>;
export type SummaryTemplateContentDto=z.infer<typeof summaryTemplateContentSchema>;
export type SummaryTemplateOverridesDto=z.infer<typeof summaryTemplateOverridesSchema>;
export type SummaryTemplatePersonDto=z.infer<typeof summaryTemplatePersonSchema>;
export type SummaryTemplateDefinitionDto=z.infer<typeof summaryTemplateDefinitionSchema>;
export type SummaryTemplateBindingDto=z.infer<typeof summaryTemplateBindingSchema>;
export type SummaryTemplateCatalogDto=z.infer<typeof summaryTemplateCatalogSchema>;
export type CreateSummaryTemplateInput=z.infer<typeof createSummaryTemplateInputSchema>;
export type UpdateSummaryTemplateInput=z.infer<typeof updateSummaryTemplateInputSchema>;
export type BindSummaryTemplateInput=z.infer<typeof bindSummaryTemplateInputSchema>;
export type CustomizeSummaryTemplateInput=z.infer<typeof customizeSummaryTemplateInputSchema>;
export type ResetSummaryTemplateInput=z.infer<typeof resetSummaryTemplateInputSchema>;
export type SummaryTemplateWriteInput=CreateSummaryTemplateInput|UpdateSummaryTemplateInput|BindSummaryTemplateInput|CustomizeSummaryTemplateInput|ResetSummaryTemplateInput;
