import {
 RECURRENCE_LIMITS,addRecurrencePeriodsInputSchema,authorizeRecurrenceGenerationInputSchema,createRecurrenceSeriesInputSchema,editRecurrenceSeriesInputSchema,idSchema,
 materializePeriodInputSchema,recurrenceCalendarDateSchema,recurrenceCreatePreviewInputSchema,recurrenceEditPreviewInputSchema,recurrenceExceptionPreviewInputSchema,
 recurrenceInstanceListQuerySchema,recurrenceInstanceSchema,recurrenceMaterializationResultSchema,recurrencePeriodPreviewInputSchema,recurrencePeriodsResultSchema,
 recurrenceSeriesListQuerySchema,recurrenceSeriesSchema,setRecurrenceExceptionInputSchema,setRecurrenceSeriesStateInputSchema,
 type PlanningPageQuery,type PlanningPeriodDto,type RecurrenceCandidateDto,type RecurrenceCreatePreviewDto,type RecurrenceCreatePreviewInput,type RecurrenceEditImpactDto,
 type RecurrenceEditPreviewDto,type RecurrenceEditPreviewInput,type RecurrenceExceptionPreviewDto,type RecurrenceExceptionPreviewInput,type RecurrenceInstanceDto,
 type RecurrencePeriodBindingDto,type RecurrencePeriodPreviewDto,type RecurrencePeriodPreviewInput,type RecurrenceProtectedReason,type RecurrenceProtectedTargetDto,
 type RecurrencePlannedCalendarDto,type RecurrenceReadinessDto,type RecurrenceResolutionWarning,type RecurrenceSeriesDto,type RecurrenceTemplateInput,
} from '@workloom/contracts';
import type {Capability} from '../access/capabilities.js';
import type {CommandContext} from '../access/context.js';
import {DomainError,isDomainError,notFoundError,unauthenticatedError} from '../errors.js';
import type {PlanningPage} from '../planning/application.js';
import {createPlanningMutationGuard,isCommittedPlanningRejection,performFreeze,unwrapPlanningOutcome} from '../planning/freeze.js';
import type {CommittedPlanningRejection} from '../planning/ports.js';
import {canonicalJson} from '../tasks/service.js';
import type {RecurrenceApplication} from './application.js';
import {reviseOccurrenceMeetingInScope} from './composer.js';
import {
 ambiguousOwnershipError,bindingSourceManifestHash,collisions,desiredOccurrence,evaluatePeriodCensus,headerFromDraft,loadSeriesContext,newEntityId,owningPeriods,
 planCandidates,progressOf,requestMaterialization,resolutionInPeriod,templateProblem,validateGenerationAuthority,versionAt,
 type DesiredOccurrence,type EvaluatedBinding,type PlannedCandidate,type RecurrenceRequestReason,type RecurrenceSeriesContext,type RecurrenceVersionLike,
} from './materializer.js';
import type {
 RecurrenceApplicationDependencies,RecurrenceGenerationAuthorizationRecord,RecurrenceInstanceHeader,RecurrenceMaterializationCursor,RecurrenceMutationCommand,RecurrencePeriodBindingRecord,
 RecurrenceRepository,RecurrenceSeriesRecord,RecurrenceSeriesVersionRecord,RecurrenceWriteScope,
} from './ports.js';

/** P3b application (docs16 §5): exactly the fifteen RecurrenceApplication methods.
 * Internal signature: createRecurrenceApplication(deps:RecurrenceApplicationDependencies):RecurrenceApplication.
 * Mutations: schema → canonical ctx → writer.run(task.edit: current ACL under the workspace barrier) → exact replay
 * (old stored outcome untouched) → shared guard with an exhaustive recurrence intent → handler. Previews are keyless
 * repeatable reads that never reserve headers, materialize or invent entity IDs; apply recomputes under the barrier.
 */
