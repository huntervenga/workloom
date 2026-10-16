import {
 categorizedWorkLogSchema,createWorkTypeReportRunInputSchema,idSchema,planningPageQuerySchema,projectWorkCategoryBindingSchema,
 recategorizeWorkLogInputSchema,taskTimeSummaryInputSchema,updateProjectWorkCategoryBindingInputSchema,
 workTypeReportRunListQuerySchema,workTypeReportRunSchema,
 type CategorizedWorkLogDto,type PlanningPageQuery,type TaskTimeSummaryDto,type WorkCategorySnapshot,type WorkTypeBucketDto,type WorkTypeReportRowDto,
} from '@workloom/contracts';
import {authorizeWorkspace} from '../access/access-queries.js';
import {roleHasCapability,type Capability} from '../access/capabilities.js';
import type {CommandContext} from '../access/context.js';
import {capabilityRequiredError,DomainError,notFoundError,unauthenticatedError} from '../errors.js';
import type {PlanningPage} from '../planning/application.js';
import {createPlanningMutationGuard,isCommittedPlanningRejection,unwrapPlanningOutcome} from '../planning/freeze.js';
import {canonicalJson} from '../tasks/service.js';
import type {WorkCategoryApplication} from './application.js';
import type {WorkCategoryApplicationDependencies,WorkCategoryMutationCommand,WorkCategoryRepository,WorkCategoryWriteScope} from './ports.js';
import {canonicalWorkCategory,readWorkCategoryBinding} from './resolver.js';

