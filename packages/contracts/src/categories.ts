import {z} from 'zod';
import {envelopeSchema} from './common/envelope.js';
import {idSchema} from './common/ids.js';
import {workCategorySnapshotSchema} from './common/work-category.js';
import {manualPeriodWorkLogSchema,periodCommitmentSchema,planningPageQuerySchema} from './planning.js';
import {revisionSchema,utcTimestampSchema} from './tasks.js';

/** Exact P2b catalog: docs/14-p2b-contract.md. All writes keyed, trusted context first. */
const uniqueIds=z.array(idSchema).max(100).refine(ids=>new Set(ids).size===ids.length,'Duplicate membership IDs.');
const amount=z.number().int().nonnegative();
export const projectWorkCategoryBindingSchema=z.object({workspaceId:idSchema,projectId:idSchema,revision:revisionSchema,versionId:idSchema.nullable(),fieldId:idSchema.nullable(),availability:z.enum(['unbound','active','field_archived'])});
export const updateProjectWorkCategoryBindingInputSchema=z.strictObject({expectedRevision:revisionSchema,fieldId:idSchema.nullable()});
export const categorizedWorkLogSchema=manualPeriodWorkLogSchema.extend({category:workCategorySnapshotSchema});
export const recategorizeWorkLogInputSchema=z.strictObject({expectedWorkLogRevision:revisionSchema,expectedBindingRevision:revisionSchema,optionId:idSchema.nullable(),reason:z.string().trim().min(1).max(1000)});
export const createWorkTypeReportRunInputSchema=z.strictObject({periodId:idSchema,membershipIds:uniqueIds.default([])});
export const workTypeReportRunListQuerySchema=planningPageQuerySchema.extend({periodId:idSchema});
export const workTypeBucketSchema=z.object({key:z.string().min(1).max(100),fieldId:idSchema.nullable(),optionId:idSchema.nullable(),label:z.string(),color:z.string().nullable(),minutes:amount,sharePercent:z.number().finite().min(0).max(100).nullable()});
export const workTypeReportRunSchema=z.object({
 id:idSchema,workspaceId:idSchema,projectId:idSchema,periodId:idSchema,metricVersion:z.literal('weekly_work_type_v1'),
 createdAt:utcTimestampSchema,actorUserId:idSchema,factCutoffAt:utcTimestampSchema,factChangeSeq:z.string().regex(/^(0|[1-9][0-9]*)$/),
 membershipIds:z.array(idSchema).max(1000),totalActualMinutes:amount,activeSourceCount:amount,categorizedMinutes:amount,uncategorizedMinutes:amount,
 byCategory:z.array(workTypeBucketSchema).max(1000),
 byPerson:z.array(z.object({membershipId:idSchema,memberName:z.string(),totalActualMinutes:amount,activeSourceCount:amount,byCategory:z.array(workTypeBucketSchema).max(1000)})).max(1000),
 rowCount:amount,workLogRevisionIds:z.array(idSchema).refine(ids=>new Set(ids).size===ids.length,'Duplicate pinned revision IDs.'),
 labelPolicy:z.literal('highest_option_revision_then_change_seq_then_id'),
});
export const workTypeReportRowSchema=z.object({id:idSchema,workLog:categorizedWorkLogSchema,taskTitle:z.string(),memberName:z.string(),excluded:z.boolean()});
export const taskTimeSummaryQuerySchema=z.strictObject({
 taskIds:z.string().min(1).transform((csv,ctx)=>{
  const values=csv.split(',');const ids:string[]=[];
  if(values.length<1||values.length>100){ctx.addIssue({code:'custom',message:'Provide 1–100 task IDs.'});return z.NEVER;}
  for(const value of values){const parsed=idSchema.safeParse(value);if(!parsed.success){ctx.addIssue({code:'custom',message:'Invalid task ID.'});return z.NEVER;}ids.push(parsed.data);}
  if(new Set(ids).size!==ids.length){ctx.addIssue({code:'custom',message:'Duplicate task IDs.'});return z.NEVER;}
  return ids.sort();
 }),membershipId:idSchema.optional(),
});
export const taskTimeSummaryInputSchema=z.strictObject({taskIds:z.array(idSchema).min(1).max(100).refine(ids=>new Set(ids).size===ids.length,'Duplicate task IDs.').transform(ids=>[...ids].sort()),membershipId:idSchema.optional()});
export const taskTimeRowSchema=z.object({taskId:idSchema,workPackageId:idSchema,currentAllocationMinutes:amount.nullable(),ownManualWork:categorizedWorkLogSchema.nullable(),subjectActualMinutes:amount,taskActualMinutes:amount,subjectActiveSourceCount:amount,taskActiveSourceCount:amount,hasOtherSources:z.boolean()});
export const packageTimeRowSchema=z.object({workPackageId:idSchema,commitment:periodCommitmentSchema.nullable(),subjectActualMinutes:amount,totalActualMinutes:amount,subjectActiveSourceCount:amount,totalActiveSourceCount:amount});
export const taskTimeSummarySchema=z.object({workspaceId:idSchema,projectId:idSchema,periodId:idSchema,subjectMembershipId:idSchema,asOfChangeSeq:z.string().regex(/^(0|[1-9][0-9]*)$/),tasks:z.array(taskTimeRowSchema).max(100),packages:z.array(packageTimeRowSchema).max(100)});

export const projectWorkCategoryBindingResponseSchema=envelopeSchema(projectWorkCategoryBindingSchema);
export const categorizedWorkLogResponseSchema=envelopeSchema(categorizedWorkLogSchema);
export const workTypeReportRunResponseSchema=envelopeSchema(workTypeReportRunSchema);
export const workTypeReportRunListResponseSchema=envelopeSchema(z.array(workTypeReportRunSchema));
export const workTypeReportRowListResponseSchema=envelopeSchema(z.array(workTypeReportRowSchema));
export const taskTimeSummaryResponseSchema=envelopeSchema(taskTimeSummarySchema);
export type ProjectWorkCategoryBindingDto=z.infer<typeof projectWorkCategoryBindingSchema>;
export type UpdateProjectWorkCategoryBindingInput=z.infer<typeof updateProjectWorkCategoryBindingInputSchema>;
export type CategorizedWorkLogDto=z.infer<typeof categorizedWorkLogSchema>;
export type RecategorizeWorkLogInput=z.infer<typeof recategorizeWorkLogInputSchema>;
export type CreateWorkTypeReportRunInput=z.infer<typeof createWorkTypeReportRunInputSchema>;
export type WorkTypeReportRunListQuery=z.infer<typeof workTypeReportRunListQuerySchema>;
export type WorkTypeBucketDto=z.infer<typeof workTypeBucketSchema>;
export type WorkTypeReportRunDto=z.infer<typeof workTypeReportRunSchema>;
export type WorkTypeReportRowDto=z.infer<typeof workTypeReportRowSchema>;
export type TaskTimeSummaryQuery=z.infer<typeof taskTimeSummaryQuerySchema>;
export type TaskTimeRowDto=z.infer<typeof taskTimeRowSchema>;
export type PackageTimeRowDto=z.infer<typeof packageTimeRowSchema>;
export type TaskTimeSummaryDto=z.infer<typeof taskTimeSummarySchema>;
