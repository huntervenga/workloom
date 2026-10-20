import {and,asc,desc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {planningCheckSettingsSchema,planningCheckCheckpointSchema} from '@workloom/contracts';
import {DomainError,type PlanningCheckRepository} from '@workloom/domain';
import type {WorkloomExecutor} from '../client.js';
import {projectCheckSettings,projectCheckSettingsVersions,projectCheckCheckpoints,taskFieldValues,sections} from '../schema.js';
import {createGenericReportRepository} from '../generic-reports/repository.js';
// Exact ECMAScript String.trim whitespace (including NBSP/BOM); not PostgreSQL btrim(space-only).
const whitespace='[\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]'.replace(/\\u([0-9A-Fa-f]{4})/g,(_match,hex:string)=>String.fromCharCode(Number.parseInt(hex,16)));
export function createPlanningCheckRepository(tx:WorkloomExecutor,workspaceId:string):PlanningCheckRepository{
 const reports=createGenericReportRepository(tx,workspaceId);
 return{
  async settings(projectId){const[row]=await tx.select().from(projectCheckSettings).where(and(eq(projectCheckSettings.workspaceId,workspaceId),eq(projectCheckSettings.projectId,projectId))).limit(1);return row?planningCheckSettingsSchema.parse({workspaceId,projectId,revision:row.revision,config:row.config}):{workspaceId,projectId,revision:0,config:{enabled:false,rules:[]}};},
  async saveSettings(value,actorUserId,at){await tx.insert(projectCheckSettings).values({...value,updatedAt:new Date(at)}).onConflictDoUpdate({target:[projectCheckSettings.workspaceId,projectCheckSettings.projectId],set:{revision:value.revision,config:value.config,updatedAt:new Date(at)}});await tx.insert(projectCheckSettingsVersions).values({workspaceId,projectId:value.projectId,revision:value.revision,snapshot:value,actorUserId,createdAt:new Date(at)});},
  async source(projectId,fieldIds,includeSharedActivities=false){
   const base=await reports.source({projectId,hierarchy:'all_tasks',filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null},groupBy:{kind:'none'},comparison:null,measures:[{key:'tasks',operation:'count_tasks'}]},fieldIds,{includeSharedActivities});
   if(Object.keys(base.memberLabels).length>100)throw new DomainError('DOMAIN_VALIDATION_FAILED','Planning checks support at most100 workspace people.');
   const tasks=base.tasks.filter(task=>task.projectId===projectId),values:Awaited<ReturnType<PlanningCheckRepository['source']>>['values']=[],ids=tasks.map(task=>task.id);
   for(let offset=0;offset<ids.length&&fieldIds.length;offset+=1000){const rows=await tx.select({taskId:taskFieldValues.taskId,fieldId:taskFieldValues.fieldId,revision:taskFieldValues.revision,definitionVersionId:taskFieldValues.definitionVersionId,
    present:sql<boolean>`CASE WHEN ${taskFieldValues.value}->'value' IS NULL OR ${taskFieldValues.value}->'value'='null'::jsonb THEN false WHEN jsonb_typeof(${taskFieldValues.value}->'value')='string' THEN regexp_replace(${taskFieldValues.value}->>'value',${whitespace},'','g')<>'' WHEN jsonb_typeof(${taskFieldValues.value}->'value')='array' THEN jsonb_array_length(${taskFieldValues.value}->'value')>0 ELSE true END`,
    numberText:sql<string|null>`CASE WHEN ${taskFieldValues.value}->>'type' IN ('number','duration') AND jsonb_typeof(${taskFieldValues.value}->'value')='number' THEN ${taskFieldValues.value}->>'value' ELSE NULL END`,
    dateValue:sql<string|null>`CASE WHEN ${taskFieldValues.value}->>'type'='date' AND jsonb_typeof(${taskFieldValues.value}->'value')='string' THEN ${taskFieldValues.value}->>'value' ELSE NULL END`,
   }).from(taskFieldValues).where(and(eq(taskFieldValues.workspaceId,workspaceId),eq(taskFieldValues.projectId,projectId),inArray(taskFieldValues.taskId,ids.slice(offset,offset+1000)),inArray(taskFieldValues.fieldId,[...fieldIds]))).orderBy(asc(taskFieldValues.taskId),asc(taskFieldValues.fieldId));
   for(const row of rows){const numberValue=row.numberText===null?null:Number(row.numberText);if(numberValue!==null&&!Number.isFinite(numberValue))throw new DomainError('DOMAIN_VALIDATION_FAILED','A planning metric is not finite.');const{numberText:_numberText,...rest}=row;values.push({...rest,numberValue});}}
   return{durationValues:base.values.filter(value=>value.value.type==='duration'),sharedActivities:base.sharedActivities??[],head:base.head,fields:base.fields,tasks,values,memberLabels:base.memberLabels,sectionLabels:base.sectionLabels,activeSectionIds:(await tx.select({id:sections.id}).from(sections).where(and(eq(sections.workspaceId,workspaceId),eq(sections.projectId,projectId),isNull(sections.archivedAt)))).map(section=>section.id),excludedLinkedTasks:base.tasks.length-tasks.length};
  },
  async checkpointCount(projectId){const[row]=await tx.select({n:sql<number>`count(*)::integer`}).from(projectCheckCheckpoints).where(and(eq(projectCheckCheckpoints.workspaceId,workspaceId),eq(projectCheckCheckpoints.projectId,projectId)));return row?.n??0;},
  async insertCheckpoint(value){await tx.insert(projectCheckCheckpoints).values({id:value.id,workspaceId,projectId:value.projectId,settingsRevision:value.settingsRevision,snapshot:value,createdAt:new Date(value.capturedAt)});},
  async checkpoints(projectId,offset,limit){const rows=await tx.select().from(projectCheckCheckpoints).where(and(eq(projectCheckCheckpoints.workspaceId,workspaceId),eq(projectCheckCheckpoints.projectId,projectId))).orderBy(desc(projectCheckCheckpoints.createdAt),desc(projectCheckCheckpoints.id)).offset(offset).limit(limit);return{total:await this.checkpointCount(projectId),rows:rows.map(row=>planningCheckCheckpointSchema.parse(row.snapshot))};},
  async checkpoint(projectId,id){const[row]=await tx.select().from(projectCheckCheckpoints).where(and(eq(projectCheckCheckpoints.workspaceId,workspaceId),eq(projectCheckCheckpoints.projectId,projectId),eq(projectCheckCheckpoints.id,id))).limit(1);return row?planningCheckCheckpointSchema.parse(row.snapshot):null;},
 };
}
