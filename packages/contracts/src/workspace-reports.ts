import {z} from 'zod';
import {envelopeSchema} from './common/envelope.js';
import {idSchema} from './common/ids.js';
import {calendarDateSchema,revisionSchema} from './tasks.js';
import {taskFieldDefinitionSchema} from './fields.js';
import {genericReportDefinitionSchema,genericMeasureResultSchema,genericComparisonSchema} from './generic-reports.js';
import {leavePeopleSchema,leaveAvailabilityInputSchema,leaveAvailabilitySchema,leaveCapacityMemberSchema} from './leave-api.js';
const unique=(values:readonly string[])=>new Set(values).size===values.length;
export const workspaceReportSourceSchema=z.strictObject({projectId:idSchema,projectName:z.string(),report:genericReportDefinitionSchema,fields:z.array(taskFieldDefinitionSchema).max(200)});
export const workspaceReportSourcesSchema=z.strictObject({today:calendarDateSchema,timezone:z.string(),sources:z.array(workspaceReportSourceSchema).max(1000),members:z.array(z.strictObject({membershipId:idSchema,displayName:z.string(),avatarUrl:z.string().nullable()})).max(100)});
export const workspaceReportBindingSchema=z.strictObject({reportId:idSchema,expectedRevision:revisionSchema,categoryFieldId:idSchema.nullable().optional()});
/** Saved reports supply field bindings only. Their people/date/tag/status filters are not inherited. */
export const workspaceReportQueryInputSchema=z.strictObject({
 sources:z.array(workspaceReportBindingSchema).min(1).max(20).refine(v=>unique(v.map(s=>s.reportId))),
 range:z.strictObject({from:calendarDateSchema,to:calendarDateSchema}),
 bucket:z.enum(['week','month']),people:leavePeopleSchema,
 dateSource:z.enum(['due_date','report_date_field']),
 hierarchy:z.enum(['all_tasks','root_tasks']).default('all_tasks'),
 completion:z.enum(['all_tasks','done_only']).default('done_only'),
 expectedSourceVersion:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).superRefine((v,ctx)=>{const range=leaveAvailabilityInputSchema.safeParse({startDate:v.range.from,endDate:v.range.to,people:v.people});if(!range.success)ctx.addIssue({code:'custom',path:['range'],message:'Choose an inclusive calendar range of at most 366 days in years 1900–2200.'});});
export const workspaceReportSummarySchema=z.strictObject({taskCount:z.number().int().nonnegative(),plan:genericMeasureResultSchema,fact:genericMeasureResultSchema,comparison:genericComparisonSchema});
export const workspaceReportCategorySchema=workspaceReportSummarySchema.extend({key:z.string(),label:z.string(),projectId:idSchema.nullable(),projectName:z.string().nullable(),fieldId:idSchema.nullable(),optionId:idSchema.nullable()});
export const workspaceReportPersonSchema=workspaceReportSummarySchema.extend({membershipId:idSchema.nullable(),displayName:z.string(),capacity:leaveCapacityMemberSchema.nullable(),categories:z.array(workspaceReportCategorySchema)});
export const workspaceReportBucketSchema=workspaceReportSummarySchema.extend({startDate:calendarDateSchema,endDate:calendarDateSchema,capacity:z.strictObject({scheduledMinutes:z.number().int().nonnegative().nullable(),holidayMinutes:z.number().int().nonnegative().nullable(),absenceMinutes:z.number().int().nonnegative().nullable(),availableMinutes:z.number().int().nonnegative().nullable(),unconfiguredMembers:z.number().int().nonnegative()}),people:z.array(workspaceReportPersonSchema).max(101)});
export const workspaceReportBoundSourceSchema=z.strictObject({projectId:idSchema,projectName:z.string(),reportId:idSchema,reportName:z.string(),revision:revisionSchema,planFieldId:idSchema,planFieldName:z.string(),factFieldId:idSchema,factFieldName:z.string(),categoryFieldId:idSchema.nullable(),categoryFieldName:z.string().nullable(),dateFieldId:idSchema.nullable(),dateFieldName:z.string().nullable()});
export const workspaceReportTaskSchema=z.strictObject({taskId:idSchema,homeProjectId:idSchema,title:z.string(),primaryAssigneeId:idSchema.nullable(),date:calendarDateSchema.nullable(),statusGroup:z.enum(['todo','in_progress','done','cancelled']),planState:z.enum(['missing','null','value']),factState:z.enum(['missing','null','value']),planMinutes:z.number().nullable(),factMinutes:z.number().nullable(),categoryKey:z.string()});
export const workspaceReportResultSchema=z.strictObject({
 sourceVersion:z.string().regex(/^[a-f0-9]{64}$/),scope:z.literal('selected_projects_canonical_tasks'),filterSemantics:z.literal('bindings_only'),attribution:z.literal('primary_assignee'),dateSemantics:z.literal('current_task_cohort'),
 range:z.strictObject({from:calendarDateSchema,to:calendarDateSchema}),bucket:z.enum(['week','month']),dateSource:z.enum(['due_date','report_date_field']),hierarchy:z.enum(['all_tasks','root_tasks']),completion:z.enum(['all_tasks','done_only']),
 sources:z.array(workspaceReportBoundSourceSchema).max(20),summary:workspaceReportSummarySchema,people:z.array(workspaceReportPersonSchema).max(101),categories:z.array(workspaceReportCategorySchema),buckets:z.array(workspaceReportBucketSchema).max(54),capacity:leaveAvailabilitySchema,
 missingDateTasks:z.number().int().nonnegative(),unmappedHomeTasks:z.number().int().nonnegative(),rows:z.array(workspaceReportTaskSchema).max(5000),
});
export const workspaceReportSourcesResponseSchema=envelopeSchema(workspaceReportSourcesSchema);
export const workspaceReportResultResponseSchema=envelopeSchema(workspaceReportResultSchema);
export type WorkspaceReportSourceDto=z.infer<typeof workspaceReportSourceSchema>;
export type WorkspaceReportSourcesDto=z.infer<typeof workspaceReportSourcesSchema>;
export type WorkspaceReportQueryInput=z.infer<typeof workspaceReportQueryInputSchema>;
export type WorkspaceReportSummaryDto=z.infer<typeof workspaceReportSummarySchema>;
export type WorkspaceReportCategoryDto=z.infer<typeof workspaceReportCategorySchema>;
export type WorkspaceReportPersonDto=z.infer<typeof workspaceReportPersonSchema>;
export type WorkspaceReportBucketDto=z.infer<typeof workspaceReportBucketSchema>;
export type WorkspaceReportBoundSourceDto=z.infer<typeof workspaceReportBoundSourceSchema>;
export type WorkspaceReportTaskDto=z.infer<typeof workspaceReportTaskSchema>;
export type WorkspaceReportResultDto=z.infer<typeof workspaceReportResultSchema>;
