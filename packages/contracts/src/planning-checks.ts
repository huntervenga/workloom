import {z} from 'zod';
import {idSchema} from './common/ids.js';
import {envelopeSchema} from './common/envelope.js';
import {calendarDateSchema,utcTimestampSchema} from './tasks.js';
import {genericReportFiltersSchema,genericReportNumberSchema,genericCoverageSchema,genericHeaderWidgetGroupSchema} from './generic-reports.js';
import {leaveAvailabilityInputSchema} from './leave-api.js';
const name=z.string().trim().min(1).max(160),color=z.string().regex(/^#[0-9a-fA-F]{6}$/),count=z.number().int().nonnegative(),version=z.string().regex(/^[a-f0-9]{64}$/);
export const planningCheckRangeSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('this_week')}),z.strictObject({kind:z.literal('project_dates')}),
 z.strictObject({kind:z.literal('dates'),from:calendarDateSchema,to:calendarDateSchema}).refine(v=>leaveAvailabilityInputSchema.safeParse({startDate:v.from,endDate:v.to,people:{kind:'all_active'}}).success,'Choose an inclusive range of at most366 days.'),
]);
export const planningCheckDateSourceSchema=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('due_date')}),z.strictObject({kind:z.literal('field'),fieldId:idSchema})]);
export const planningCheckBandSchema=z.strictObject({enabled:z.boolean(),thresholdBps:z.number().int().min(0).max(1_000_000),fullIntensityAtBps:z.number().int().min(0).max(1_000_000),nearColor:color,farColor:color});
export const planningCheckTargetSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('capacity'),membershipId:idSchema,range:planningCheckRangeSchema,basis:z.enum(['computed','configured_manual']),manualMinutes:z.number().int().min(0).max(527040).optional()}),
 z.strictObject({kind:z.literal('fixed'),unit:z.enum(['number','minutes']),value:z.number().finite().min(0).max(1_000_000_000_000)}),
]);
const common={id:idSchema,name,enabled:z.boolean(),hierarchy:z.enum(['all_tasks','root_tasks']),filters:genericReportFiltersSchema};
export const planningCheckRuleSchema=z.discriminatedUnion('kind',[
 z.strictObject({...common,kind:z.literal('presence'),fieldId:idSchema,color,severity:z.enum(['notice','warning','critical']),requireBeforeDone:z.boolean().optional()}),
 z.strictObject({...common,kind:z.literal('overdue'),dateSource:z.literal('due_date'),warnAfterDays:z.number().int().min(0).max(3660),fullIntensityAfterDays:z.number().int().min(1).max(3660),nearColor:color,farColor:color}),
 z.strictObject({...common,kind:z.literal('balance'),group:genericHeaderWidgetGroupSchema,sumFieldId:idSchema,cohort:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('all_tasks')}),z.strictObject({kind:z.literal('task_dates'),source:planningCheckDateSourceSchema,range:planningCheckRangeSchema})]),missingPlan:z.enum(['unknown','known_only']),target:planningCheckTargetSchema,under:planningCheckBandSchema,over:planningCheckBandSchema}),
]).superRefine((rule,ctx)=>{
 if(rule.kind==='presence'&&rule.requireBeforeDone&&rule.filters.statusGroups.length&&!rule.filters.statusGroups.includes('done'))ctx.addIssue({code:'custom',message:'A completion requirement must include completed tasks in its status scope.'});
 if(rule.kind==='overdue'&&rule.fullIntensityAfterDays<=rule.warnAfterDays)ctx.addIssue({code:'custom',message:'Full intensity must follow the warning threshold.'});
 if(rule.kind==='balance'){
  if(rule.under.enabled&&rule.under.fullIntensityAtBps>=rule.under.thresholdBps)ctx.addIssue({code:'custom',message:'Underplanning full intensity must be below its threshold.'});
  if(rule.over.enabled&&rule.over.fullIntensityAtBps<=rule.over.thresholdBps)ctx.addIssue({code:'custom',message:'Overplanning full intensity must be above its threshold.'});
  if(rule.under.enabled&&rule.over.enabled&&rule.under.thresholdBps>rule.over.thresholdBps)ctx.addIssue({code:'custom',message:'Underplanning threshold must not exceed overplanning threshold.'});
  if(rule.target.kind==='capacity'&&rule.target.basis==='configured_manual'&&rule.target.manualMinutes===undefined)ctx.addIssue({code:'custom',message:'A configured manual planning target requires explicit minutes.'});
 }
});
export const planningCheckConfigSchema=z.strictObject({enabled:z.boolean(),rules:z.array(planningCheckRuleSchema).max(50)}).superRefine((config,ctx)=>{
 if(new Set(config.rules.map(rule=>rule.id)).size!==config.rules.length)ctx.addIssue({code:'custom',message:'Rule identities must be unique.'});
 const ids=new Set(config.rules.flatMap(rule=>[...(rule.kind==='presence'?[rule.fieldId]:rule.kind==='balance'?[rule.sumFieldId,...(rule.cohort.kind==='task_dates'&&rule.cohort.source.kind==='field'?[rule.cohort.source.fieldId]:[])]:[]),...(rule.filters.dateRange?.source.kind==='field'?[rule.filters.dateRange.source.fieldId]:[])]));if(ids.size>12)ctx.addIssue({code:'custom',message:'Choose at most12 distinct custom fields.'});
});
export const planningCheckSettingsSchema=z.strictObject({workspaceId:idSchema,projectId:idSchema,revision:count,config:planningCheckConfigSchema});
export const setPlanningCheckSettingsInputSchema=z.strictObject({expectedRevision:count,config:planningCheckConfigSchema});
export const queryPlanningChecksInputSchema=z.strictObject({expectedSettingsRevision:count,expectedSourceVersion:version.optional()});
const state=z.enum(['ok','warning','unavailable','disabled']);
export const planningCheckReasonSchema=z.enum(['field_unavailable','group_unavailable','member_unavailable','schedule_unknown','project_dates_missing','project_dates_too_long','zero_target','incomplete_plan','no_known_plan','date_field_unavailable','disabled']);
const resolvedRange=z.strictObject({from:calendarDateSchema,to:calendarDateSchema});
export const planningCheckAppearanceSchema=z.strictObject({color,intensityBps:z.number().int().min(0).max(10000)});
export const planningCheckCountsSchema=z.strictObject({eligibleTasks:count,missingRequiredTasks:count,overdueTasks:count,underplannedGroups:count,overplannedGroups:count,unavailableRules:count});
export const planningCheckRuleResultSchema=z.strictObject({ruleId:idSchema,kind:z.enum(['presence','overdue','balance']),state,reason:planningCheckReasonSchema.nullable(),eligibleTasks:count,issueCount:count,undatedTasks:count,appearance:planningCheckAppearanceSchema.nullable()});
export const planningCheckGroupResultSchema=z.strictObject({ruleId:idSchema,group:genericHeaderWidgetGroupSchema,groupKey:z.string().max(80),label:z.string().max(200),state,reason:planningCheckReasonSchema.nullable(),direction:z.enum(['under','within','over']).nullable(),planned:genericReportNumberSchema.nullable(),target:genericReportNumberSchema.nullable(),computedAvailableMinutes:count.nullable(),targetBasis:z.enum(['computed_capacity','configured_manual','fixed']),unit:z.enum(['number','minutes']),ratio:genericReportNumberSchema.nullable(),range:resolvedRange.nullable(),cohortRange:resolvedRange.nullable(),scopeAlignment:z.enum(['same_period','different_periods','all_tasks']),coverage:genericCoverageSchema,undatedTasks:count,appearance:planningCheckAppearanceSchema.nullable()});
const assessmentShape={workspaceId:idSchema,projectId:idSchema,settingsRevision:count,sourceVersion:version,asOf:calendarDateSchema,timezone:z.string().min(1).max(100),scope:z.strictObject({kind:z.literal('configured_project'),placements:z.literal('home_tasks'),taskCount:count,excludedLinkedTasks:count}),enabled:z.boolean(),summary:planningCheckCountsSchema,people:z.array(z.strictObject({membershipId:idSchema.nullable(),displayName:z.string().max(200),counts:planningCheckCountsSchema})).max(101),rules:z.array(planningCheckRuleResultSchema).max(50),groups:z.array(planningCheckGroupResultSchema).max(100)};
export const planningCheckTaskFlagSchema=z.strictObject({taskId:idSchema,sectionId:idSchema.nullable(),primaryAssigneeId:idSchema.nullable(),missingFieldIds:z.array(idSchema).max(12),missingRuleIds:z.array(idSchema).max(50),overdueRuleIds:z.array(idSchema).max(50)});
export const planningCheckAssessmentSchema=z.strictObject({...assessmentShape,taskFlags:z.array(planningCheckTaskFlagSchema).max(5000)});
export const planningCheckIssueQuerySchema=z.strictObject({expectedSettingsRevision:z.coerce.number().int().nonnegative(),expectedSourceVersion:version,ruleId:idSchema,offset:z.coerce.number().int().min(0).max(5000).default(0),limit:z.coerce.number().int().min(1).max(100).default(50)});
export const planningCheckIssuePageSchema=z.strictObject({sourceVersion:version,ruleId:idSchema,total:count,offset:count,limit:count,rows:z.array(z.strictObject({taskId:idSchema,title:z.string().max(500),sectionId:idSchema.nullable(),primaryAssigneeId:idSchema.nullable()})).max(100)});
export const capturePlanningCheckInputSchema=z.strictObject({name,expectedSettingsRevision:count,expectedSourceVersion:version});
export const planningCheckCheckpointHeaderSchema=z.strictObject({id:idSchema,workspaceId:idSchema,projectId:idSchema,name,settingsRevision:count,sourceVersion:version,asOf:calendarDateSchema,capturedAt:utcTimestampSchema,capturedByUserId:idSchema,summary:planningCheckCountsSchema});
/** Neutral immutable history: no task titles, raw values, descriptions, leave types or notes. */
export const planningCheckCheckpointSchema=planningCheckCheckpointHeaderSchema.extend({config:planningCheckConfigSchema,assessment:z.strictObject(assessmentShape)});
export const planningCheckCheckpointListQuerySchema=z.strictObject({offset:z.coerce.number().int().min(0).max(1000).default(0),limit:z.coerce.number().int().min(1).max(100).default(50)});
export const planningCheckCheckpointPageSchema=z.strictObject({total:count,offset:count,limit:count,rows:z.array(planningCheckCheckpointHeaderSchema).max(100)});
export const planningCheckSettingsResponseSchema=envelopeSchema(planningCheckSettingsSchema);
export const planningCheckAssessmentResponseSchema=envelopeSchema(planningCheckAssessmentSchema);
export const planningCheckIssuePageResponseSchema=envelopeSchema(planningCheckIssuePageSchema);
export const planningCheckCheckpointResponseSchema=envelopeSchema(planningCheckCheckpointSchema);
export const planningCheckCheckpointPageResponseSchema=envelopeSchema(planningCheckCheckpointPageSchema);
export type PlanningCheckRuleDto=z.infer<typeof planningCheckRuleSchema>;
export type PlanningCheckConfigDto=z.infer<typeof planningCheckConfigSchema>;
export type PlanningCheckSettingsDto=z.infer<typeof planningCheckSettingsSchema>;
export type SetPlanningCheckSettingsInput=z.infer<typeof setPlanningCheckSettingsInputSchema>;
export type QueryPlanningChecksInput=z.infer<typeof queryPlanningChecksInputSchema>;
export type PlanningCheckAssessmentDto=z.infer<typeof planningCheckAssessmentSchema>;
export type PlanningCheckGroupResultDto=z.infer<typeof planningCheckGroupResultSchema>;
export type PlanningCheckRuleResultDto=z.infer<typeof planningCheckRuleResultSchema>;
export type PlanningCheckCountsDto=z.infer<typeof planningCheckCountsSchema>;
export type PlanningCheckIssueQueryInput=z.infer<typeof planningCheckIssueQuerySchema>;
export type PlanningCheckIssuePageDto=z.infer<typeof planningCheckIssuePageSchema>;
export type CapturePlanningCheckInput=z.infer<typeof capturePlanningCheckInputSchema>;
export type PlanningCheckCheckpointDto=z.infer<typeof planningCheckCheckpointSchema>;
export type PlanningCheckCheckpointHeaderDto=z.infer<typeof planningCheckCheckpointHeaderSchema>;
export type PlanningCheckCheckpointListQueryInput=z.infer<typeof planningCheckCheckpointListQuerySchema>;
export type PlanningCheckCheckpointPageDto=z.infer<typeof planningCheckCheckpointPageSchema>;

export type PlanningCheckRangeDto=z.infer<typeof planningCheckRangeSchema>;
export type PlanningCheckDateSourceDto=z.infer<typeof planningCheckDateSourceSchema>;
export type PlanningCheckBandDto=z.infer<typeof planningCheckBandSchema>;
