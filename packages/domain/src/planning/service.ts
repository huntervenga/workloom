import { completionAtCalculation } from './report-completion.js';
import { canonicalWorkCategory } from '../categories/resolver.js';
import {
  createPlanningPeriodInputSchema,createPeriodCommitmentInputSchema,createWeeklyPlanFactReportInputSchema,
  freezePlanInputSchema,freezePreviewInputSchema,idSchema,manualPeriodWorkLogSchema,periodCommitmentListQuerySchema,
  periodCommitmentSchema,planBaselineSchema,planningPackageListQuerySchema,planningPageQuerySchema,
  planningPeriodListQuerySchema,planningPeriodSchema,reportRunListQuerySchema,setManualPeriodWorkInputSchema,
  updatePeriodCommitmentInputSchema,updatePlanningPeriodInputSchema,weeklyPlanFactReportRunSchema,workLogListQuerySchema,
  type ManualPeriodWorkLogDto,type OriginalPackageEstimateDto,type PeriodCommitmentDto,type PlanningPageQuery,type PlanningPeriodDto,
  type WeeklyPlanFactRowDto,type WeeklyPlanFactSummaryDto,
} from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import { roleHasCapability,type Capability } from '../access/capabilities.js';
import type { CommandContext } from '../access/context.js';
import { capabilityRequiredError,DomainError,notFoundError,unauthenticatedError } from '../errors.js';
import { canonicalJson } from '../tasks/service.js';
import type { PlanningApplication,PlanningPage } from './application.js';
import { captureFreezeSnapshot,createPlanningMutationGuard,freezePreviewHash,isCommittedPlanningRejection,performFreeze,unwrapPlanningOutcome } from './freeze.js';
import type { OriginalPackageEstimateSource,PlanningApplicationDependencies,PlanningApplicationWriteScope,PlanningMutationCommand,PlanningRepository,PlanningTools,PlanningWriteScope } from './ports.js';

