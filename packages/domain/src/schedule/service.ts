import {idSchema,taskScheduleBatchInputSchema,taskScheduleApplyInputSchema,taskScheduleContextInputSchema,taskScheduleApplySchema,type TaskDto,type TaskScheduleBatchInput,type TaskScheduleContextQuery,type TaskScheduleApplyInput,type TaskScheduleContextDto,type TaskSchedulePreviewDto,type ScheduleDependencyComparisonDto,type BaselineTaskDatesDto,type BaselineDateValueDto,type TaskDependencyDto,type PlanBaselineDto} from '@workloom/contracts';
import {DomainError,notFoundError} from '../errors.js';
import type {CommandContext} from '../access/context.js';
import type {TaskScheduleApplication} from './application.js';
import type {TaskScheduleApplicationDependencies,TaskScheduleReadScope} from './ports.js';
import {canonicalJson} from '../tasks/service.js';
import {assertOrdinaryTaskDates,assertTaskDateRange} from '../tasks/dates.js';
import {createPlanningMutationGuard,isCommittedPlanningRejection,unwrapPlanningOutcome} from '../planning/freeze.js';
const command='task.schedule.apply' as const;
function required<T>(value:T|null|undefined):T {if(value===null||value===undefined)throw notFoundError();return value;}
function rule(message:string):never {throw new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function parse<T>(schema:{safeParse(v:unknown):{success:true;data:T}|{success:false}},value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new DomainError('VALIDATION_FAILED','Invalid schedule input.');return result.data;}
function ctx(value:CommandContext):CommandContext {return {...value,workspaceId:idSchema.parse(value.workspaceId),actor:{...value.actor,userId:idSchema.parse(value.actor.userId)}};}
function dateValue(value:string|null|undefined):BaselineDateValueDto {return value===undefined?{state:'not_captured'}:value===null?{state:'not_set'}:{state:'set',value};}
function baselineDates(b:PlanBaselineDto|null,t:TaskDto):BaselineTaskDatesDto {if(!b)return {state:'not_selected'};const old=b.snapshot.tasks.find(x=>x.id===t.id);return old?{state:'captured',startDate:dateValue(old.startDate),dueDate:dateValue(old.dueDate)}:{state:'not_in_baseline'};}
export function createTaskScheduleApplication({writer,tools}:TaskScheduleApplicationDependencies):TaskScheduleApplication {
 const digest=(v:unknown)=>tools.digest(canonicalJson(v));
 async function targetAccess(scope:TaskScheduleReadScope,projectId:string,ids:string[]) {
  const ws=scope.context.workspaceId,repo=scope.dependencies;
  if(!await repo.tasks.findProject(ws,projectId))throw notFoundError();
  const targets=await repo.tasks.findTasksByIds(ws,ids),map=new Map(targets.map(t=>[t.id,t]));
  for(const id of ids){const t=map.get(id);if(!t)throw notFoundError();if(t.projectId!==projectId)rule('Every scheduled task must belong to the path project.');}
  return ids.map(id=>required(map.get(id)));
 }
 async function sources(scope:TaskScheduleReadScope,projectId:string,ids:string[]) {
  const ws=scope.context.workspaceId,repo=scope.dependencies,targets=await targetAccess(scope,projectId,ids);
  const edges=await repo.incidentEdges(ws,ids,1001);if(edges.length>1000)rule('Too many dependency comparisons. Narrow the task selection.');
  const endpointIds=[...new Set([...ids,...edges.flatMap(e=>[e.predecessorTaskId,e.successorTaskId])])].sort();
  const projections=await repo.taskContexts(ws,endpointIds);const endpoints=new Map(projections.map(p=>[p.task.id,p]));
  if(endpointIds.some(id=>!endpoints.has(id)))throw notFoundError();
  const projects=[...new Set(projections.map(p=>p.task.projectId))].sort();
  const policies=await repo.getPolicies(ws,projects),counts=await repo.unresolvedCounts(ws,ids);
  return {targets,edges,endpoints,projects,policies,counts};
 }
 function compare(source:Awaited<ReturnType<typeof sources>>,desired:Map<string,{startDate:string|null;dueDate:string|null}>):ScheduleDependencyComparisonDto[] {
  return source.edges.map((edge:TaskDependencyDto)=>{const p=required(source.endpoints.get(edge.predecessorTaskId)),s=required(source.endpoints.get(edge.successorTaskId));
   const predecessorDueDate=desired.has(p.task.id)?required(desired.get(p.task.id)).dueDate:p.task.dueDate;
   const successorStartDate=desired.has(s.task.id)?required(desired.get(s.task.id)).startDate:s.task.startDate??null;
   const common={dependencyId:edge.id,predecessorTaskId:p.task.id,successorTaskId:s.task.id,predecessorDueDate,successorStartDate,predecessorContext:p.context,successorContext:s.context};
   if(p.task.meetingId||s.task.meetingId)return {...common,state:'unknown' as const,reason:'meeting_calendar' as const};
   if(predecessorDueDate===null||successorStartDate===null)return {...common,state:'unknown' as const,reason:'missing_date' as const};
   return {...common,state:successorStartDate<=predecessorDueDate?'conflict' as const:'compatible' as const};
  });
 }
 async function build(scope:TaskScheduleReadScope,projectId:string,input:TaskScheduleBatchInput) {
  const source=await sources(scope,projectId,input.rows.map(r=>r.taskId)),ws=scope.context.workspaceId;
  for(const [index,row] of input.rows.entries()){const t=required(source.targets[index]);if(t.revision!==row.expectedRevision)throw new DomainError('REVISION_CONFLICT','A task changed. Refresh its revision and preview again.');assertTaskDateRange(row.startDate,row.dueDate);}
  const targetIds=new Set(source.targets.map(t=>t.id)),packageIds=new Set(source.targets.map(t=>t.workPackageId));
  const locks=(await scope.repository.listLocks(ws,{taskIds:[...targetIds],workPackageIds:[...packageIds]})).filter(l=>(l.taskId!==null&&targetIds.has(l.taskId))||(l.workPackageId!==null&&packageIds.has(l.workPackageId)));
  const periods=[],census=[],recoveryPeriodIds:string[]=[];
  const sourcePeriods=(await Promise.all(source.projects.map(id=>scope.repository.listPeriods(ws,id)))).flat();
  for(const period of sourcePeriods){
   if(!source.projects.includes(period.projectId))continue;
   const commitments=await scope.repository.listCommitments(ws,period.id);
   const relevant=commitments.some(c=>packageIds.has(c.workPackageId)||c.allocations.some(a=>targetIds.has(a.taskId)));
   if(relevant)periods.push({id:period.id,revision:period.revision,state:period.state,cutoffAt:period.cutoffAt});
   if(period.state==='planning'){
    const assessment=await scope.recurrenceCensus.assessPeriod(period);
    if(relevant||assessment.status!=='complete')census.push(assessment);
    if(assessment.status!=='complete'||Date.parse(period.cutoffAt)<=scope.barrierAt.getTime())recoveryPeriodIds.push(period.id);
   }
  }
  const manifest={version:1,actorUserId:scope.context.actor.userId,workspaceId:ws,projectId,permissionEpoch:await scope.dependencies.tasks.permissionEpoch(ws),desiredRows:input.rows,
   targets:source.targets.map(t=>({id:t.id,revision:t.revision,startDate:t.startDate??null,dueDate:t.dueDate,meetingId:t.meetingId??null,archivedAt:t.archivedAt})),
   dependencies:[...source.edges].sort((a,b)=>a.id.localeCompare(b.id)), endpoints:[...source.endpoints.values()].map(p=>({id:p.task.id,revision:p.task.revision,startDate:p.task.startDate??null,dueDate:p.task.dueDate,meetingId:p.task.meetingId??null,context:p.context})).sort((a,b)=>a.id.localeCompare(b.id)),policies:[...source.policies.values()].sort((a,b)=>a.projectId.localeCompare(b.projectId)),locks:locks.sort((a,b)=>a.id.localeCompare(b.id)),periods:periods.sort((a,b)=>a.id.localeCompare(b.id)),census:census.sort((a,b)=>a.periodId.localeCompare(b.periodId))};
  const preview:TaskSchedulePreviewDto={projectId,previewHash:digest(manifest),asOfChangeSeq:await scope.dependencies.currentChangeSeq(ws),rows:input.rows.map((r,i)=>{const t=required(source.targets[i]),before={startDate:t.startDate??null,dueDate:t.dueDate},after={startDate:r.startDate,dueDate:r.dueDate};return {taskId:t.id,expectedRevision:r.expectedRevision,before,after,changed:before.startDate!==after.startDate||before.dueDate!==after.dueDate};}),comparisons:compare(source,new Map(input.rows.map(r=>[r.taskId,r]))),protectedTargets:source.targets.flatMap<TaskSchedulePreviewDto['protectedTargets'][number]>(t=>t.meetingId?[{taskId:t.id,reason:'meeting_task' as const}]:t.archivedAt?[{taskId:t.id,reason:'archived_task' as const}]:[]),recoveryPeriodIds:recoveryPeriodIds.sort()};
  return {source,preview};
 }
 return {
  async getScheduleContext(context,projectPath,query:TaskScheduleContextQuery):Promise<TaskScheduleContextDto>{const c=ctx(context),projectId=idSchema.parse(projectPath),q=parse(taskScheduleContextInputSchema,query);return writer.read(c,'task.read',async scope=>{
   const source=await sources(scope,projectId,q.taskIds),ws=c.workspaceId;
   const baseline=q.baselineId?await scope.repository.findBaseline(ws,q.baselineId):null;
   if(q.baselineId&&!baseline)throw notFoundError();if(baseline&&baseline.projectId!==projectId)rule('Baseline belongs to another project.');
   return {projectId,asOfChangeSeq:await scope.dependencies.currentChangeSeq(ws),baseline:baseline?{baselineId:baseline.id,periodId:baseline.periodId,scope:baseline.scope,membershipId:baseline.membershipId,frozenAt:baseline.frozenAt,sourcePersonalBaselineIds:baseline.snapshot.sourcePersonalBaselineIds}:null,rows:source.targets.map(t=>{const policy=required(source.policies.get(t.projectId)),unresolvedCount=source.counts.get(t.id)??0,status=required(source.endpoints.get(t.id)).context.status.group,isBlocked=unresolvedCount>0;return {taskId:t.id,taskRevision:t.revision,current:{startDate:t.startDate??null,dueDate:t.dueDate},meetingId:t.meetingId??null,editableDates:!t.meetingId&&!t.archivedAt,blocking:{taskId:t.id,policy:{projectId:policy.projectId,mode:policy.mode,revision:policy.revision},isBlocked,unresolvedCount,canStart:policy.mode==='warn'||!isBlocked,canComplete:policy.mode==='warn'||!isBlocked,violatesCurrentStatus:policy.mode==='enforce'&&isBlocked&&(status==='in_progress'||status==='done')},baselineDates:baselineDates(baseline,t)};}),comparisons:compare(source,new Map())};
  });},
  async previewSchedule(context,projectPath,input){const c=ctx(context),projectId=idSchema.parse(projectPath),p=parse(taskScheduleBatchInputSchema,input);return writer.read(c,'task.edit',async scope=>(await build(scope,projectId,p)).preview);},
  async applySchedule(context,projectPath,input:TaskScheduleApplyInput){const c=ctx(context),projectId=idSchema.parse(projectPath),p=parse(taskScheduleApplyInputSchema,input),key=c.idempotencyKey;if(!key||! /^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');const payloadHash=digest({command,target:{projectId},input:p});
   const outcome=await writer.run(c,'task.edit',async scope=>{
    // Current target access before receipt replay; eligibility and expected revisions belong after replay.
    await targetAccess(scope,projectId,p.rows.map(r=>r.taskId));
    const tasks=scope.repository.tasks,ws=c.workspaceId,existing=await tasks.findIdempotency(ws,c.actor.userId,command,key);
    if(existing){if(existing.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key belongs to another schedule request.');if(isCommittedPlanningRejection(existing.result))return existing.result;return parse(taskScheduleApplySchema,existing.result);}
    const before=await build(scope,projectId,{rows:p.rows});if(before.preview.previewHash!==p.previewHash)throw new DomainError('PREVIEW_STALE','Schedule sources changed. Preview again.');
    if(before.preview.protectedTargets.length)rule('Meeting or archived task dates require their guarded editor or restore.');
    const rejected=await createPlanningMutationGuard(scope,tools).check({family:'schedule',command,target:{projectId,affectedProjectIds:before.source.projects},input:{rows:p.rows},previewMatches:async()=> (await build(scope,projectId,{rows:p.rows})).preview.previewHash===p.previewHash});
    let result;if(rejected)result=rejected;else{
     const updated:TaskDto[]=[];
     for(const row of p.rows){const task=await tasks.findTask(ws,row.taskId);if(!task)throw notFoundError();assertOrdinaryTaskDates(task,row);
      if((task.startDate??null)!==row.startDate||task.dueDate!==row.dueDate){const next={...task,startDate:row.startDate,dueDate:row.dueDate,revision:task.revision+1,updatedAt:scope.barrierAt.toISOString()};await tasks.saveTaskCore(next);await scope.recordChange({entityType:'task',entityId:task.id,action:'schedule_updated',entityRevision:next.revision,diff:{startDate:{from:task.startDate??null,to:row.startDate},dueDate:{from:task.dueDate,to:row.dueDate}},outbox:{type:'task.schedule_updated',payload:{taskId:task.id,projectId,revision:next.revision}}});updated.push(next);}else updated.push(task);
     }
     result={projectId,tasks:updated,asOfChangeSeq:await scope.dependencies.currentChangeSeq(ws)};
    }
    await tasks.insertIdempotency({workspaceId:ws,actorUserId:c.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:scope.barrierAt.toISOString()});return result;
   });return unwrapPlanningOutcome(outcome);
  },
 };
}