interface Parser<T>{safeParse(value:unknown):{success:true;data:T}|{success:false;error:{issues:readonly {path:readonly PropertyKey[]}[]}}}
function parse<T>(schema:Parser<T>,input:unknown):T{const p=schema.safeParse(input);if(p.success)return p.data;throw new DomainError('VALIDATION_FAILED','The input is invalid.',{details:{fields:p.error.issues.map(i=>i.path.join('.'))}});}
function found<T>(v:T|null):T{if(v===null)throw notFoundError();return v;}
function rule(message:string):DomainError{return new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function revision(actual:number,expected:number):void{if(actual!==expected)throw new DomainError('REVISION_CONFLICT','The source changed. Reload it before saving.');}
function normalize(ctx:CommandContext):CommandContext{if(!ctx.actor||!idSchema.safeParse(ctx.actor.userId).success)throw unauthenticatedError();return {...ctx,workspaceId:parse(idSchema,ctx.workspaceId),actor:{...ctx.actor,userId:parse(idSchema,ctx.actor.userId)}};}
const canonicalLog=(row:Parameters<typeof canonicalWorkCategory>[0]):CategorizedWorkLogDto=>({...row,category:canonicalWorkCategory(row)});
function categoryKey(category:WorkCategorySnapshot):string{return category.kind==='categorized'?`${category.fieldId}:${category.optionId}`:'uncategorized';}
/** Authoritative aggregation over unique pinned source revisions, never task-page rows. */
export function workTypeBuckets(rows:WorkTypeReportRowDto[]):WorkTypeBucketDto[]{
 const active=rows.filter(r=>!r.excluded),total=active.reduce((a,r)=>a+r.workLog.minutes,0),keys=[...new Set(active.map(r=>categoryKey(r.workLog.category)))];
 return keys.map(key=>{
  const members=active.filter(r=>categoryKey(r.workLog.category)===key),minutes=members.reduce((a,r)=>a+r.workLog.minutes,0);
  const chosen=[...members].sort((a,b)=>{
   const ac=a.workLog.category,bc=b.workLog.category,ar=ac.kind==='categorized'?ac.optionRevision:0,br=bc.kind==='categorized'?bc.optionRevision:0;
   return br-ar||(BigInt(a.workLog.changeSeq)<BigInt(b.workLog.changeSeq)?1:BigInt(a.workLog.changeSeq)>BigInt(b.workLog.changeSeq)?-1:b.id.localeCompare(a.id));
  })[0];
  const c=chosen?.workLog.category;
  return {key,fieldId:c?.kind==='categorized'?c.fieldId:null,optionId:c?.kind==='categorized'?c.optionId:null,label:c?.kind==='categorized'?c.optionLabel:'Без категории',color:c?.kind==='categorized'?c.color:null,minutes,sharePercent:total>0?minutes/total*100:null};
 }).sort((a,b)=>b.minutes-a.minutes||a.key.localeCompare(b.key));
}

export function createWorkCategoryApplication(deps:WorkCategoryApplicationDependencies):WorkCategoryApplication{
 const {writer,tools}=deps,newId=()=>parse(idSchema,tools.newId()),hash=(v:unknown)=>tools.digest(canonicalJson(v));
 async function read<T>(context:CommandContext,cap:Capability,work:(repo:WorkCategoryRepository,ctx:CommandContext)=>Promise<T>):Promise<T>{const ctx=normalize(context);return writer.read(ctx,cap,repo=>work(repo,ctx));}
 async function page<T extends{id:string}>(repo:WorkCategoryRepository,ctx:CommandContext,rows:T[],query:PlanningPageQuery,filter:unknown):Promise<PlanningPage<T>>{
  const queryHash=hash(filter),epoch=await repo.planning.tasks.permissionEpoch(ctx.workspaceId);let after='';
  if(query.cursor){let c;try{c=tools.decodeCursor(query.cursor);}catch{throw new DomainError('VALIDATION_FAILED','Invalid or expired cursor. Reload the first page.');}if(c.workspaceId!==ctx.workspaceId||c.actorUserId!==ctx.actor.userId||c.permissionEpoch!==epoch||c.queryHash!==queryHash)throw new DomainError('VALIDATION_FAILED','The cursor does not match this list.');after=c.afterId;}
  const ordered=[...rows].sort((a,b)=>a.id.localeCompare(b.id)).filter(r=>r.id>after),items=ordered.slice(0,query.limit),last=items.at(-1);
  return {items,nextCursor:ordered.length>query.limit&&last?tools.encodeCursor({version:1,workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,permissionEpoch:epoch,queryHash,afterId:last.id}):null};
 }
 async function mutate<T>(context:CommandContext,cap:Capability,command:WorkCategoryMutationCommand,target:unknown,input:unknown,schema:Parser<T>,work:(scope:WorkCategoryWriteScope,now:string)=>Promise<T>,authorize?:(scope:WorkCategoryWriteScope)=>Promise<void>):Promise<T>{
  const ctx=normalize(context),key=ctx.idempotencyKey;if(key===undefined||!/^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');const payloadHash=hash({command,target,input});
  const result=await writer.run(ctx,cap,async scope=>{
   if(authorize)await authorize(scope);
   const idempotency=scope.repository.tasks,old=await idempotency.findIdempotency(ctx.workspaceId,ctx.actor.userId,command,key);
   if(old){if(old.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key was used for another request.');return isCommittedPlanningRejection(old.result)?old.result:parse(schema,old.result);}
   const rejection=await createPlanningMutationGuard(scope,tools).check({family:'category',command,target,input}),now=scope.barrierAt.toISOString(),value=rejection??await work(scope,now);
   await idempotency.insertIdempotency({workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,command,idempotencyKey:key,payloadHash,result:value,createdAt:now});return value;
  });return unwrapPlanningOutcome(result);
 }
 return {
  async getBinding(ctx,projectId){const pid=parse(idSchema,projectId);return read(ctx,'task.read',async(repo,c)=>{found(await repo.planning.tasks.findProject(c.workspaceId,pid));return readWorkCategoryBinding(repo,c.workspaceId,pid);});},
  async updateBinding(ctx,projectId,input){
   const pid=parse(idSchema,projectId),p=parse(updateProjectWorkCategoryBindingInputSchema,input);
   return mutate(ctx,'fields.manage','category.binding.update',{projectId:pid},p,projectWorkCategoryBindingSchema,async(scope,now)=>{
    const repo=scope.categories,ws=scope.context.workspaceId,project=found(await repo.planning.tasks.findProject(ws,pid));if(project.archivedAt!==null)throw rule('The project is archived.');
    const old=await readWorkCategoryBinding(repo,ws,pid);revision(old.revision,p.expectedRevision);if(old.fieldId===p.fieldId)return old;
    if(p.fieldId!==null){const field=found(await repo.planning.fields.findField(ws,p.fieldId));if(field.projectId!==pid||field.type!=='single_select'||field.archivedAt!==null)throw rule('Choose an active single-select field of this project.');}
    const row={workspaceId:ws,projectId:pid,revision:old.revision+1,versionId:newId(),fieldId:p.fieldId};
    const change=await scope.recordChange({entityType:'work_category_binding',entityId:pid,action:'updated',entityRevision:row.revision,diff:{from:old.fieldId,to:p.fieldId,versionId:row.versionId},outbox:{type:'work_category_binding.updated',payload:{projectId:pid,revision:row.revision,versionId:row.versionId}}});
    await repo.insertBindingVersion({...row,actorUserId:scope.context.actor.userId,recordedAt:now,changeSeq:change.changeSeq.toString()});await repo.saveBinding(row,old.versionId!==null);return {...row,availability:p.fieldId===null?'unbound' as const:'active' as const};
   });
  },
  async recategorizeWorkLog(ctx,id,input){
   const wid=parse(idSchema,id),p=parse(recategorizeWorkLogInputSchema,input);
   return mutate(ctx,'time.write_self','work.recategorize',{workLogId:wid},p,categorizedWorkLogSchema,async(scope,now)=>{
    const repo=scope.categories,ws=scope.context.workspaceId,old=canonicalLog(found(await repo.findWorkLog(ws,wid)));revision(old.revision,p.expectedWorkLogRevision);
    const binding=await readWorkCategoryBinding(repo,ws,old.projectId);revision(binding.revision,p.expectedBindingRevision);if(old.state!=='active')throw rule('Restore a void source before recategorizing it.');
    let category:WorkCategorySnapshot;
    if(p.optionId===null){if(old.category.kind==='uncategorized')return old;category={kind:'uncategorized',reason:'explicit_clear',bindingVersionId:binding.versionId,bindingRevision:binding.revision,fieldId:binding.fieldId};}
    else {
     if(binding.availability!=='active'||binding.fieldId===null||binding.versionId===null)throw rule('No active work category field is bound.');
     const option=found(await repo.planning.fields.findOption(ws,p.optionId));if(option.projectId!==old.projectId||option.fieldId!==binding.fieldId)throw rule('The option belongs to another work category field.');
     if(old.category.kind==='categorized'&&old.category.fieldId===binding.fieldId&&old.category.optionId===option.id)return old;
     if(option.archivedAt!==null)throw rule('An archived option cannot be newly assigned.');
     const field=found(await repo.planning.fields.findField(ws,binding.fieldId));
     category={kind:'categorized',bindingVersionId:binding.versionId,bindingRevision:binding.revision,fieldId:field.id,fieldDefinitionVersionId:field.definitionVersionId,fieldLabel:field.name,optionId:option.id,optionRevision:option.revision,optionLabel:option.name,color:option.color,optionArchivedAt:option.archivedAt};
    }
    const nextRevision=old.revision+1,change=await scope.recordChange({entityType:'work_log',entityId:old.id,action:'recategorized',entityRevision:nextRevision,diff:{before:old.category,after:category},reason:p.reason,outbox:{type:'work_log.recategorized',payload:{workLogId:old.id,periodId:old.periodId,revision:nextRevision}}});
    const next:CategorizedWorkLogDto={...old,category,revision:nextRevision,revisionId:newId(),reason:p.reason,actorUserId:scope.context.actor.userId,recordedAt:now,changeSeq:change.changeSeq.toString()};await repo.planning.saveManualWork(next);await repo.planning.insertWorkRevision(next);return next;
   },async scope=>{const old=found(await scope.categories.findWorkLog(scope.context.workspaceId,wid));if(old.membershipId!==scope.access.membership.id&&!roleHasCapability(scope.access.membership.role,'time.write_others'))throw capabilityRequiredError();});
  },
  async listReportRuns(ctx,input){const q=parse(workTypeReportRunListQuerySchema,input);return read(ctx,'reports.read',async(repo,c)=>{found(await repo.planning.findPeriod(c.workspaceId,q.periodId));return page(repo,c,await repo.listReportRuns(c.workspaceId,q.periodId),q,{kind:'work_type_reports',periodId:q.periodId});});},
  async createReportRun(ctx,input){
   const p=parse(createWorkTypeReportRunInputSchema,input);
   return mutate(ctx,'reports.read','work_type_report.create',{periodId:p.periodId},p,workTypeReportRunSchema,async(scope,now)=>{
    const repo=scope.categories,ws=scope.context.workspaceId,period=found(await repo.planning.findPeriod(ws,p.periodId)),sources=await repo.planning.captureProject(ws,period.projectId),all=await repo.planning.listWorkLogs(ws,period.id);
    const memberIds=(p.membershipIds.length?[...p.membershipIds]:[...new Set(all.map(w=>w.membershipId))]).sort();for(const id of memberIds)if(!sources.memberships.some(m=>m.id===id))throw notFoundError();if(memberIds.length>1000)throw rule('Narrow the report to at most 1000 people.');
    const selected=all.filter(w=>memberIds.includes(w.membershipId)),rows:WorkTypeReportRowDto[]=selected.map(log=>({id:log.revisionId,workLog:canonicalLog(log),taskTitle:sources.tasks.find(t=>t.id===log.taskId)?.title??'Задача',memberName:sources.memberships.find(m=>m.id===log.membershipId)?.displayName??'Участник',excluded:log.state==='void'}));
    const active=rows.filter(r=>!r.excluded),byCategory=workTypeBuckets(rows),byPerson=memberIds.map(membershipId=>{const own=rows.filter(r=>r.workLog.membershipId===membershipId);return {membershipId,memberName:sources.memberships.find(m=>m.id===membershipId)?.displayName??'Участник',totalActualMinutes:own.filter(r=>!r.excluded).reduce((a,r)=>a+r.workLog.minutes,0),activeSourceCount:own.filter(r=>!r.excluded).length,byCategory:workTypeBuckets(own)};});
    if(byCategory.length>1000||byPerson.some(p=>p.byCategory.length>1000))throw rule('A report supports at most 1000 category buckets. Narrow the selected people.');
    const run={id:newId(),workspaceId:ws,projectId:period.projectId,periodId:period.id,metricVersion:'weekly_work_type_v1' as const,createdAt:now,actorUserId:scope.context.actor.userId,factCutoffAt:now,factChangeSeq:await repo.planning.currentChangeSeq(ws),membershipIds:memberIds,totalActualMinutes:active.reduce((a,r)=>a+r.workLog.minutes,0),activeSourceCount:active.length,categorizedMinutes:active.filter(r=>r.workLog.category.kind==='categorized').reduce((a,r)=>a+r.workLog.minutes,0),uncategorizedMinutes:active.filter(r=>r.workLog.category.kind==='uncategorized').reduce((a,r)=>a+r.workLog.minutes,0),byCategory,byPerson,rowCount:rows.length,workLogRevisionIds:rows.map(r=>r.id).sort(),labelPolicy:'highest_option_revision_then_change_seq_then_id' as const};
    await repo.insertReportRun(run,rows);await scope.recordChange({entityType:'work_type_report',entityId:run.id,action:'created',entityRevision:1,diff:{periodId:period.id,metricVersion:run.metricVersion,rowCount:rows.length},outbox:{type:'work_type_report.created',payload:{runId:run.id,periodId:period.id}}});return run;
   });
  },
  async getReportRun(ctx,id){const rid=parse(idSchema,id);return read(ctx,'reports.read',async(repo,c)=>found(await repo.findReportRun(c.workspaceId,rid)).run);},
  async listReportRows(ctx,id,input){const rid=parse(idSchema,id),q=parse(planningPageQuerySchema,input);return read(ctx,'reports.read',async(repo,c)=>page(repo,c,found(await repo.findReportRun(c.workspaceId,rid)).rows,q,{kind:'work_type_rows',runId:rid}));},
  async getTaskTimeSummary(ctx,projectId,periodId,input){
   const pid=parse(idSchema,projectId),period=parse(idSchema,periodId),q=parse(taskTimeSummaryInputSchema,input);
   return read(ctx,'task.read',async(repo,c)=>{
    const ws=c.workspaceId,access=await authorizeWorkspace(repo.planning.tasks.access,c,'task.read'),selectedPeriod=found(await repo.planning.findPeriod(ws,period));found(await repo.planning.tasks.findProject(ws,pid));if(selectedPeriod.projectId!==pid)throw rule('The period belongs to another project.');
    const sources=await repo.planning.captureProject(ws,pid),subject=q.membershipId??access.membership.id;if(!sources.memberships.some(m=>m.id===subject))throw notFoundError();
    const chosen=[];for(const id of q.taskIds){const task=found(await repo.planning.tasks.findTask(ws,id));if(task.projectId!==pid)throw rule('A task belongs to another project.');chosen.push(task);}
    const [logs,commitments]=await Promise.all([repo.planning.listWorkLogs(ws,period),repo.planning.listCommitments(ws,period)]),active=logs.filter(w=>w.state==='active');
    const tasks=chosen.map(task=>{const own=logs.find(w=>w.taskId===task.id&&w.membershipId===subject&&w.sourceKind==='manual_period')??null,subjectRows=active.filter(w=>w.taskId===task.id&&w.membershipId===subject),taskRows=active.filter(w=>w.taskId===task.id),commitment=commitments.find(v=>v.workPackageId===task.workPackageId&&v.membershipId===subject&&v.state==='active');return {taskId:task.id,workPackageId:task.workPackageId,currentAllocationMinutes:commitment?.allocations.find(a=>a.taskId===task.id)?.minutes??null,ownManualWork:own?canonicalLog(own):null,subjectActualMinutes:subjectRows.reduce((a,w)=>a+w.minutes,0),taskActualMinutes:taskRows.reduce((a,w)=>a+w.minutes,0),subjectActiveSourceCount:subjectRows.length,taskActiveSourceCount:taskRows.length,hasOtherSources:subjectRows.some(w=>w.id!==own?.id)};});
    const packages=[...new Set(chosen.map(t=>t.workPackageId))].sort().map(workPackageId=>{const rows=active.filter(w=>w.workPackageId===workPackageId),own=rows.filter(w=>w.membershipId===subject);return {workPackageId,commitment:commitments.find(v=>v.workPackageId===workPackageId&&v.membershipId===subject)??null,subjectActualMinutes:own.reduce((a,w)=>a+w.minutes,0),totalActualMinutes:rows.reduce((a,w)=>a+w.minutes,0),subjectActiveSourceCount:own.length,totalActiveSourceCount:rows.length};});
    const result:TaskTimeSummaryDto={workspaceId:ws,projectId:pid,periodId:period,subjectMembershipId:subject,asOfChangeSeq:await repo.planning.currentChangeSeq(ws),tasks,packages};return result;
   });
  },
 };
}