interface Parser<T> {safeParse(value:unknown):{success:true;data:T}|{success:false;error:{issues:readonly {path:readonly PropertyKey[]}[]}}}
function parse<T>(schema:Parser<T>,value:unknown):T {const p=schema.safeParse(value);if(p.success)return p.data;throw new DomainError('VALIDATION_FAILED','The input is invalid.',{details:{fields:p.error.issues.map(i=>i.path.join('.'))}});}
function found<T>(v:T|null):T {if(v===null)throw notFoundError();return v;}
function rule(message:string):DomainError {return new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function revision(actual:number,expected:number):void {if(actual!==expected)throw new DomainError('REVISION_CONFLICT','The resource changed. Reload it before saving.');}
function normalize(ctx:CommandContext):CommandContext {if(!ctx.actor||!idSchema.safeParse(ctx.actor.userId).success)throw unauthenticatedError();return {...ctx,workspaceId:parse(idSchema,ctx.workspaceId),actor:{...ctx.actor,userId:parse(idSchema,ctx.actor.userId)}};}
function requireCap(scope:PlanningWriteScope,cap:Capability):void {if(!roleHasCapability(scope.access.membership.role,cap))throw capabilityRequiredError();}
function sameId(left:string,right:string):boolean {return left.toLowerCase()===right.toLowerCase();}
/** First related freeze only; never the current estimate. Inconsistent immutable provenance is an internal error, never a guessed state. */
function originalEstimateOf(pkg:{readonly id:string;readonly workspaceId:string;readonly projectId:string},source:OriginalPackageEstimateSource|null):OriginalPackageEstimateDto {
  const target={workspaceId:pkg.workspaceId,projectId:pkg.projectId,workPackageId:pkg.id};
  if(source===null)return {state:'not_captured_yet',...target};
  const {observation:o,origin:from,packageBaseline:pb}=source,inconsistent=()=>new Error('Stored original estimate provenance is inconsistent.');
  if(!sameId(o.workspaceId,pkg.workspaceId)||!sameId(o.projectId,pkg.projectId)||!sameId(o.workPackageId,pkg.id)||!sameId(o.baselineId,from.planBaselineId))throw inconsistent();
  const origin={...from,packageRevision:o.packageRevision};
  if(o.estimateMinutes===null) {
    // Unknown at the first related freeze stays unknown forever, even after a later fill or another period's freeze.
    if(pb!==null)throw inconsistent();
    return {state:'original_unknown',...target,estimateMinutes:null,packageBaselineId:null,origin};
  }
  if(pb===null||!sameId(pb.workPackageId,pkg.id)||!sameId(pb.projectId,pkg.projectId)||!sameId(pb.sourceBaselineId,o.baselineId)||pb.estimateMinutes!==o.estimateMinutes||pb.sourcePackageRevision!==o.packageRevision)throw inconsistent();
  return {state:'captured',...target,estimateMinutes:pb.estimateMinutes,packageBaselineId:pb.id,acceptedAt:pb.acceptedAt,provenance:'first_known_plan_freeze',origin};
}
function summary(rows:WeeklyPlanFactRowDto[]):WeeklyPlanFactSummaryDto {
  const original=rows.filter(r=>r.scope==='original');
  const known=original.filter(r=>r.plannedMinutes!==null),recorded=original.filter(r=>r.factRecorded);
  const count=original.length,knownPlannedMinutes=known.reduce((a,r)=>a+(r.plannedMinutes??0),0),actualMinutes=original.reduce((a,r)=>a+r.actualMinutes,0);
  const complete=count>0&&known.length===count&&recorded.length===count;
  return {knownPlannedMinutes,actualMinutes,missingEstimateCount:count-known.length,
    baselineCompleteness:{knownItemCount:known.length,totalItemCount:count,ratio:count?known.length/count:null,complete:count>0&&known.length===count},
    factCoverage:{recordedItemCount:recorded.length,totalItemCount:count,ratio:count?recorded.length/count:null,complete:count>0&&recorded.length===count},
    totalVarianceMinutes:complete?actualMinutes-knownPlannedMinutes:null,totalVariancePercent:complete&&knownPlannedMinutes>0?(actualMinutes-knownPlannedMinutes)/knownPlannedMinutes*100:null,
    addedActualMinutes:rows.filter(r=>r.scope==='added_scope').reduce((a,r)=>a+r.actualMinutes,0),unplannedActualMinutes:rows.filter(r=>r.scope==='unplanned').reduce((a,r)=>a+r.actualMinutes,0),totalActualMinutes:rows.reduce((a,r)=>a+r.actualMinutes,0)};
}
async function validateAllocations(repo:PlanningRepository,ws:string,projectId:string,packageId:string,planned:number|null,allocations:{taskId:string;minutes:number}[],previous:readonly {taskId:string;minutes:number}[]=[]):Promise<void> {
  const total=allocations.reduce((a,v)=>a+v.minutes,0);
  if(planned===null?total>0:total>planned)throw rule('Allocations cannot exceed the known personal weekly plan.');
  const sources=await repo.captureProject(ws,projectId),chosen=new Set(allocations.map(a=>a.taskId));
  for(const a of allocations) {
    const task=found(await repo.tasks.findTask(ws,a.taskId));
    if(task.projectId!==projectId||task.workPackageId!==packageId)throw rule('An allocation must target a task of the same project and package.');
    if(task.archivedAt!==null) {const retained=previous.find(old=>old.taskId===a.taskId);if(!retained||a.minutes>retained.minutes)throw rule('An archived task cannot receive a new or increased allocation.');}
    let parent=task.parentTaskId;const seen=new Set<string>();
    while(parent) {if(seen.has(parent))throw rule('Task hierarchy has a cycle.');seen.add(parent);if(chosen.has(parent))throw rule('Allocate either an ancestor or its descendant, not both.');parent=sources.tasks.find(t=>t.id===parent)?.parentTaskId??null;}
  }
}
async function requireOpenProject(repo:PlanningRepository,ws:string,id:string):Promise<void> {if(found(await repo.tasks.findProject(ws,id)).archivedAt!==null)throw rule('The project is archived.');}
type PlanningIdTools=Pick<PlanningTools,'newId'>;
const scopedNewId=(tools:PlanningIdTools)=>()=>parse(idSchema,tools.newId());

/** Current-membership + self/others capability check of a plan or time target. Callers own currentauth, guard and receipt. */
export async function authorizePlanningMemberInScope(scope:PlanningWriteScope,memberId:string,kind:'plan'|'time'):Promise<void> {
  const members=await scope.repository.tasks.access.listActiveMemberships(scope.context.workspaceId);
  // Existing historical targets may be revoked; membership lookup in capture preserves them.
  const access=members.find(m=>m.id===memberId);
  if(!access) {
    const periods=await scope.repository.listPeriods(scope.context.workspaceId);
    const project=periods[0];
    if(!project||!(await scope.repository.captureProject(scope.context.workspaceId,project.projectId)).memberships.some(m=>m.id===memberId))throw notFoundError();
  }
  requireCap(scope,memberId===scope.access.membership.id?`${kind}.write_self`:`${kind}.write_others`);
}
/** `commitment.create` work body only: no authorization, guard or receipt. */
export async function createCommitmentInScope(scope:PlanningWriteScope,id:string,input:unknown,tools:PlanningIdTools):Promise<PeriodCommitmentDto> {
  const periodId=parse(idSchema,id),p=parse(createPeriodCommitmentInputSchema,input),newId=scopedNewId(tools),now=scope.barrierAt.toISOString();
  const repo=scope.repository,ws=scope.context.workspaceId,period=found(await repo.findPeriod(ws,periodId));await requireOpenProject(repo,ws,period.projectId);
  const pkg=found(await repo.tasks.findWorkPackage(ws,p.workPackageId));if(pkg.projectId!==period.projectId)throw rule('The package belongs to another project.');
  const sources=await repo.captureProject(ws,period.projectId);if(!sources.activeMembershipIds.includes(p.membershipId))throw notFoundError();
  const current=await repo.listCommitments(ws,periodId);if(current.some(c=>c.workPackageId===p.workPackageId&&c.membershipId===p.membershipId))throw new DomainError('REVISION_CONFLICT','This personal commitment already exists.');
  await validateAllocations(repo,ws,period.projectId,p.workPackageId,p.plannedMinutes,p.allocations);
  const baselines=await repo.listBaselines(ws,periodId),added=baselines.some(b=>b.scope==='project'||b.membershipId===p.membershipId);
  const row:PeriodCommitmentDto={id:newId(),workspaceId:ws,projectId:period.projectId,periodId,workPackageId:p.workPackageId,membershipId:p.membershipId,plannedMinutes:p.plannedMinutes,allocations:p.allocations,unallocatedMinutes:p.plannedMinutes===null?null:p.plannedMinutes-p.allocations.reduce((a,v)=>a+v.minutes,0),state:'active',revision:1,classification:added?'added':'planned',baselineIds:[],createdAt:now,updatedAt:now};
  await repo.saveCommitment(row);const change=await scope.recordChange({entityType:'period_commitment',entityId:row.id,action:'created',entityRevision:1,diff:{after:row},outbox:{type:'period_commitment.created',payload:{commitmentId:row.id,periodId,classification:row.classification}}});await repo.insertCommitmentRevision(row,scope.context.actor.userId,change.changeSeq,newId());return row;
}
/** `commitment.update` work body only: no authorization, guard or receipt. */
export async function updateCommitmentInScope(scope:PlanningWriteScope,id:string,commitmentId:string,input:unknown,tools:PlanningIdTools):Promise<PeriodCommitmentDto> {
  const periodId=parse(idSchema,id),cid=parse(idSchema,commitmentId),p=parse(updatePeriodCommitmentInputSchema,input),newId=scopedNewId(tools),now=scope.barrierAt.toISOString();
  const repo=scope.repository,row=found(await repo.findCommitment(scope.context.workspaceId,cid));if(row.periodId!==periodId)throw notFoundError();revision(row.revision,p.expectedRevision);
  await validateAllocations(repo,row.workspaceId,row.projectId,row.workPackageId,p.plannedMinutes,p.allocations,row.allocations);
  const unchanged=row.plannedMinutes===p.plannedMinutes&&row.state===p.state&&canonicalJson([...row.allocations].sort((a,b)=>a.taskId.localeCompare(b.taskId)))===canonicalJson([...p.allocations].sort((a,b)=>a.taskId.localeCompare(b.taskId)));
  if(unchanged)return row;
  const relevant=(await repo.listBaselines(row.workspaceId,periodId)).filter(b=>b.scope==='project'||b.membershipId===row.membershipId);
  const restoredAdded=p.state==='active'&&relevant.length>0&&!relevant.some(b=>b.snapshot.commitments.some(c=>c.id===row.id));
  const next={...row,...p,classification:row.classification==='added'||restoredAdded?'added' as const:'planned' as const,unallocatedMinutes:p.plannedMinutes===null?null:p.plannedMinutes-p.allocations.reduce((a,v)=>a+v.minutes,0),revision:row.revision+1,updatedAt:now};delete (next as Partial<typeof p>).expectedRevision;
  await repo.saveCommitment(next);const change=await scope.recordChange({entityType:'period_commitment',entityId:row.id,action:'updated',entityRevision:next.revision,diff:{before:row,after:next},outbox:{type:'period_commitment.updated',payload:{commitmentId:row.id,periodId,revision:next.revision}}});await repo.insertCommitmentRevision(next,scope.context.actor.userId,change.changeSeq,newId());return next;
}
/** `work.set` work body only: no authorization, guard or receipt. */
export async function setManualPeriodWorkInScope(scope:PlanningApplicationWriteScope,taskId:string,periodId:string,memberId:string,input:unknown,tools:PlanningIdTools):Promise<ManualPeriodWorkLogDto> {
  const tid=parse(idSchema,taskId),pid=parse(idSchema,periodId),mid=parse(idSchema,memberId),p=parse(setManualPeriodWorkInputSchema,input),newId=scopedNewId(tools),now=scope.barrierAt.toISOString();
  const repo=scope.repository,ws=scope.context.workspaceId,period=found(await repo.findPeriod(ws,pid)),task=found(await repo.tasks.findTask(ws,tid));if(task.projectId!==period.projectId)throw rule('The task belongs to another project.');
  const old=await repo.findManualWork(ws,tid,pid,mid);
  if(old===null?p.expectedRevision!==null:p.expectedRevision!==old.revision)throw new DomainError('REVISION_CONFLICT','The manual work source changed.');
  if(old&&old.minutes===p.minutes&&old.state===p.state)return old;
  if((old!==null||p.state==='void')&&p.reason===null)throw rule('A correction or void requires a reason.');
  if(old===null&&p.state==='void')throw rule('An absent work source cannot be voided.');
  const sources=await repo.captureProject(ws,period.projectId);if(old===null&&!sources.activeMembershipIds.includes(mid))throw notFoundError();
  const id=old?.id??newId(),rev=(old?.revision??0)+1;
  const change=await scope.recordChange({entityType:'work_log',entityId:id,action:old?'revised':'created',entityRevision:rev,diff:{taskId:tid,workPackageId:task.workPackageId,membershipId:mid,periodId:pid,before:old?{minutes:old.minutes,state:old.state,revision:old.revision}:null,after:{minutes:p.minutes,state:p.state,revision:rev}},...(p.reason===null?{}:{reason:p.reason}),outbox:{type:'work_log.revised',payload:{workLogId:id,periodId:pid,revision:rev}}});
  const row:ManualPeriodWorkLogDto={id,workspaceId:ws,projectId:period.projectId,taskId:tid,workPackageId:old?.workPackageId??task.workPackageId,membershipId:mid,periodId:pid,sourceKind:'manual_period',sourceKey:`${tid}:${mid}:${pid}`,precision:'period',revision:rev,revisionId:newId(),minutes:p.minutes,state:p.state,reason:p.reason,actorUserId:scope.context.actor.userId,recordedAt:now,changeSeq:change.changeSeq.toString(),category:old===null?await scope.categoryResolver.resolve(tid):canonicalWorkCategory(old)};
  await repo.saveManualWork(row);await repo.insertWorkRevision(row);return row;
}

export function createPlanningApplication(deps:PlanningApplicationDependencies):PlanningApplication {
  const {writer,tools}=deps;
  const digest=(v:unknown)=>tools.digest(canonicalJson(v));
  const newId=()=>parse(idSchema,tools.newId());
  async function read<T>(context:CommandContext,work:(repo:PlanningRepository,ctx:CommandContext)=>Promise<T>,cap:Capability='task.read'):Promise<T> {
    const ctx=normalize(context);return writer.read(ctx,cap,repo=>work(repo,ctx));
  }
  async function page<T extends {id:string}>(repo:PlanningRepository,ctx:CommandContext,rows:T[],query:PlanningPageQuery,filter:unknown):Promise<PlanningPage<T>> {
    const hash=digest(filter),epoch=await repo.tasks.permissionEpoch(ctx.workspaceId);
    let after='';
    if(query.cursor!==undefined) {
      let cursor;
      try {cursor=tools.decodeCursor(query.cursor);}catch {throw new DomainError('VALIDATION_FAILED','The cursor is invalid or expired. Reload the first page.');}
      if(cursor.workspaceId!==ctx.workspaceId||cursor.actorUserId!==ctx.actor.userId||cursor.permissionEpoch!==epoch||cursor.queryHash!==hash)throw new DomainError('VALIDATION_FAILED','The cursor does not match this list.');
      after=cursor.afterId;
    }
    const ordered=[...rows].sort((a,b)=>a.id.localeCompare(b.id)).filter(r=>r.id>after);
    const items=ordered.slice(0,query.limit),last=items.at(-1);
    return {items,nextCursor:ordered.length>query.limit&&last?tools.encodeCursor({version:1,workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,permissionEpoch:epoch,queryHash:hash,afterId:last.id}):null};
  }
  async function mutate<R>(context:CommandContext,cap:Capability,command:PlanningMutationCommand,target:unknown,input:unknown,resultSchema:Parser<R>,work:(scope:PlanningApplicationWriteScope,now:string)=>Promise<R>,authorize?:(scope:PlanningWriteScope)=>Promise<void>):Promise<R> {
    const ctx=normalize(context),key=ctx.idempotencyKey;
    if(key===undefined||!/^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');
    const payloadHash=digest({command,target,input});
    const outcome=await writer.run(ctx,cap,async scope=>{
      if(authorize)await authorize(scope);
      const repo=scope.repository.tasks;
      const old=await repo.findIdempotency(ctx.workspaceId,ctx.actor.userId,command,key);
      if(old) {
        if(old.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This Idempotency-Key was used for another request.');
        if(isCommittedPlanningRejection(old.result))return old.result;
        return parse(resultSchema,old.result);
      }
      const rejected=await createPlanningMutationGuard(scope,tools).check({family:'planning',command,target,input});
      const now=scope.barrierAt.toISOString();
      const result=rejected??await work(scope,now);
      await repo.insertIdempotency({workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:now});
      return result;
    });
    return unwrapPlanningOutcome(outcome);
  }
  const authorizeMember=authorizePlanningMemberInScope;

  return {
    async listPeriods(ctx,input) {const q=parse(planningPeriodListQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.tasks.findProject(c.workspaceId,q.projectId));return page(repo,c,await repo.listPeriods(c.workspaceId,q.projectId),q,{kind:'periods',projectId:q.projectId});});},
    async getPeriod(ctx,id) {const target=parse(idSchema,id);return read(ctx,async(repo,c)=>found(await repo.findPeriod(c.workspaceId,target)));},
    async createPeriod(ctx,input) {
      const p=parse(createPlanningPeriodInputSchema,input);
      return mutate(ctx,'plan.freeze_project','period.create',null,p,planningPeriodSchema,async(scope,now)=>{
        const repo=scope.repository,ws=scope.context.workspaceId;await requireOpenProject(repo,ws,p.projectId);
        if((await repo.listPeriods(ws,p.projectId)).some(old=>old.localStart===p.localStart))throw new DomainError('REVISION_CONFLICT','This project already has a period starting on that date.');
        for(const id of p.protectedFieldIds) {const f=found(await repo.fields.findField(ws,id));if(f.projectId!==p.projectId||f.archivedAt!==null)throw rule('A protected field must be active in this project.');}
        const end=new Date(`${p.localStart}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+7);
        const row:PlanningPeriodDto={...p,id:newId(),workspaceId:ws,localEndExclusive:end.toISOString().slice(0,10),state:'planning',revision:1,projectBaselineId:null,createdAt:now,updatedAt:now};
        await repo.insertPeriod(row);await scope.recordChange({entityType:'planning_period',entityId:row.id,action:'created',entityRevision:1,diff:{...p},outbox:{type:'planning_period.created',payload:{periodId:row.id,projectId:p.projectId}}});return row;
      });
    },
    async updatePeriod(ctx,id,input) {
      const target=parse(idSchema,id),p=parse(updatePlanningPeriodInputSchema,input);
      return mutate(ctx,'plan.freeze_project','period.update',{periodId:target},p,planningPeriodSchema,async(scope,now)=>{
        const row=found(await scope.repository.findPeriod(scope.context.workspaceId,target));revision(row.revision,p.expectedRevision);
        for(const fieldId of p.protectedFieldIds??row.protectedFieldIds) {const f=found(await scope.repository.fields.findField(row.workspaceId,fieldId));if(f.projectId!==row.projectId||f.archivedAt!==null)throw rule('A protected field must be active in this project.');}
        const next:PlanningPeriodDto={...row,name:p.name??row.name,cutoffAt:p.cutoffAt??row.cutoffAt,protectedFieldIds:p.protectedFieldIds??row.protectedFieldIds,protectEstimate:p.protectEstimate??row.protectEstimate,revision:row.revision+1,updatedAt:now};
        await scope.repository.savePeriod(next);await scope.recordChange({entityType:'planning_period',entityId:row.id,action:'updated',entityRevision:next.revision,diff:{before:row,after:next},outbox:{type:'planning_period.updated',payload:{periodId:row.id,revision:next.revision}}});await scope.cutoffRequests.requestPeriod(next,'period_changed');return next;
      });
    },
    async listPackages(ctx,input) {const q=parse(planningPackageListQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.tasks.findProject(c.workspaceId,q.projectId));return page(repo,c,(await repo.captureProject(c.workspaceId,q.projectId)).packages,q,{kind:'packages',projectId:q.projectId});});},
    async listCommitments(ctx,id,input) {const periodId=parse(idSchema,id),q=parse(periodCommitmentListQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.findPeriod(c.workspaceId,periodId));let rows=await repo.listCommitments(c.workspaceId,periodId);if(q.membershipId)rows=rows.filter(r=>r.membershipId===q.membershipId);return page(repo,c,rows,q,{kind:'commitments',periodId,membershipId:q.membershipId??null});});},
    async createCommitment(ctx,id,input) {
      const periodId=parse(idSchema,id),p=parse(createPeriodCommitmentInputSchema,input);
      return mutate(ctx,'plan.write_self','commitment.create',{periodId},p,periodCommitmentSchema,scope=>createCommitmentInScope(scope,periodId,p,tools),scope=>authorizeMember(scope,p.membershipId,'plan'));
    },
    async updateCommitment(ctx,id,commitmentId,input) {
      const periodId=parse(idSchema,id),cid=parse(idSchema,commitmentId),p=parse(updatePeriodCommitmentInputSchema,input);
      return mutate(ctx,'plan.write_self','commitment.update',{periodId,commitmentId:cid},p,periodCommitmentSchema,scope=>updateCommitmentInScope(scope,periodId,cid,p,tools),async scope=>{const row=found(await scope.repository.findCommitment(scope.context.workspaceId,cid));if(row.periodId!==periodId)throw notFoundError();await authorizeMember(scope,row.membershipId,'plan');});
    },
    async previewFreeze(ctx,id,input) {
      const periodId=parse(idSchema,id),p=parse(freezePreviewInputSchema,input),c=normalize(ctx);
      return writer.read(c,p.scope==='self'?'plan.freeze_self':'plan.freeze_project',async repo=>{
        const access=await authorizeWorkspace(repo.tasks.access,c,p.scope==='self'?'plan.freeze_self':'plan.freeze_project'),period=found(await repo.findPeriod(c.workspaceId,periodId));
        const memberId=p.scope==='self'?access.membership.id:null,existing=(await repo.listBaselines(c.workspaceId,periodId)).find(b=>b.scope===p.scope&&b.membershipId===memberId);
        const snapshot=existing?.snapshot??await captureFreezeSnapshot(repo,period,p.scope,memberId);
        return {periodId,scope:p.scope,membershipId:memberId,previewHash:await freezePreviewHash(tools,repo,c,periodId,p.scope,memberId,snapshot),snapshot,existingBaselineId:existing?.id??null};
      });
    },
    async freezePlan(ctx,id,input) {
      const periodId=parse(idSchema,id),p=parse(freezePlanInputSchema,input);
      return mutate(ctx,p.scope==='self'?'plan.freeze_self':'plan.freeze_project','plan.freeze',{periodId},p,planBaselineSchema,async scope=>{
        const repo=scope.repository,period=found(await repo.findPeriod(scope.context.workspaceId,periodId)),memberId=p.scope==='self'?scope.access.membership.id:null;
        const existing=(await repo.listBaselines(period.workspaceId,periodId)).find(b=>b.scope===p.scope&&b.membershipId===memberId);if(existing)return existing;
        const snapshot=await captureFreezeSnapshot(repo,period,p.scope,memberId);
        if(await freezePreviewHash(tools,repo,scope.context,periodId,p.scope,memberId,snapshot)!==p.previewHash)throw new DomainError('PREVIEW_STALE','The plan changed since the preview. Review it again.');
        return performFreeze(scope,period,p.scope,memberId,'manual',tools);
      });
    },
    async listBaselines(ctx,id,input) {const periodId=parse(idSchema,id),q=parse(planningPageQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.findPeriod(c.workspaceId,periodId));return page(repo,c,await repo.listBaselines(c.workspaceId,periodId),q,{kind:'baselines',periodId});});},
    async getBaseline(ctx,id) {const target=parse(idSchema,id);return read(ctx,async(repo,c)=>found(await repo.findBaseline(c.workspaceId,target)));},
    async getPackageBaseline(ctx,id) {const target=parse(idSchema,id);return read(ctx,async(repo,c)=>found(await repo.findPackageBaseline(c.workspaceId,target)));},
    async getOriginalPackageEstimate(ctx,id) {
      const target=parse(idSchema,id);
      // Current workspace access (UOW), then the current package and its project, before any freeze observation.
      return read(ctx,async(repo,c)=>{
        const pkg=found(await repo.tasks.findWorkPackage(c.workspaceId,target));found(await repo.tasks.findProject(c.workspaceId,pkg.projectId));
        return originalEstimateOf(pkg,await repo.findOriginalPackageEstimateSource(c.workspaceId,pkg.id));
      });
    },
    async listWorkLogs(ctx,input) {const q=parse(workLogListQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.findPeriod(c.workspaceId,q.periodId));let rows=await repo.listWorkLogs(c.workspaceId,q.periodId);if(q.taskId)rows=rows.filter(r=>r.taskId===q.taskId);if(q.membershipId)rows=rows.filter(r=>r.membershipId===q.membershipId);return page(repo,c,rows,q,{kind:'worklogs',periodId:q.periodId,taskId:q.taskId??null,membershipId:q.membershipId??null});});},
    async setManualPeriodWork(ctx,taskId,periodId,memberId,input) {
      const tid=parse(idSchema,taskId),pid=parse(idSchema,periodId),mid=parse(idSchema,memberId),p=parse(setManualPeriodWorkInputSchema,input);
      return mutate(ctx,'time.write_self','work.set',{taskId:tid,periodId:pid,membershipId:mid},p,manualPeriodWorkLogSchema,scope=>setManualPeriodWorkInScope(scope,tid,pid,mid,p,tools),scope=>authorizeMember(scope,mid,'time'));
    },
    async listReportRuns(ctx,input) {const q=parse(reportRunListQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.findPeriod(c.workspaceId,q.periodId));return page(repo,c,await repo.listReportRuns(c.workspaceId,q.periodId),q,{kind:'reports',periodId:q.periodId});},'reports.read');},
    async createReportRun(ctx,input) {
      const p=parse(createWeeklyPlanFactReportInputSchema,input);
      return mutate(ctx,'reports.read','report.create',{baselineId:p.baselineId},p,weeklyPlanFactReportRunSchema,async(scope,now)=>{
        const repo=scope.repository,ws=scope.context.workspaceId,baseline=found(await repo.findBaseline(ws,p.baselineId)),snapshot=baseline.snapshot;
        if(baseline.scope==='self'&&p.membershipIds.some(id=>id!==baseline.membershipId))throw rule('A personal report can include only the baseline member.');
        const sources=await repo.captureProject(ws,baseline.projectId),allLogs=await repo.listRecordedWork(ws,baseline.periodId),current=await repo.listCommitments(ws,baseline.periodId);
        const memberIds=p.membershipIds.length?p.membershipIds:baseline.scope==='self'?[found(baseline.membershipId)]:[...new Set([...snapshot.memberships.map(m=>m.id),...allLogs.map(w=>w.membershipId)])].sort();
        for(const id of memberIds)if(!sources.memberships.some(m=>m.id===id)&&!snapshot.memberships.some(m=>m.id===id))throw notFoundError();
        if(memberIds.length>1000)throw rule('A report supports at most 1000 people. Narrow the selected membership filter.');
        const members=new Set(memberIds),original=snapshot.commitments.filter(c=>c.state==='active'&&members.has(c.membershipId)),selected=original.filter(c=>!p.knownEstimatesOnly||c.plannedMinutes!==null),logs=allLogs.filter(w=>members.has(w.membershipId));
        const name=(id:string)=>snapshot.memberships.find(m=>m.id===id)?.displayName??sources.memberships.find(m=>m.id===id)?.displayName??'Участник';
        const rows:WeeklyPlanFactRowDto[]=[];
        for(const c of selected) {
          const work=logs.filter(w=>w.workPackageId===c.workPackageId&&w.membershipId===c.membershipId),active=work.filter(w=>w.state==='active'),actual=active.reduce((a,w)=>a+w.minutes,0),pkg=snapshot.packages.find(v=>v.id===c.workPackageId),pb=pkg?.packageBaselineId?await repo.findPackageBaseline(ws,pkg.packageBaselineId):null;
          rows.push({id:c.id,scope:'original',commitmentId:c.id,workPackageId:c.workPackageId,membershipId:c.membershipId,title:pkg?.title??'Пакет задач',memberName:name(c.membershipId),plannedMinutes:c.plannedMinutes,actualMinutes:actual,factRecorded:active.length>0,varianceMinutes:c.plannedMinutes!==null&&active.length?actual-c.plannedMinutes:null,packageEstimateMinutes:pb?.estimateMinutes??null,packageBaselineId:pb?.id??null,taskIds:[...new Set([...snapshot.tasks.filter(t=>t.workPackageId===c.workPackageId).map(t=>t.id),...work.map(w=>w.taskId)])].sort(),workLogs:work});
        }
        const originalKeys=new Set(original.map(c=>`${c.workPackageId}:${c.membershipId}`));
        const extraKeys=new Set([...logs.map(w=>`${w.workPackageId}:${w.membershipId}`),...current.filter(c=>c.classification==='added'&&c.state==='active'&&members.has(c.membershipId)).map(c=>`${c.workPackageId}:${c.membershipId}`)]);
        for(const key of [...extraKeys].sort()) {
          if(originalKeys.has(key))continue;const [packageId,mid]=key.split(':');if(!packageId||!mid)continue;
          const work=logs.filter(w=>w.workPackageId===packageId&&w.membershipId===mid),active=work.filter(w=>w.state==='active'),commitment=current.find(c=>c.workPackageId===packageId&&c.membershipId===mid&&c.state==='active'),pkg=sources.packages.find(v=>v.id===packageId);
          rows.push({id:`extra:${key}`,scope:snapshot.projectPackageIds.includes(packageId)?'unplanned':'added_scope',commitmentId:commitment?.id??null,workPackageId:packageId,membershipId:mid,title:pkg?.title??'Пакет задач',memberName:name(mid),plannedMinutes:commitment?.plannedMinutes??null,actualMinutes:active.reduce((a,w)=>a+w.minutes,0),factRecorded:active.length>0,varianceMinutes:null,packageEstimateMinutes:null,packageBaselineId:null,taskIds:[...new Set([...sources.tasks.filter(t=>t.workPackageId===packageId).map(t=>t.id),...work.map(w=>w.taskId)])].sort(),workLogs:work});
        }
        const statuses=await repo.tasks.listStatuses(ws,baseline.projectId);
        for(const row of rows)row.completionAtCalculation=completionAtCalculation(row.workPackageId,sources.tasks,statuses);
        const run={id:newId(),workspaceId:ws,projectId:baseline.projectId,periodId:baseline.periodId,baselineId:baseline.id,metricVersion:'weekly_plan_fact_v1' as const,createdAt:now,actorUserId:scope.context.actor.userId,factCutoffAt:now,factChangeSeq:await repo.currentChangeSeq(ws),membershipIds:memberIds,knownEstimatesOnly:p.knownEstimatesOnly,cohort:{selectedItemCount:selected.length,originalItemCount:original.length},summary:summary(rows),byPerson:memberIds.map(membershipId=>({membershipId,memberName:name(membershipId),summary:summary(rows.filter(r=>r.membershipId===membershipId))})),rowCount:rows.length,workLogRevisionIds:logs.map(w=>w.revisionId).sort()};
        await repo.insertReportRun(run,rows);await scope.recordChange({entityType:'report_run',entityId:run.id,action:'created',entityRevision:1,diff:{baselineId:baseline.id,metricVersion:run.metricVersion,factCutoffAt:now,rowCount:rows.length},outbox:{type:'report_run.created',payload:{runId:run.id,periodId:run.periodId}}});return run;
      });
    },
    async getReportRun(ctx,id) {const target=parse(idSchema,id);return read(ctx,async(repo,c)=>found(await repo.findReportRun(c.workspaceId,target)).run,'reports.read');},
    async listReportRows(ctx,id,input) {const target=parse(idSchema,id),q=parse(planningPageQuerySchema,input);return read(ctx,async(repo,c)=>page(repo,c,found(await repo.findReportRun(c.workspaceId,target)).rows,q,{kind:'report_rows',runId:target}),'reports.read');},
  };
}