interface Parser<T>{safeParse(value:unknown):{success:true;data:T}|{success:false;error:{issues:readonly {path:readonly PropertyKey[]}[]}}}
function parse<T>(schema:Parser<T>,input:unknown):T{const p=schema.safeParse(input);if(p.success)return p.data;throw new DomainError('VALIDATION_FAILED','Invalid recurrence input.',{details:{fields:p.error.issues.map(i=>i.path.join('.'))}});}
function found<T>(v:T|null|undefined):T{if(v===null||v===undefined)throw notFoundError();return v;}
function must<T>(v:T|null|undefined,what:string):T{if(v===null||v===undefined)throw new Error(`Recurrence invariant: ${what}.`);return v;}
function rule(message:string):DomainError{return new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function revision(actual:number|null,expected:number|null):void{if(actual!==expected)throw new DomainError('REVISION_CONFLICT','The recurring series changed. Reload it before saving.');}
function normalize(ctx:CommandContext):CommandContext{if(!ctx.actor||!idSchema.safeParse(ctx.actor.userId).success)throw unauthenticatedError();return {...ctx,workspaceId:parse(idSchema,ctx.workspaceId),actor:{...ctx.actor,userId:parse(idSchema,ctx.actor.userId)}};}
function protectedError(count:number):DomainError{return new DomainError('DOMAIN_VALIDATION_FAILED','Protected occurrences are affected. Choose a later effective date or another occurrence.',{details:{protectedCount:count}});}
const byId=<T extends {id:string}>(rows:readonly T[]):T[]=>[...rows].sort((a,b)=>a.id.localeCompare(b.id));
const REASON_ORDER:readonly RecurrenceProtectedReason[]=['past','done','posted_attendance','schedule_frozen','cross_period'];
/** Placeholder ID of a not-yet-written version inside previews; never stored, never returned. */
const DRAFT='draft';

/** Past/Done/ever-posted/frozen classification by instance identity, including a null-meeting cancelled header. */
export async function recurrenceProtectedReasons(repo:RecurrenceRepository,header:RecurrenceInstanceHeader,at:Date,desiredStartAt?:string):Promise<RecurrenceProtectedReason[]>{
 const ws=header.workspaceId,reasons=new Set<RecurrenceProtectedReason>();
 if(Date.parse(header.resolution.resolvedStartAt)<=at.getTime()||(desiredStartAt!==undefined&&Date.parse(desiredStartAt)<=at.getTime()))reasons.add('past');
 if((await repo.listCalendarLocks(ws,header.id)).length)reasons.add('schedule_frozen');
 if(header.locator){
  const m=await repo.planning.findMeetingByTask(ws,header.locator.taskId),task=await repo.planning.tasks.findTask(ws,header.locator.taskId);
  if(m){if(m.hasPostedAttendance)reasons.add('posted_attendance');if(m.scheduleFrozen||(await repo.planning.listMeetingLocks(ws,m.id)).length)reasons.add('schedule_frozen');if(m.actualStartAt!==null)reasons.add('past');}
  if(task&&(await repo.planning.tasks.findStatus(ws,task.statusId))?.group==='done')reasons.add('done');
 }
 return REASON_ORDER.filter(r=>reasons.has(r));
}

interface EditPlanEntry {readonly key:string;readonly action:RecurrenceEditImpactDto['action'];readonly header:RecurrenceInstanceHeader|null;readonly desired:DesiredOccurrence;readonly periodId:string|null;readonly nominalSequence:number|null}

export function createRecurrenceApplication(deps:RecurrenceApplicationDependencies):RecurrenceApplication{
 const {writer,tools}=deps,hash=(v:unknown)=>tools.digest(canonicalJson(v)),newId=()=>newEntityId(tools);
 async function read<T>(context:CommandContext,cap:Capability,work:(repo:RecurrenceRepository,ctx:CommandContext)=>Promise<T>):Promise<T>{const ctx=normalize(context);return writer.read(ctx,cap,repo=>work(repo,ctx));}
 async function page<T extends {id:string}>(repo:RecurrenceRepository,ctx:CommandContext,rows:T[],q:PlanningPageQuery,filter:unknown):Promise<PlanningPage<T>>{
  const epoch=await repo.planning.tasks.permissionEpoch(ctx.workspaceId),queryHash=hash(filter);let after='';
  if(q.cursor){let c;try{c=tools.decodeCursor(q.cursor);}catch{throw new DomainError('VALIDATION_FAILED','Invalid cursor. Reload the first page.');}if(c.workspaceId!==ctx.workspaceId||c.actorUserId!==ctx.actor.userId||c.permissionEpoch!==epoch||c.queryHash!==queryHash)throw new DomainError('VALIDATION_FAILED','Cursor does not match this list.');after=c.afterId;}
  const ordered=byId(rows).filter(r=>r.id>after),items=ordered.slice(0,q.limit),last=items.at(-1);
  return {items,nextCursor:ordered.length>q.limit&&last?tools.encodeCursor({version:1,workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,permissionEpoch:epoch,queryHash,afterId:last.id}):null};
 }
 async function mutate<R>(context:CommandContext,command:RecurrenceMutationCommand,target:unknown,input:unknown,schema:Parser<R>,work:(scope:RecurrenceWriteScope,now:string)=>Promise<R|CommittedPlanningRejection>):Promise<R>{
  const ctx=normalize(context),key=ctx.idempotencyKey;if(key===undefined||!/^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');const payloadHash=hash({command,target,input});
  const outcome=await writer.run(ctx,'task.edit',async scope=>{
   const repo=scope.repository.tasks,old=await repo.findIdempotency(ctx.workspaceId,ctx.actor.userId,command,key);
   if(old){if(old.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key was used for another request.');return isCommittedPlanningRejection(old.result)?old.result:parse(schema,old.result);}
   const rejected=await createPlanningMutationGuard(scope,tools).check({family:'recurrence',command,target,input}),now=scope.barrierAt.toISOString();
   let result:R|CommittedPlanningRejection;
   if(rejected)result=rejected;else{const value=await work(scope,now);result=isCommittedPlanningRejection(value)?value:parse(schema,value);}
   await repo.insertIdempotency({workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:now});return result;
  });return unwrapPlanningOutcome(outcome);
 }
 /** A stale preview whose target period was cut-off frozen in THIS tx commits that freeze with a tagged PREVIEW_STALE
  * (no eternal stale loop); otherwise nothing was committed for it and the plain stale error rolls back. */
 async function staleOutcome(scope:RecurrenceWriteScope,periodIds:readonly string[]):Promise<CommittedPlanningRejection>{
  const at=scope.barrierAt.toISOString(),ids:string[]=[];
  for(const id of new Set(periodIds))for(const b of await scope.repository.listBaselines(scope.context.workspaceId,id))if(b.mode==='cutoff'&&b.frozenAt===at)ids.push(b.id);
  if(ids.length)return {__workloomPlanningOutcome:'rejected',code:'PREVIEW_STALE',details:{committed:true,baselineIds:[...new Set(ids)].sort()}};
  throw new DomainError('PREVIEW_STALE','The recurring series sources changed. Review the preview again.');
 }

 // ---- Shared projections ------------------------------------------------------------------
 async function accessManifest(repo:RecurrenceRepository,ctx:CommandContext,projectId:string){const sources=await repo.planning.captureProject(ctx.workspaceId,projectId);return {actorUserId:ctx.actor.userId,permissionEpoch:await repo.planning.tasks.permissionEpoch(ctx.workspaceId),activeMembershipIds:[...sources.activeMembershipIds].sort()};}
 async function templateSources(repo:RecurrenceRepository,ws:string,t:RecurrenceTemplateInput){return {status:await repo.planning.tasks.findStatus(ws,t.statusId),section:t.sectionId?await repo.planning.tasks.findSection(ws,t.sectionId):null};}
 async function requireTemplate(repo:RecurrenceRepository,ws:string,projectId:string,t:RecurrenceTemplateInput):Promise<void>{const problem=await templateProblem(repo.planning,ws,projectId,t);if(problem==='not_found')throw notFoundError();if(problem==='rule')throw rule('The template project, status or section is unavailable in this project.');}
 async function projectPeriods(repo:RecurrenceRepository,ws:string,projectId:string,ids:readonly string[]):Promise<PlanningPeriodDto[]>{const out:PlanningPeriodDto[]=[];for(const id of ids){const p=await repo.planning.findPeriod(ws,id);if(!p||p.projectId!==projectId)throw notFoundError();out.push(p);}return byId(out);}
 async function seriesDto(repo:RecurrenceRepository,series:RecurrenceSeriesRecord,at:Date):Promise<RecurrenceSeriesDto>{
  const ws=series.workspaceId,[versions,bindings]=await Promise.all([repo.listSeriesVersions(ws,series.id),repo.listBindings(ws,series.id)]);
  const check=await validateGenerationAuthority(repo,series,at),grant=series.authorizationId?await repo.findAuthorization(ws,series.authorizationId):null;
  let nominalCandidateCount=0;try{nominalCandidateCount=planCandidates(tools.resolver,versions).length;}catch(error){if(!isDomainError(error))throw error;}
  return {id:series.id,workspaceId:ws,projectId:series.projectId,revision:series.revision,state:series.state,currentVersion:must(versions.find(v=>v.id===series.currentVersionId),'current version'),
   generation:{authorizationId:series.authorizationId,authorizationRevision:series.authorizationRevision,authorizerMembershipId:grant?.authorizerMembershipId??null,state:check.kind==='valid'?'ready':'blocked',blockedCode:check.kind==='blocked'?check.code:null},
   boundPeriodIds:bindings.map(b=>b.periodId).sort(),boundPeriodCount:bindings.length,nominalCandidateCount,createdAt:series.createdAt,updatedAt:series.updatedAt};
 }
 function bindingDto(e:EvaluatedBinding):RecurrencePeriodBindingDto{
  const headers=e.context?.headers.filter(h=>h.bindingId===e.binding.id)??[],progress=progressOf(e),b=e.binding;
  return {id:b.id,workspaceId:b.workspaceId,projectId:b.projectId,seriesId:b.seriesId,periodId:b.periodId,revision:b.revision,sourceManifestHash:e.hash,state:progress.state,blockedCode:progress.blockedCode,
   headerCount:headers.length,materializedCount:headers.filter(h=>h.locator!==null).length,missingCount:e.missingCount,cancelledHeaderOnlyCount:headers.filter(h=>h.calendarState==='cancelled'&&h.locator===null).length,createdAt:b.createdAt};
 }
 async function instanceDto(repo:RecurrenceRepository,h:RecurrenceInstanceHeader):Promise<RecurrenceInstanceDto>{
  const meeting=h.locator?await repo.planning.findMeetingByTask(h.workspaceId,h.locator.taskId):null;
  const head=h.exceptionVersionId?must((await repo.listExceptionVersions(h.workspaceId,h.id)).find(e=>e.id===h.exceptionVersionId),'exception head'):null;
  return {id:h.id,workspaceId:h.workspaceId,projectId:h.projectId,seriesId:h.seriesId,bindingId:h.bindingId,plannedPeriodId:h.periodId,occurrenceKey:h.occurrenceKey,nominalSequence:h.nominalSequence,
   sourceVersionId:h.sourceVersionId,revision:h.revision,calendarState:h.calendarState,meetingId:h.locator?.meetingId??null,taskId:h.locator?.taskId??null,workPackageId:h.locator?.workPackageId??null,
   meetingRevision:meeting?.revision??null,resolution:h.resolution,exception:head?{versionId:head.id,revision:head.revision,kind:head.kind,reason:head.reason,actorUserId:head.actorUserId,recordedAt:head.recordedAt}:null,
   createdAt:h.createdAt,updatedAt:h.updatedAt};
 }
 function candidateDto(c:PlannedCandidate,periodId:string|null,all:readonly PlannedCandidate[]):RecurrenceCandidateDto{
  return {occurrenceKey:c.occurrenceKey,nominalSequence:c.nominalSequence,resolution:c.resolution,periodId,collidesWithOccurrenceKeys:collisions(all,c.occurrenceKey,c.resolution)};
 }
 async function compositionRevisions(repo:RecurrenceRepository,headers:readonly RecurrenceInstanceHeader[]){
  return Promise.all(headers.filter(h=>h.locator).map(async h=>{const taskId=must(h.locator,'locator').taskId,m=await repo.planning.findMeetingByTask(h.workspaceId,taskId),t=await repo.planning.tasks.findTask(h.workspaceId,taskId);return {instanceId:h.id,meetingRevision:m?.revision??null,taskRevision:t?.revision??null,participantsRevision:t?.participantsRevision??null,workPackageRevision:t?.workPackageRevision??null,locks:(await repo.listCalendarLocks(h.workspaceId,h.id)).length};}));
 }
 /** Rehash every binding of the series (generation inputs only) and, for requesting commands, write exactly one
  * subscribed request per affected binding in the same UOW. */
 async function rehashBindings(scope:RecurrenceWriteScope,context:RecurrenceSeriesContext,reason:RecurrenceRequestReason|null):Promise<RecurrencePeriodBindingRecord[]>{
  const out:RecurrencePeriodBindingRecord[]=[];
  for(const b of context.bindings){
   const h=bindingSourceManifestHash(tools,context,b,must(context.periods.get(b.periodId),'bound period'));
   const next=h===b.sourceManifestHash?b:{...b,revision:b.revision+1,sourceManifestHash:h};
   if(next!==b)await scope.recurrence.saveBinding(next,true);
   if(reason)await requestMaterialization(scope,next,h,context.series.authorizationRevision,reason);
   const cutoffPeriod=await scope.repository.findPeriod(scope.context.workspaceId,next.periodId);
   if(cutoffPeriod)await scope.cutoffRequests.requestPeriod(cutoffPeriod,reason==='generation_authorized'?'generation_authorized':reason==='series_resumed'?'series_resumed':'recurrence_changed',reason==='generation_authorized'||reason==='series_resumed');
   out.push(next);
  }
  return out;
 }

 // ---- Preview builders (shared by keyless preview and barrier-time apply) --------------------
 async function buildCreatePreview(repo:RecurrenceRepository,ctx:CommandContext,projectId:string,input:RecurrenceCreatePreviewInput):Promise<RecurrenceCreatePreviewDto>{
  const ws=ctx.workspaceId,project=found(await repo.planning.tasks.findProject(ws,projectId));if(project.archivedAt)throw rule('The project is archived.');
  const periods=await projectPeriods(repo,ws,projectId,input.targetPeriodIds);
  await requireTemplate(repo,ws,projectId,input.template);
  const draft:RecurrenceVersionLike={id:DRAFT,revision:1,effectiveFromNominalDate:input.schedule.startDate,schedule:input.schedule,template:input.template};
  const planned=planCandidates(tools.resolver,[draft]);
  const candidates=planned.map(c=>{const owners=owningPeriods(c.resolution,periods);if(owners.length>1)throw ambiguousOwnershipError();return candidateDto(c,owners[0]?.id??null,planned);});
  const n=candidates.length,warnings=[...new Set(planned.map(c=>c.resolution.warning).filter((w):w is RecurrenceResolutionWarning=>w!==null))].sort();
  const body={projectId,policyVersion:tools.resolver.policyVersion,provenance:tools.resolver.provenance(input.schedule.timezone),counts:{nominalCount:n,consumedNominalCount:0,remainingNominalCount:n,skippedCount:0,cancelledCount:0},
   candidates,periods:periods.map(p=>({periodId:p.id,periodRevision:p.revision,candidateCount:candidates.filter(c=>c.periodId===p.id).length})),unboundCandidateCount:candidates.filter(c=>c.periodId===null).length,warnings};
  const previewHash=hash({kind:'recurrence.create',version:1,input:{schedule:input.schedule,template:input.template,targetPeriodIds:[...input.targetPeriodIds].sort()},body,project,periods,templateSources:await templateSources(repo,ws,input.template),access:await accessManifest(repo,ctx,projectId)});
  return {...body,previewHash};
 }
 async function buildEditPreview(repo:RecurrenceRepository,ctx:CommandContext,seriesId:string,input:RecurrenceEditPreviewInput,at:Date){
  const ws=ctx.workspaceId,series=found(await repo.findSeries(ws,seriesId));revision(series.revision,input.expectedRevision);
  const context=await loadSeriesContext(repo,ws,series),versions=context.versions,first=must(versions[0],'first version');
  const s=input.schedule,o=first.schedule,effective=input.effectiveFromNominalDate;
  if(s.startDate!==o.startDate)throw rule('The series start date is immutable.');
  if(s.end.kind!==o.end.kind)throw rule('Changing how a series ends is deferred. Create a follow-up series instead.');
  if(o.end.kind==='after_count'&&(s.frequency!==o.frequency||canonicalJson([...(s.weekdays??[])].sort())!==canonicalJson([...(o.weekdays??[])].sort())||(s.end.kind==='after_count'&&s.end.count!==o.end.count)))
   throw rule('The original count sequence (start, cadence, weekdays and count) is immutable.');
  if(effective<s.startDate)throw rule('The effective date cannot precede the series start.');
  await requireTemplate(repo,ws,series.projectId,input.template);
  const draft:RecurrenceVersionLike={id:DRAFT,revision:Math.max(...versions.map(v=>v.revision))+1,effectiveFromNominalDate:effective,schedule:s,template:input.template};
  const nextVersions:RecurrenceVersionLike[]=[...versions,draft],next=planCandidates(tools.resolver,nextVersions);
  const candidateByKey=new Map(next.map(c=>[c.occurrenceKey,c])),headerByKey=new Map(context.headers.map(h=>[h.occurrenceKey,h])),bound=[...context.periods.values()];
  const keys=[...new Set([...next.map(c=>c.occurrenceKey),...context.headers.map(h=>h.occurrenceKey)])].filter(k=>k>=effective).sort();
  const plan:EditPlanEntry[]=[],impacts:RecurrenceEditImpactDto[]=[],protectedTargets:RecurrenceProtectedTargetDto[]=[];
  for(const key of keys){
   const header=headerByKey.get(key)??null,candidate=candidateByKey.get(key)??null;
   if(!header){
    if(!candidate)continue;
    if(Date.parse(candidate.resolution.resolvedStartAt)<=at.getTime())throw rule('A series edit cannot add an occurrence in the past. Choose a future effective date.');
    const owners=owningPeriods(candidate.resolution,bound);if(owners.length>1)throw ambiguousOwnershipError();
    const periodId=owners[0]?.id??null;
    plan.push({key,action:'create',header:null,desired:{calendarState:'scheduled',resolution:candidate.resolution,sourceVersionId:candidate.sourceVersionId},periodId,nominalSequence:candidate.nominalSequence});
    impacts.push({occurrenceKey:key,instanceId:null,periodId,action:'create',before:null,after:candidate.resolution});continue;
   }
   const desired=must(desiredOccurrence(tools.resolver,nextVersions,key,header,candidate,context.heads.get(header.id)??null),'desired occurrence');
   const templateOf=(id:string)=>nextVersions.find(v=>v.id===id)?.template;
   const changed=desired.calendarState!==header.calendarState||desired.sourceVersionId!==header.sourceVersionId||canonicalJson(desired.resolution)!==canonicalJson(header.resolution)||(header.locator!==null&&canonicalJson(templateOf(desired.sourceVersionId))!==canonicalJson(templateOf(header.sourceVersionId)));
   const action:RecurrenceEditImpactDto['action']=!changed?'retain':header.calendarState==='scheduled'&&desired.calendarState==='cancelled'?'cancel':'update';
   if(action!=='retain'){
    const reasons=await recurrenceProtectedReasons(repo,header,at,desired.calendarState==='scheduled'?desired.resolution.resolvedStartAt:undefined);
    if(desired.calendarState==='scheduled'&&!resolutionInPeriod(desired.resolution,must(context.periods.get(header.periodId),'header period'))&&!reasons.includes('cross_period'))reasons.push('cross_period');
    if(reasons.length)protectedTargets.push({occurrenceKey:key,instanceId:header.id,reasons});
   }
   plan.push({key,action,header,desired,periodId:header.periodId,nominalSequence:header.nominalSequence});
   impacts.push({occurrenceKey:key,instanceId:header.id,periodId:header.periodId,action,before:header.resolution,after:desired.calendarState==='scheduled'?desired.resolution:null});
  }
  const counts={nominalCount:next.length,consumedNominalCount:next.filter(c=>c.occurrenceKey<effective).length,remainingNominalCount:next.filter(c=>c.occurrenceKey>=effective).length,
   skippedCount:[...context.heads.values()].filter(h=>h.kind==='skip').length,cancelledCount:context.headers.filter(h=>h.calendarState==='cancelled').length};
  const body={seriesId,seriesRevision:series.revision,effectiveFromNominalDate:effective,counts,impacts,protectedTargets};
  const previewHash=hash({kind:'recurrence.edit',version:1,input,body,series,versions,bindings:context.bindings,periods:byId(bound),headers:context.headers,heads:byId([...context.heads.values()]),
   compositions:await compositionRevisions(repo,plan.flatMap(e=>e.header&&e.action!=='retain'?[e.header]:[])),templateSources:await templateSources(repo,ws,input.template),access:await accessManifest(repo,ctx,series.projectId)});
  const dto:RecurrenceEditPreviewDto={...body,previewHash};
  return {dto,plan,context,draft};
 }
 async function buildPeriodsPreview(repo:RecurrenceRepository,ctx:CommandContext,seriesId:string,input:RecurrencePeriodPreviewInput){
  const ws=ctx.workspaceId,series=found(await repo.findSeries(ws,seriesId));revision(series.revision,input.expectedRevision);
  const context=await loadSeriesContext(repo,ws,series);
  for(const id of input.periodIds)if(context.bindings.some(b=>b.periodId===id))throw new DomainError('REVISION_CONFLICT','This period is already bound to the series.');
  const added=await projectPeriods(repo,ws,series.projectId,input.periodIds);
  if(context.bindings.length+added.length>RECURRENCE_LIMITS.maxTargetPeriods)throw rule('A series can be bound to at most 52 periods.');
  // A series/key is never rebound: a new period overlapping any existing header (even cancelled) is a conflict.
  for(const h of context.headers)if(owningPeriods(h.resolution,added).length)throw new DomainError('REVISION_CONFLICT','A selected period overlaps an occurrence already assigned to another period.');
  const planned=planCandidates(tools.resolver,context.versions),headerByKey=new Map(context.headers.map(h=>[h.occurrenceKey,h])),all=[...context.periods.values(),...added];
  const candidates=planned.map(c=>{const header=headerByKey.get(c.occurrenceKey);if(header)return candidateDto(c,header.periodId,planned);const owners=owningPeriods(c.resolution,all);if(owners.length>1)throw ambiguousOwnershipError();return candidateDto(c,owners[0]?.id??null,planned);});
  const body={seriesId,seriesRevision:series.revision,periods:added.map(p=>({periodId:p.id,periodRevision:p.revision,candidateCount:candidates.filter(c=>c.periodId===p.id&&!headerByKey.has(c.occurrenceKey)).length})),candidates};
  const previewHash=hash({kind:'recurrence.periods',version:1,input,body,series,versions:context.versions,bindings:context.bindings,periods:byId(all),headers:context.headers.map(h=>({id:h.id,key:h.occurrenceKey,periodId:h.periodId,revision:h.revision})),access:await accessManifest(repo,ctx,series.projectId)});
  const dto:RecurrencePeriodPreviewDto={...body,previewHash};
  return {dto,context,added,planned};
 }
 async function buildExceptionPreview(repo:RecurrenceRepository,ctx:CommandContext,seriesId:string,key:string,input:RecurrenceExceptionPreviewInput,at:Date){
  const ws=ctx.workspaceId,series=found(await repo.findSeries(ws,seriesId));revision(series.revision,input.expectedSeriesRevision);
  const context=await loadSeriesContext(repo,ws,series),header=found(context.headers.find(h=>h.occurrenceKey===key));
  if(header.revision!==input.expectedInstanceRevision)throw new DomainError('REVISION_CONFLICT','The occurrence changed. Reload it before saving.');
  const head=context.heads.get(header.id)??null,candidate=planCandidates(tools.resolver,context.versions).find(c=>c.occurrenceKey===key)??null;
  const version=context.versions.find(v=>v.id===header.sourceVersionId)??versionAt(context.versions,key);
  let target:DesiredOccurrence;
  switch(input.kind){
   case 'skip':if(header.calendarState!=='scheduled')throw rule('Only a scheduled occurrence can be skipped.');target={calendarState:'cancelled',resolution:header.resolution,sourceVersionId:header.sourceVersionId};break;
   case 'move':if(header.calendarState!=='scheduled')throw rule('Restore a cancelled occurrence before moving it.');target={calendarState:'scheduled',resolution:tools.resolver.resolveOccurrence(input.localDate,input.localTime,version.schedule.timezone,version.schedule.plannedDurationMinutes),sourceVersionId:header.sourceVersionId};break;
   case 'restore':{
    if(header.calendarState!=='cancelled')throw rule('Only a cancelled occurrence can be restored.');
    const v=versionAt(context.versions,key);
    target=candidate?{calendarState:'scheduled',resolution:candidate.resolution,sourceVersionId:candidate.sourceVersionId}:{calendarState:'scheduled',resolution:tools.resolver.resolveOccurrence(key,v.schedule.localTime,v.schedule.timezone,v.schedule.plannedDurationMinutes),sourceVersionId:v.id};break;
   }
   case 'reset':if(!head||head.kind==='reset')throw rule('This occurrence has no manual exception to reset.');target=must(desiredOccurrence(tools.resolver,context.versions,key,header,candidate,head,'explicit_reset'),'reset target');break;
  }
  const materialized=header.locator?await repo.planning.findMeetingByTask(ws,header.locator.taskId):null;
  if(header.locator&&!materialized)throw new Error('A recurring occurrence lost its materialized meeting.');
  const beforePlannedCalendar:RecurrencePlannedCalendarDto=materialized?{
   timezone:materialized.timezone,plannedDurationMinutes:materialized.plannedDurationMinutes,organizerMembershipId:materialized.organizerMembershipId,
   attendeeMembershipIds:(await repo.planning.listAttendance(ws,materialized.id)).filter(a=>a.rosterActive).map(a=>a.membershipId).sort(),
  }:{timezone:version.schedule.timezone,plannedDurationMinutes:header.resolution.plannedDurationMinutes,organizerMembershipId:version.template.organizerMembershipId,attendeeMembershipIds:[...version.template.attendeeMembershipIds].sort()};
  const targetVersion=must(context.versions.find(v=>v.id===target.sourceVersionId),'exception target version');
  const inheritCalendar=(input.kind==='reset'||input.kind==='restore')&&target.calendarState==='scheduled';
  const afterPlannedCalendar:RecurrencePlannedCalendarDto=inheritCalendar?{
   timezone:targetVersion.schedule.timezone,plannedDurationMinutes:target.resolution.plannedDurationMinutes,organizerMembershipId:targetVersion.template.organizerMembershipId,attendeeMembershipIds:[...targetVersion.template.attendeeMembershipIds].sort(),
  }:beforePlannedCalendar;
  const active=(await repo.planning.captureProject(ws,series.projectId)).activeMembershipIds;
  const retained=new Set([...beforePlannedCalendar.attendeeMembershipIds,beforePlannedCalendar.organizerMembershipId]);
  if([...afterPlannedCalendar.attendeeMembershipIds,afterPlannedCalendar.organizerMembershipId].some(id=>!active.includes(id)&&!retained.has(id)))throw notFoundError();
  const reasons=await recurrenceProtectedReasons(repo,header,at);
  if(target.calendarState==='scheduled' &&Date.parse(target.resolution.resolvedStartAt)<=at.getTime()&&!reasons.includes('past'))reasons.splice(0,0,'past');
  if(target.calendarState==='scheduled'&&!resolutionInPeriod(target.resolution,must(context.periods.get(header.periodId),'header period')))reasons.push('cross_period');
  const protectedReasons=REASON_ORDER.filter(r=>reasons.includes(r));
  const body={seriesId,instanceId:header.id,occurrenceKey:key,kind:input.kind,before:header.resolution,after:target.calendarState==='scheduled'?target.resolution:null,calendarStateAfter:target.calendarState,beforePlannedCalendar,afterPlannedCalendar,protectedReasons};
  const previewHash=hash({kind:'recurrence.exception',version:1,input,body,series,versions:context.versions.map(v=>({id:v.id,revision:v.revision})),header,head,compositions:await compositionRevisions(repo,[header]),access:await accessManifest(repo,ctx,series.projectId)});
  const dto:RecurrenceExceptionPreviewDto={...body,previewHash};
  return {dto,context,header,target};
 }

 return {
  async listSeries(ctx,id,input){const projectId=parse(idSchema,id),q=parse(recurrenceSeriesListQuerySchema,input);return read(ctx,'task.read',async(repo,c)=>{
   found(await repo.planning.tasks.findProject(c.workspaceId,projectId));
   const rows=(await repo.listSeries(c.workspaceId,projectId)).filter(s=>s.projectId===projectId&&(q.state==='all'||s.state===q.state));
   const result=await page(repo,c,rows,q,{kind:'recurrence-series',projectId,state:q.state}),at=new Date();
   return {items:await Promise.all(result.items.map(s=>seriesDto(repo,s,at))),nextCursor:result.nextCursor};
  });},
  async previewCreate(ctx,id,input){const projectId=parse(idSchema,id),p=parse(recurrenceCreatePreviewInputSchema,input);return read(ctx,'task.edit',(repo,c)=>buildCreatePreview(repo,c,projectId,p));},
  async createSeries(ctx,id,input){const projectId=parse(idSchema,id),p=parse(createRecurrenceSeriesInputSchema,input);return mutate(ctx,'recurrence.series.create',{projectId},p,recurrenceSeriesSchema,async(scope,now)=>{
   const ws=scope.context.workspaceId,repo=scope.recurrence,actor=scope.context.actor.userId;
   const preview=await buildCreatePreview(repo,scope.context,projectId,{schedule:p.schedule,template:p.template,targetPeriodIds:p.targetPeriodIds});
   if(preview.previewHash!==p.previewHash)return staleOutcome(scope,p.targetPeriodIds);
   const seriesId=newId(),versionId=newId(),authorizationId=newId();
   const change=await scope.recordChange({entityType:'recurrence_series',entityId:seriesId,action:'created',entityRevision:1,diff:{projectId,versionId,authorizationId,periodIds:[...p.targetPeriodIds].sort(),nominalCount:preview.counts.nominalCount}});
   const changeSeq=change.changeSeq.toString();
   const version:RecurrenceSeriesVersionRecord={id:versionId,seriesId,revision:1,effectiveFromNominalDate:p.schedule.startDate,schedule:p.schedule,template:p.template,policyVersion:tools.resolver.policyVersion,actorUserId:actor,createdAt:now,changeSeq};
   const series:RecurrenceSeriesRecord={id:seriesId,workspaceId:ws,projectId,revision:1,state:'active',currentVersionId:versionId,authorizationId,authorizationRevision:1,createdAt:now,updatedAt:now};
   // The creating member's explicit keyed command is the first persisted generation grant (revision 1).
   const grant:RecurrenceGenerationAuthorizationRecord={id:authorizationId,workspaceId:ws,seriesId,revision:1,authorizerUserId:actor,authorizerMembershipId:scope.access.membership.id,actorUserId:actor,source:scope.context.source,recordedAt:now,changeSeq};
   await repo.saveSeries(series,false);await repo.insertSeriesVersion(version,ws);await repo.insertAuthorization(grant);
   const periods=await projectPeriods(repo,ws,projectId,p.targetPeriodIds),context={series,versions:[version],headers:[],heads:new Map()};
   const bindings:RecurrencePeriodBindingRecord[]=periods.map(period=>{const id=newId();return {id,workspaceId:ws,projectId,seriesId,periodId:period.id,revision:1,sourceManifestHash:bindingSourceManifestHash(tools,context,{id,periodId:period.id},period),createdAt:now};});
   for(const b of bindings)await repo.saveBinding(b,false);
   const headers=preview.candidates.flatMap(c=>{const b=bindings.find(x=>x.periodId===c.periodId);return b?[headerFromDraft(tools,b,{occurrenceKey:c.occurrenceKey,nominalSequence:c.nominalSequence,sourceVersionId:versionId,resolution:c.resolution},now)]:[];});
   if(headers.length)await repo.reserveInstanceHeaders(headers);
   for(const b of bindings){await requestMaterialization(scope,b,b.sourceManifestHash,series.authorizationRevision,'series_created');const period=await repo.planning.findPeriod(ws,b.periodId);if(period)await scope.cutoffRequests.requestPeriod(period,'recurrence_changed');}
   return seriesDto(repo,series,scope.barrierAt);
  });},
  async getSeries(ctx,id){const seriesId=parse(idSchema,id);return read(ctx,'task.read',async(repo,c)=>seriesDto(repo,found(await repo.findSeries(c.workspaceId,seriesId)),new Date()));},
  // Preview "past" uses the read time; apply re-evaluates at the barrier, so a transition yields PREVIEW_STALE.
  async previewEdit(ctx,id,input){const seriesId=parse(idSchema,id),p=parse(recurrenceEditPreviewInputSchema,input);return read(ctx,'task.edit',async(repo,c)=>(await buildEditPreview(repo,c,seriesId,p,new Date())).dto);},
  async editSeries(ctx,id,input){const seriesId=parse(idSchema,id),p=parse(editRecurrenceSeriesInputSchema,input);return mutate(ctx,'recurrence.series.edit',{seriesId},p,recurrenceSeriesSchema,async(scope,now)=>{
   const repo=scope.recurrence,ws=scope.context.workspaceId,{previewHash,...previewInput}=p;
   const built=await buildEditPreview(repo,scope.context,seriesId,previewInput,scope.barrierAt);
   if(built.dto.previewHash!==previewHash)return staleOutcome(scope,built.context.bindings.map(b=>b.periodId));
   if(built.dto.protectedTargets.length)throw protectedError(built.dto.protectedTargets.length);
   const {context,draft,plan}=built,series=context.series,versionId=newId();
   // Validate every existing task transition before any series/version/header proposed write.
   for(const impact of plan)if(impact.action==='update'&&impact.header?.locator&&impact.desired?.calendarState==='scheduled'){const task=found(await repo.planning.tasks.findTask(ws,impact.header.locator.taskId));const effectiveVersion=impact.desired.sourceVersionId===DRAFT?built.draft:found(context.versions.find(v=>v.id===impact.desired?.sourceVersionId));await scope.statusTransitions.assertTransition(task,effectiveVersion.template.statusId);}
   const change=await scope.recordChange({entityType:'recurrence_series',entityId:series.id,action:'edited',entityRevision:series.revision+1,diff:{versionId,effectiveFromNominalDate:draft.effectiveFromNominalDate,update:plan.filter(e=>e.action==='update').length,create:plan.filter(e=>e.action==='create').length,cancel:plan.filter(e=>e.action==='cancel').length}});
   const version:RecurrenceSeriesVersionRecord={id:versionId,seriesId:series.id,revision:draft.revision,effectiveFromNominalDate:draft.effectiveFromNominalDate,schedule:draft.schedule,template:draft.template,policyVersion:tools.resolver.policyVersion,actorUserId:scope.context.actor.userId,createdAt:now,changeSeq:change.changeSeq.toString()};
   await repo.insertSeriesVersion(version,ws);
   const nextSeries:RecurrenceSeriesRecord={...series,revision:series.revision+1,currentVersionId:versionId,updatedAt:now};await repo.saveSeries(nextSeries,true);
   const versions=[...context.versions,version],real=(id:string)=>id===DRAFT?versionId:id,bindingByPeriod=new Map(context.bindings.map(b=>[b.periodId,b]));
   const reservations:RecurrenceInstanceHeader[]=[];
   for(const e of plan){
    if(e.action==='retain')continue;
    if(e.action==='create'){if(e.periodId)reservations.push(headerFromDraft(tools,must(bindingByPeriod.get(e.periodId),'binding'),{occurrenceKey:e.key,nominalSequence:e.nominalSequence,sourceVersionId:real(e.desired.sourceVersionId),resolution:e.desired.resolution},now));continue;}
    const header=must(e.header,'edited header'),sourceVersionId=real(e.desired.sourceVersionId);
    const updated:RecurrenceInstanceHeader={...header,calendarState:e.desired.calendarState,resolution:e.desired.resolution,sourceVersionId,revision:header.revision+1,updatedAt:now};
    await repo.saveInstanceHeader(updated);
    await reviseOccurrenceMeetingInScope(scope,updated,{calendarState:updated.calendarState,resolution:updated.resolution,version:must(versions.find(v=>v.id===sourceVersionId),'source version')},tools);
   }
   if(reservations.length)await repo.reserveInstanceHeaders(reservations);
   await rehashBindings(scope,{...context,series:nextSeries,versions},'series_edited');
   return seriesDto(repo,nextSeries,scope.barrierAt);
  });},
  async setState(ctx,id,input){const seriesId=parse(idSchema,id),p=parse(setRecurrenceSeriesStateInputSchema,input);return mutate(ctx,'recurrence.series.state',{seriesId},p,recurrenceSeriesSchema,async(scope,now)=>{
   const repo=scope.recurrence,ws=scope.context.workspaceId,series=found(await repo.findSeries(ws,seriesId));revision(series.revision,p.expectedRevision);
   if(series.state===p.state)return seriesDto(repo,series,scope.barrierAt);
   // Pause stops only background preparation: registered census stays mandatory for sync ensure and freeze.
   const next:RecurrenceSeriesRecord={...series,state:p.state,revision:series.revision+1,updatedAt:now};await repo.saveSeries(next,true);
   await scope.recordChange({entityType:'recurrence_series',entityId:series.id,action:p.state==='paused'?'paused':'resumed',entityRevision:next.revision,diff:{state:p.state}});
   if(p.state==='active')await rehashBindings(scope,await loadSeriesContext(repo,ws,next),'series_resumed');
   return seriesDto(repo,next,scope.barrierAt);
  });},
  async previewPeriods(ctx,id,input){const seriesId=parse(idSchema,id),p=parse(recurrencePeriodPreviewInputSchema,input);return read(ctx,'task.edit',async(repo,c)=>(await buildPeriodsPreview(repo,c,seriesId,p)).dto);},
  async addPeriods(ctx,id,input){const seriesId=parse(idSchema,id),p=parse(addRecurrencePeriodsInputSchema,input);return mutate(ctx,'recurrence.periods.add',{seriesId},p,recurrencePeriodsResultSchema,async(scope,now)=>{
   const repo=scope.recurrence,ws=scope.context.workspaceId,{previewHash,...previewInput}=p;
   const built=await buildPeriodsPreview(repo,scope.context,seriesId,previewInput);
   if(built.dto.previewHash!==previewHash)return staleOutcome(scope,p.periodIds);
   const {context,added}=built,series=context.series,nextSeries:RecurrenceSeriesRecord={...series,revision:series.revision+1,updatedAt:now};
   await scope.recordChange({entityType:'recurrence_series',entityId:series.id,action:'periods_added',entityRevision:nextSeries.revision,diff:{periodIds:added.map(x=>x.id)}});
   await repo.saveSeries(nextSeries,true);
   const created:RecurrencePeriodBindingRecord[]=added.map(period=>{const bid=newId();return {id:bid,workspaceId:ws,projectId:series.projectId,seriesId,periodId:period.id,revision:1,sourceManifestHash:bindingSourceManifestHash(tools,{...context,series:nextSeries},{id:bid,periodId:period.id},period),createdAt:now};});
   for(const b of created)await repo.saveBinding(b,false);
   const headers=built.dto.candidates.flatMap(c=>{if(context.headers.some(h=>h.occurrenceKey===c.occurrenceKey))return [];const b=created.find(x=>x.periodId===c.periodId);const planned=must(built.planned.find(x=>x.occurrenceKey===c.occurrenceKey),'candidate');return b?[headerFromDraft(tools,b,planned,now)]:[];});
   if(headers.length)await repo.reserveInstanceHeaders(headers);
   for(const b of created){await requestMaterialization(scope,b,b.sourceManifestHash,nextSeries.authorizationRevision,'periods_added');const period=await repo.planning.findPeriod(ws,b.periodId);if(period)await scope.cutoffRequests.requestPeriod(period,'recurrence_changed');}
   const bindings:RecurrencePeriodBindingDto[]=[];
   for(const b of created)for(const e of await evaluatePeriodCensus(repo,tools,must(added.find(x=>x.id===b.periodId),'period'),scope.barrierAt,b.id))bindings.push(bindingDto(e));
   return {series:await seriesDto(repo,nextSeries,scope.barrierAt),bindings};
  });},
  async authorizeGeneration(ctx,id,input){const seriesId=parse(idSchema,id),p=parse(authorizeRecurrenceGenerationInputSchema,input);return mutate(ctx,'recurrence.generation.authorize',{seriesId},p,recurrenceSeriesSchema,async(scope,now)=>{
   // Narrow metadata recovery: no due-freeze prerequisite (the guard bypassed it), no schedule/attendance/baseline change.
   const repo=scope.recurrence,ws=scope.context.workspaceId,series=found(await repo.findSeries(ws,seriesId));revision(series.revision,p.expectedRevision);
   if(series.authorizationRevision!==p.expectedAuthorizationRevision)throw new DomainError('REVISION_CONFLICT','The generation authorization changed. Reload the series.');
   const authorizationId=newId(),authorizationRevision=(series.authorizationRevision??0)+1,actor=scope.context.actor.userId;
   const change=await scope.recordChange({entityType:'recurrence_series',entityId:series.id,action:'generation_authorized',entityRevision:series.revision+1,diff:{authorizationId,authorizationRevision,authorizerUserId:actor,authorizerMembershipId:scope.access.membership.id,previousAuthorizationId:series.authorizationId}});
   await repo.insertAuthorization({id:authorizationId,workspaceId:ws,seriesId,revision:authorizationRevision,authorizerUserId:actor,authorizerMembershipId:scope.access.membership.id,actorUserId:actor,source:scope.context.source,recordedAt:now,changeSeq:change.changeSeq.toString()});
   const next:RecurrenceSeriesRecord={...series,authorizationId,authorizationRevision,revision:series.revision+1,updatedAt:now};await repo.saveSeries(next,true);
   await rehashBindings(scope,await loadSeriesContext(repo,ws,next),'generation_authorized');
   return seriesDto(repo,next,scope.barrierAt);
  });},
  async listInstances(ctx,id,input){const seriesId=parse(idSchema,id),q=parse(recurrenceInstanceListQuerySchema,input);return read(ctx,'task.read',async(repo,c)=>{
   const ws=c.workspaceId,series=found(await repo.findSeries(ws,seriesId)),period=found(await repo.planning.findPeriod(ws,q.periodId));if(period.projectId!==series.projectId)throw notFoundError();
   const binding=(await repo.listBindings(ws,seriesId)).find(b=>b.periodId===period.id);
   const rows=binding?(await repo.listInstanceHeaders(ws,binding.id)).filter(h=>q.includeCancelled===true||h.calendarState==='scheduled'):[];
   const result=await page(repo,c,rows,q,{kind:'recurrence-instances',seriesId,periodId:period.id,includeCancelled:q.includeCancelled===true});
   return {items:await Promise.all(result.items.map(h=>instanceDto(repo,h))),nextCursor:result.nextCursor};
  });},
  async previewException(ctx,id,occurrenceKey,input){const seriesId=parse(idSchema,id),key=parse(recurrenceCalendarDateSchema,occurrenceKey),p=parse(recurrenceExceptionPreviewInputSchema,input);return read(ctx,'task.edit',async(repo,c)=>(await buildExceptionPreview(repo,c,seriesId,key,p,new Date())).dto);},
  async setException(ctx,id,occurrenceKey,input){const seriesId=parse(idSchema,id),key=parse(recurrenceCalendarDateSchema,occurrenceKey),p=parse(setRecurrenceExceptionInputSchema,input);return mutate(ctx,'recurrence.exception.set',{seriesId,occurrenceKey:key},p,recurrenceInstanceSchema,async(scope,now)=>{
   // Rest of a discriminated union is not distributive in TS; the runtime shape is exactly the preview variant.
   const repo=scope.recurrence,ws=scope.context.workspaceId,{previewHash,...rest}=p,previewInput=rest as RecurrenceExceptionPreviewInput;
   const built=await buildExceptionPreview(repo,scope.context,seriesId,key,previewInput,scope.barrierAt);
   if(built.dto.previewHash!==previewHash)return staleOutcome(scope,[built.header.periodId]);
   if(built.dto.protectedReasons.length)throw protectedError(1);
   const {context,header,target}=built,existing=await repo.listExceptionVersions(ws,header.id);
   const change=await scope.recordChange({entityType:'recurrence_instance',entityId:header.id,action:`exception_${p.kind}`,entityRevision:header.revision+1,reason:p.reason,diff:{seriesId,occurrenceKey:key,kind:p.kind,periodId:header.periodId}});
   const exception={id:newId(),workspaceId:ws,instanceId:header.id,revision:existing.length+1,kind:p.kind,localDate:p.kind==='move'?p.localDate:null,localTime:p.kind==='move'?p.localTime:null,reason:p.reason,actorUserId:scope.context.actor.userId,source:scope.context.source,recordedAt:now,changeSeq:change.changeSeq.toString()};
   await repo.insertExceptionVersion(exception);
   const updated:RecurrenceInstanceHeader={...header,exceptionVersionId:exception.id,calendarState:target.calendarState,resolution:target.resolution,sourceVersionId:target.sourceVersionId,revision:header.revision+1,updatedAt:now};
   await repo.saveInstanceHeader(updated);
   // Skip/move/restore keep the same meeting/task/package IDs; history, attendance and plans are untouched.
   await reviseOccurrenceMeetingInScope(scope,updated,{calendarState:updated.calendarState,resolution:updated.resolution,version:must(context.versions.find(v=>v.id===updated.sourceVersionId),'source version')},tools,(p.kind==='reset'||p.kind==='restore')&&updated.calendarState==='scheduled'?'calendar':'schedule');
   const heads=new Map(context.heads);heads.set(header.id,exception);
   // Exceptions are generation inputs: the binding hash moves (queued jobs go stale), but this is not a requesting command.
   await rehashBindings(scope,{...context,headers:context.headers.map(h=>h.id===header.id?updated:h),heads},null);
   return instanceDto(repo,updated);
  });},
  async materializePeriod(ctx,id,input){const periodId=parse(idSchema,id),p=parse(materializePeriodInputSchema,input);return mutate(ctx,'recurrence.period.materialize',{periodId},p,recurrenceMaterializationResultSchema,async scope=>{
   // Typed prerequisite recovery: the guard bypassed every due-freeze loop; only this period's approved census is created.
   const ws=scope.context.workspaceId,period=found(await scope.repository.findPeriod(ws,periodId));
   let cursor:RecurrenceMaterializationCursor|null=null;if(p.cursor!==undefined){try{cursor=tools.decodeMaterializationCursor(p.cursor);}catch{throw new DomainError('VALIDATION_FAILED','The cursor is invalid or expired. Restart from the first chunk.');}}
   const outcome=await scope.recurrenceCensus.ensurePeriod(period,{maxCreates:p.limit,reason:'explicit',cursor,bindingId:null});
   let frozenBaselineIds:string[]=[];
   const current=found(await scope.repository.findPeriod(ws,periodId));
   if(outcome.status==='complete'&&current.state==='planning'&&Date.parse(current.cutoffAt)<=scope.barrierAt.getTime()){
    // Final complete chunk of an overdue period: atomically freeze only this target period.
    const before=new Set((await scope.repository.listBaselines(ws,periodId)).map(b=>b.id));
    await performFreeze(scope,current,'project',null,'cutoff',tools);
    frozenBaselineIds=(await scope.repository.listBaselines(ws,periodId)).map(b=>b.id).filter(b=>!before.has(b)).sort();
   }
   return {periodId,status:outcome.status,createdCount:outcome.createdCount,remainingCount:outcome.remainingCount,nextCursor:outcome.nextCursor?tools.encodeMaterializationCursor(outcome.nextCursor):null,bindings:outcome.bindings.slice(0,RECURRENCE_LIMITS.maxReadinessBindings),truncated:outcome.bindings.length>RECURRENCE_LIMITS.maxReadinessBindings,frozenBaselineIds};
  });},
  async getReadiness(ctx,id){const periodId=parse(idSchema,id);return read(ctx,'task.read',async(repo,c)=>{
   const period=found(await repo.planning.findPeriod(c.workspaceId,periodId)),evaluated=await evaluatePeriodCensus(repo,tools,period,new Date()),bindings=evaluated.map(e=>progressOf(e));
   const dto:RecurrenceReadinessDto={periodId,periodRevision:period.revision,state:bindings.some(b=>b.state==='blocked')?'blocked':bindings.some(b=>b.remainingCount>0)?'pending':'complete',
    missingCount:bindings.reduce((a,b)=>a+b.remainingCount,0),blockedCount:bindings.filter(b=>b.state==='blocked').length,
    bindings:bindings.slice(0,RECURRENCE_LIMITS.maxReadinessBindings),truncated:bindings.length>RECURRENCE_LIMITS.maxReadinessBindings};
   return dto;
  });},
 };
}
