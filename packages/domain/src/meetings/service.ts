import {
 idSchema,meetingListQuerySchema,createMeetingInputSchema,updateMeetingInputSchema,meetingSchema,meetingCreationSchema,
 confirmAttendanceInputSchema,attendancePostingSchema,planningPageQuerySchema,recordedWorkListQuerySchema,
 meetingPlanPreviewInputSchema,applyMeetingPlanInputSchema,meetingPlanResultSchema,
 type AttendanceDto,type AttendanceHistoryDto,type AttendanceWorkLogDto,type CreateMeetingInput,type MeetingCreationDto,type MeetingDto,type UpdateMeetingInput,type MeetingPlanPreviewInput,type MeetingPlanPreviewDto,type PeriodCommitmentDto,type PlanningPeriodDto,type PlanningPageQuery,type TaskDto,
} from '@workloom/contracts';
import {authorizeWorkspace} from '../access/access-queries.js';
import {roleHasCapability,type Capability} from '../access/capabilities.js';
import type {CommandContext} from '../access/context.js';
import {canonicalWorkCategory} from '../categories/resolver.js';
import {capabilityRequiredError,DomainError,notFoundError,unauthenticatedError} from '../errors.js';
import {createPlanningMutationGuard,isCommittedPlanningRejection,unwrapPlanningOutcome} from '../planning/freeze.js';
import type {PlanningPage} from '../planning/application.js';
import type {PlanningTools} from '../planning/ports.js';
import type {MeetingOccurrenceIdentity} from '../recurrence/ports.js';
import {canonicalJson} from '../tasks/service.js';
import type {MeetingApplication} from './application.js';
import type {MeetingApplicationDependencies,MeetingMutationCommand,MeetingRepository,MeetingWriteScope} from './ports.js';
interface Parser<T>{safeParse(value:unknown):{success:true;data:T}|{success:false;error:{issues:readonly {path:readonly PropertyKey[]}[]}}}
function parse<T>(schema:Parser<T>,input:unknown):T{const p=schema.safeParse(input);if(p.success)return p.data;throw new DomainError('VALIDATION_FAILED','Invalid meeting input.',{details:{fields:p.error.issues.map(i=>i.path.join('.'))}});}
function found<T>(v:T|null):T{if(v===null)throw notFoundError();return v;}
function rule(message:string):DomainError{return new DomainError('DOMAIN_VALIDATION_FAILED',message);}
function revision(actual:number,expected:number):void{if(actual!==expected)throw new DomainError('REVISION_CONFLICT','The source changed. Reload it before saving.');}
function normalize(ctx:CommandContext):CommandContext{if(!ctx.actor||!idSchema.safeParse(ctx.actor.userId).success)throw unauthenticatedError();return {...ctx,workspaceId:parse(idSchema,ctx.workspaceId),actor:{...ctx.actor,userId:parse(idSchema,ctx.actor.userId)}};}
export function meetingLocalDate(instant:string,timezone:string):string{const parts=new Intl.DateTimeFormat('en',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));const part=(type:string)=>parts.find(p=>p.type===type)?.value??'';return `${part('year')}-${part('month')}-${part('day')}`;}
export function requireMeetingPeriod(period:PlanningPeriodDto,instant:string):void{const date=meetingLocalDate(instant,period.timezone);if(date<period.localStart||date>=period.localEndExclusive)throw rule('The meeting instant must belong to the explicitly selected period.');}
type NewId=()=>string;
function idFactory(tools:Pick<PlanningTools,'newId'>):NewId{return ()=>parse(idSchema,tools.newId());}
async function meetingEvent(scope:MeetingWriteScope,meeting:MeetingDto,action:string,reason?:string){return scope.recordChange({entityType:'meeting',entityId:meeting.id,action,entityRevision:meeting.revision,diff:{taskId:meeting.taskId,periodId:meeting.plannedPeriodId,revision:meeting.revision},...(reason?{reason}:{}),outbox:{type:`meeting.${action}`,payload:{meetingId:meeting.id,taskId:meeting.taskId,revision:meeting.revision}}});}
async function writeAttendanceRevision(scope:MeetingWriteScope,newId:NewId,row:AttendanceDto,projectId:string,exists:boolean,now:string,reason:string|null,changeSeq:bigint){await scope.meetings.saveAttendance(row,projectId,exists);const h:AttendanceHistoryDto={id:newId(),attendanceId:row.id,revision:row.revision,rosterActive:row.rosterActive,status:row.status,postingState:row.postingState,minutes:row.minutes,confirmedMeetingRevision:row.confirmedMeetingRevision,actorUserId:scope.context.actor.userId,reason,recordedAt:now,changeSeq:changeSeq.toString(),workLog:row.workLog};await scope.meetings.insertAttendanceRevision(h,row.workspaceId);}
/** Ordinary single-meeting create body on an ALREADY OPEN scope (docs16 §8). It never calls public createMeeting,
 * writer.run, runWorkspaceWrite or the planning guard; the caller owns authorization, replay and the guard.
 * The project is the selected period's project. identity is optional only here; the recurrence composer always passes
 * the reserved header identity and attaches the locator in the same tx. Without identity no `recurrence` key is written.
 */
export async function createSingleMeetingInScope(scope:MeetingWriteScope,p:CreateMeetingInput,tools:Pick<PlanningTools,'newId'>,identity?:MeetingOccurrenceIdentity):Promise<MeetingCreationDto>{
 const newId=idFactory(tools),now=scope.barrierAt.toISOString(),repo=scope.repository,ws=scope.context.workspaceId;
 const period=found(await repo.findPeriod(ws,p.plannedPeriodId)),projectId=period.projectId,project=found(await repo.tasks.findProject(ws,projectId));if(project.archivedAt)throw rule('The project is archived.');requireMeetingPeriod(period,p.plannedStartAt);
 const status=found(await repo.tasks.findStatus(ws,p.statusId));if(status.projectId!==projectId)throw rule('The status belongs to another project.');if(p.sectionId){const section=found(await repo.tasks.findSection(ws,p.sectionId));if(section.projectId!==projectId||section.archivedAt)throw rule('The section is unavailable in this project.');}
 const sources=await repo.captureProject(ws,projectId);for(const id of [...p.attendeeMembershipIds,p.organizerMembershipId])if(!sources.activeMembershipIds.includes(id))throw notFoundError();
 const mid=newId(),taskId=newId(),packageId=newId(),estimate=p.plannedDurationMinutes*p.attendeeMembershipIds.length;
 await repo.tasks.insertWorkPackage({id:packageId,workspaceId:ws,projectId,origin:'new_task',sourcePackageId:null,estimateMinutes:estimate,revision:1,createdAt:now,updatedAt:now});
 const task:TaskDto={id:taskId,meetingId:mid,workspaceId:ws,projectId,sectionId:p.sectionId??null,parentTaskId:null,workPackageId:packageId,workPackageRevision:1,title:p.title,description:'',statusId:p.statusId,responsibleMembershipId:p.organizerMembershipId,participants:p.attendeeMembershipIds.map(membershipId=>({membershipId,role:'assignee',active:true,revision:1})),participantsRevision:1,dueDate:meetingLocalDate(p.plannedStartAt,p.timezone),priority:'none',tags:[],estimateMinutes:estimate,revision:1,position:Math.max(0,...sources.tasks.map(t=>t.position+1)),visibility:'workspace',archivedAt:null,createdAt:now,updatedAt:now};
 await repo.tasks.insertTaskCore(task);await repo.tasks.saveParticipants(ws,taskId,task.participants,now);
 const meeting:MeetingDto={id:mid,workspaceId:ws,projectId,taskId,workPackageId:packageId,revision:1,participantsRevision:1,plannedPeriodId:period.id,plannedStartAt:p.plannedStartAt,timezone:p.timezone,plannedDurationMinutes:p.plannedDurationMinutes,organizerMembershipId:p.organizerMembershipId,state:'scheduled',actualStartAt:null,actualDurationMinutes:null,joinUrl:p.joinUrl??null,recordingUrl:null,summaryUrl:null,summaryText:null,scheduleFrozen:false,hasPostedAttendance:false,createdAt:now,updatedAt:now,
  ...(identity?{recurrence:{seriesId:identity.seriesId,instanceId:identity.instanceId,occurrenceKey:identity.occurrenceKey,nominalSequence:identity.nominalSequence}}:{})};
 await scope.meetings.saveMeeting(meeting,false);const change=await meetingEvent(scope,meeting,'created');await scope.meetings.insertMeetingRevision(meeting,scope.context.actor.userId,change.changeSeq,newId());
 const attendances:AttendanceDto[]=[];for(const membershipId of p.attendeeMembershipIds){const row:AttendanceDto={id:newId(),workspaceId:ws,meetingId:mid,taskId,membershipId,revision:1,rosterActive:true,status:'unknown',postingState:'unconfirmed',minutes:null,confirmedMeetingRevision:null,workLog:null};await writeAttendanceRevision(scope,newId,row,projectId,false,now,null,change.changeSeq);attendances.push(row);}
 return {task,meeting,attendances,planProposals:p.attendeeMembershipIds.map(membershipId=>({membershipId,proposedMinutes:p.plannedDurationMinutes,workPackageId:packageId,plannedPeriodId:period.id}))};
}
/** Meeting update body on an ALREADY OPEN scope; no runner, replay or guard. Actual/recording/summary/attendance
 * statuses change only when the input names them, and the occurrence locator is preserved by the spread.
 */
export async function updateSingleMeetingInScope(scope:MeetingWriteScope,taskId:string,p:UpdateMeetingInput,tools:Pick<PlanningTools,'newId'>):Promise<MeetingDto>{
 const newId=idFactory(tools),now=scope.barrierAt.toISOString();
 const repo=scope.repository,ws=scope.context.workspaceId,m=found(await repo.findMeetingByTask(ws,taskId)),task=found(await repo.tasks.findTask(ws,taskId));revision(m.revision,p.expectedMeetingRevision);
 const changes=Object.fromEntries(Object.entries(p).filter(([k])=>!k.startsWith('expected')&&k!=='attendeeMembershipIds')),next:MeetingDto={...m,...changes,revision:m.revision+1,updatedAt:now};
 if(Date.parse(next.plannedStartAt)===Date.parse(m.plannedStartAt))next.plannedStartAt=m.plannedStartAt;
 if(next.actualStartAt!==null&&m.actualStartAt!==null&&Date.parse(next.actualStartAt)===Date.parse(m.actualStartAt))next.actualStartAt=m.actualStartAt;
 const roster=await repo.listAttendance(ws,m.id),wanted=p.attendeeMembershipIds??roster.filter(a=>a.rosterActive).map(a=>a.membershipId),rosterChanged=canonicalJson([...wanted].sort())!==canonicalJson(roster.filter(a=>a.rosterActive).map(a=>a.membershipId).sort());
 const pkg=found(await repo.tasks.findWorkPackage(ws,m.workPackageId));if(p.expectedWorkPackageRevision!==undefined)revision(pkg.revision,p.expectedWorkPackageRevision);if(p.expectedParticipantsRevision!==undefined)revision(task.participantsRevision,p.expectedParticipantsRevision);
 if(rosterChanged&&m.hasPostedAttendance)throw rule('A roster with an ever-posted attendance source is retained.');
 const period=found(await repo.findPeriod(ws,m.plannedPeriodId));requireMeetingPeriod(period,next.plannedStartAt);if(next.actualStartAt)requireMeetingPeriod(period,next.actualStartAt);
 const active=(await repo.captureProject(ws,m.projectId)).activeMembershipIds;for(const member of [...wanted,next.organizerMembershipId])if(!active.includes(member)&&!(roster.some(a=>a.membershipId===member&&a.rosterActive)||member===m.organizerMembershipId))throw notFoundError();
 const comparable=(value:MeetingDto)=>({...value,revision:0,updatedAt:'',participantsRevision:0});if(!rosterChanged&&canonicalJson(comparable(m))===canonicalJson(comparable(next)))return m;
 const durationChanged=next.plannedDurationMinutes!==m.plannedDurationMinutes;
 if(rosterChanged||durationChanged){const estimate=next.plannedDurationMinutes*wanted.length;await repo.tasks.saveWorkPackage({...pkg,estimateMinutes:estimate,revision:pkg.revision+1,updatedAt:now});}
 const updatedTask={...task,responsibleMembershipId:next.organizerMembershipId,dueDate:meetingLocalDate(next.plannedStartAt,next.timezone),participantsRevision:task.participantsRevision+(rosterChanged?1:0),revision:task.revision+1,updatedAt:now};
 await repo.tasks.saveTaskCore(updatedTask);next.participantsRevision=updatedTask.participantsRevision;
 if(rosterChanged){const participants=task.participants.map(a=>({...a,active:wanted.includes(a.membershipId),revision:a.revision+(a.active!==wanted.includes(a.membershipId)?1:0)}));for(const membershipId of wanted)if(!participants.some(a=>a.membershipId===membershipId))participants.push({membershipId,role:'assignee',active:true,revision:1});await repo.tasks.saveParticipants(ws,taskId,participants,now);}
 await scope.meetings.saveMeeting(next,true);const change=await meetingEvent(scope,next,'updated');await scope.meetings.insertMeetingRevision(next,scope.context.actor.userId,change.changeSeq,newId());
 if(rosterChanged){for(const row of roster){const active=wanted.includes(row.membershipId);if(row.rosterActive!==active)await writeAttendanceRevision(scope,newId,{...row,rosterActive:active,revision:row.revision+1},m.projectId,true,now,null,change.changeSeq);}for(const membershipId of wanted)if(!roster.some(a=>a.membershipId===membershipId))await writeAttendanceRevision(scope,newId,{id:newId(),workspaceId:ws,meetingId:m.id,taskId,membershipId,revision:1,rosterActive:true,status:'unknown',postingState:'unconfirmed',minutes:null,confirmedMeetingRevision:null,workLog:null},m.projectId,false,now,null,change.changeSeq);}
 return next;
}
export function createMeetingApplication(deps:MeetingApplicationDependencies):MeetingApplication{
 const {writer,tools}=deps,newId=idFactory(tools),hash=(v:unknown)=>tools.digest(canonicalJson(v));
 async function read<T>(ctx:CommandContext,work:(repo:MeetingRepository,c:CommandContext)=>Promise<T>,cap:Capability='task.read'):Promise<T>{const c=normalize(ctx);return writer.read(c,cap,repo=>work(repo,c));}
 async function page<T extends{id:string}>(repo:MeetingRepository,ctx:CommandContext,rows:T[],q:PlanningPageQuery,filter:unknown):Promise<PlanningPage<T>>{
  const epoch=await repo.planning.tasks.permissionEpoch(ctx.workspaceId),queryHash=hash(filter);let after='';
  if(q.cursor){let c;try{c=tools.decodeCursor(q.cursor);}catch{throw new DomainError('VALIDATION_FAILED','Invalid cursor. Reload the first page.');}if(c.workspaceId!==ctx.workspaceId||c.actorUserId!==ctx.actor.userId||c.permissionEpoch!==epoch||c.queryHash!==queryHash)throw new DomainError('VALIDATION_FAILED','Cursor does not match this list.');after=c.afterId;}
  const ordered=[...rows].sort((a,b)=>a.id.localeCompare(b.id)).filter(r=>r.id>after),items=ordered.slice(0,q.limit),last=items.at(-1);
  return {items,nextCursor:ordered.length>q.limit&&last?tools.encodeCursor({version:1,workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,permissionEpoch:epoch,queryHash,afterId:last.id}):null};
 }
 async function mutate<T>(context:CommandContext,cap:Capability,command:MeetingMutationCommand,target:unknown,input:unknown,schema:Parser<T>,work:(scope:MeetingWriteScope,now:string)=>Promise<T>,authorize?:(scope:MeetingWriteScope)=>Promise<void>):Promise<T>{
  const ctx=normalize(context),key=ctx.idempotencyKey;if(key===undefined||!/^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');const payloadHash=hash({command,target,input});
  const outcome=await writer.run(ctx,cap,async scope=>{
   if(authorize)await authorize(scope);
   const repo=scope.repository.tasks,old=await repo.findIdempotency(ctx.workspaceId,ctx.actor.userId,command,key);
   if(old){if(old.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key was used for another request.');return isCommittedPlanningRejection(old.result)?old.result:parse(schema,old.result);}
   const rejected=await createPlanningMutationGuard(scope,tools).check({family:'meeting',command,target,input}),now=scope.barrierAt.toISOString(),result=rejected??await work(scope,now);
   await repo.insertIdempotency({workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:now});return result;
  });return unwrapPlanningOutcome(outcome);
 }
 async function authorizeWorkers(repo:MeetingRepository,ctx:CommandContext,ids:string[],kind:'time'|'plan'):Promise<void>{const access=await authorizeWorkspace(repo.planning.tasks.access,ctx,kind==='time'?'time.write_self':'plan.write_self');if(ids.some(id=>id!==access.membership.id)&&!roleHasCapability(access.membership.role,kind==='time'?'time.write_others':'plan.write_others'))throw capabilityRequiredError();}
 async function authorizeAttendance(scope:MeetingWriteScope,taskId:string,ids:string[]):Promise<void>{const m=found(await scope.repository.findMeetingByTask(scope.context.workspaceId,taskId)),rows=await scope.repository.listAttendance(scope.context.workspaceId,m.id);const selected=ids.map(id=>found(rows.find(r=>r.id===id)??null));await authorizeWorkers(scope.meetings,scope.context,selected.map(r=>r.membershipId),'time');}
 async function attendanceRevision(scope:MeetingWriteScope,row:AttendanceDto,projectId:string,exists:boolean,now:string,reason:string|null,changeSeq:bigint){await writeAttendanceRevision(scope,newId,row,projectId,exists,now,reason,changeSeq);}
 async function buildPreview(repo:MeetingRepository,ctx:CommandContext,taskId:string,p:MeetingPlanPreviewInput):Promise<MeetingPlanPreviewDto>{
  const ws=ctx.workspaceId,m=found(await repo.planning.findMeetingByTask(ws,taskId));revision(m.revision,p.expectedMeetingRevision);if(m.state!=='scheduled')throw rule('A cancelled meeting cannot create personal plans.');
  const roster=(await repo.planning.listAttendance(ws,m.id)).filter(a=>a.rosterActive),source=await repo.planning.captureProject(ws,m.projectId);for(const r of p.rows)if(!roster.some(a=>a.membershipId===r.membershipId)||!source.activeMembershipIds.includes(r.membershipId))throw notFoundError();
  await authorizeWorkers(repo,ctx,p.rows.map(r=>r.membershipId),'plan');const period=found(await repo.planning.findPeriod(ws,m.plannedPeriodId)),task=found(await repo.planning.tasks.findTask(ws,taskId)),commitments=await repo.planning.listCommitments(ws,period.id);
  const rows=[...p.rows].sort((a,b)=>a.membershipId.localeCompare(b.membershipId)).map(r=>{const c=commitments.find(c=>c.workPackageId===m.workPackageId&&c.membershipId===r.membershipId)??null;return {...r,commitment:c,expectedCommitmentRevision:c?.revision??null,allocations:r.plannedMinutes===null?[]:[{taskId,minutes:r.plannedMinutes}],unallocatedMinutes:r.plannedMinutes===null?null:0};});
  const previewHash=hash({meeting:m,task,period,rows,sources:source,commitments,locks:await repo.planning.listLocks(ws),meetingLocks:await repo.planning.listMeetingLocks(ws,m.id),actorUserId:ctx.actor.userId,permissionEpoch:await repo.planning.tasks.permissionEpoch(ws)});
  return {meetingId:m.id,periodId:period.id,meetingRevision:m.revision,participantsRevision:task.participantsRevision,workPackageRevision:task.workPackageRevision,periodRevision:period.revision,previewHash,rows};
 }
 return {
  async listMeetings(ctx,id,input){const projectId=parse(idSchema,id),q=parse(meetingListQuerySchema,input);return read(ctx,async(repo,c)=>{const ws=c.workspaceId;found(await repo.planning.tasks.findProject(ws,projectId));const period=found(await repo.planning.findPeriod(ws,q.plannedPeriodId));if(period.projectId!==projectId)throw rule('The period belongs to another project.');const rows=(await repo.planning.listMeetings(ws,projectId)).filter(m=>m.plannedPeriodId===q.plannedPeriodId&&(q.state==='all'||m.state===q.state));const result=await page(repo,c,rows,q,{kind:'meetings',projectId,periodId:q.plannedPeriodId,state:q.state});const projected=await repo.planning.tasks.findTasksByIds(ws,result.items.map(m=>m.taskId));return {items:result.items.map(meeting=>({task:found(projected.find(t=>t.id===meeting.taskId)??null),meeting})),nextCursor:result.nextCursor};});},
  async getMeeting(ctx,id){const taskId=parse(idSchema,id);return read(ctx,async(repo,c)=>found(await repo.planning.findMeetingByTask(c.workspaceId,taskId)));},
  async createMeeting(ctx,id,input){const projectId=parse(idSchema,id),p=parse(createMeetingInputSchema,input);return mutate(ctx,'task.edit','meeting.create',{projectId},p,meetingCreationSchema,async scope=>{
   const repo=scope.repository,ws=scope.context.workspaceId,project=found(await repo.tasks.findProject(ws,projectId));if(project.archivedAt)throw rule('The project is archived.');const period=found(await repo.findPeriod(ws,p.plannedPeriodId));if(period.projectId!==projectId)throw rule('The period belongs to another project.');
   return createSingleMeetingInScope(scope,p,tools);
  });},
  async updateMeeting(ctx,id,input){const taskId=parse(idSchema,id),p=parse(updateMeetingInputSchema,input);return mutate(ctx,'task.edit','meeting.update',{taskId},p,meetingSchema,scope=>updateSingleMeetingInScope(scope,taskId,p,tools));},
  async listAttendance(ctx,id,input){const taskId=parse(idSchema,id),q=parse(planningPageQuerySchema,input);return read(ctx,async(repo,c)=>{const m=found(await repo.planning.findMeetingByTask(c.workspaceId,taskId));return page(repo,c,await repo.planning.listAttendance(c.workspaceId,m.id),q,{kind:'attendance',taskId});});},
  async confirmAttendance(ctx,id,input){const taskId=parse(idSchema,id),p=parse(confirmAttendanceInputSchema,input);return mutate(ctx,'time.write_self','meeting.attendance.confirm',{taskId},p,attendancePostingSchema,async(scope,now)=>{
   const repo=scope.repository,ws=scope.context.workspaceId,m=found(await repo.findMeetingByTask(ws,taskId));revision(m.revision,p.expectedMeetingRevision);if(p.periodId!==m.plannedPeriodId)throw rule('Cross-period attendance is deferred.');const period=found(await repo.findPeriod(ws,p.periodId)),rows=await repo.listAttendance(ws,m.id),active=(await repo.captureProject(ws,m.projectId)).activeMembershipIds;
   const prepared=[];
   for(const input of p.rows){const a=found(rows.find(a=>a.id===input.attendanceId)??null);if(!a.rosterActive)throw rule('The attendee is not in the current roster.');revision(a.revision,input.expectedAttendanceRevision);const old=a.workLog;if(old?old.revision!==input.expectedWorkLogRevision:input.expectedWorkLogRevision!==null)throw new DomainError('REVISION_CONFLICT','The current attendance work source changed.');
    if(!old&&!active.includes(a.membershipId))throw notFoundError();
    let status=a.status,minutes=old?.minutes??0,state:'active'|'void'='active',attribution=old?.attribution;
    if(input.kind==='void'){if(!old)throw rule('An unconfirmed source cannot be voided.');state='void';}
    else {status=input.status;if(m.state==='cancelled'&&(status!=='absent'||input.attributionBasis!=='planned_absence'))throw rule('Restore a cancelled meeting before posting presence.');if(m.state==='cancelled'&&!input.reason)throw rule('Cancelled meeting absence requires a reason.');
     if(input.attributionBasis==='actual_meeting'){if(!m.actualStartAt||m.actualDurationMinutes===null)throw rule('Save actual meeting start and duration before confirming presence.');requireMeetingPeriod(period,m.actualStartAt);attribution={basis:'actual_meeting' as const,plannedStartAt:m.plannedStartAt,actualStartAt:m.actualStartAt};}else attribution={basis:'planned_absence' as const,plannedStartAt:m.plannedStartAt,actualStartAt:null};
     if(status==='present'){minutes=found(m.actualDurationMinutes);if(input.minutes!==undefined&&input.minutes!==minutes)throw rule('Present minutes equal the confirmed actual duration.');}
     else if(status==='partial'){if(input.minutes===undefined)throw rule('Partial minutes are required.');minutes=input.minutes;if(m.actualDurationMinutes===null||minutes>m.actualDurationMinutes)throw rule('Partial minutes cannot exceed actual duration.');}else minutes=0;
    }
    if(!attribution)throw rule('The attendance attribution is missing.');
    const unchanged=old&&status===a.status&&state===old.state&&minutes===old.minutes&&canonicalJson(attribution)===canonicalJson(old.attribution);
    const reason=input.reason??null;if(!unchanged&&old&&reason===null)throw rule('A correction, void or restore requires a reason.');
    prepared.push({a,old,status,minutes,state,attribution,reason,unchanged,confirmedMeetingRevision:input.kind==='void'&&old?old.confirmedMeetingRevision:m.revision});
   }
   for(const row of prepared){if(row.unchanged)continue;const {a,old}=row,workId=old?.id??newId(),workRevision=(old?.revision??0)+1;const change=await scope.recordChange({entityType:'meeting_attendance',entityId:a.id,action:old?'revised':'confirmed',entityRevision:a.revision+1,diff:{meetingId:m.id,membershipId:a.membershipId,periodId:p.periodId,minutes:row.minutes,status:row.status,state:row.state},...(row.reason?{reason:row.reason}:{}),outbox:{type:'meeting.attendance_posted',payload:{meetingId:m.id,attendanceId:a.id,workLogId:workId,revision:workRevision}}});
    const work:AttendanceWorkLogDto={id:workId,workspaceId:ws,projectId:m.projectId,taskId,workPackageId:m.workPackageId,membershipId:a.membershipId,periodId:p.periodId,sourceKind:'meeting_attendance',sourceKey:a.id,precision:'occurrence',meetingId:m.id,attendanceId:a.id,confirmedMeetingRevision:row.confirmedMeetingRevision,attribution:row.attribution,revision:workRevision,revisionId:newId(),minutes:row.minutes,state:row.state,reason:row.reason,actorUserId:scope.context.actor.userId,recordedAt:now,changeSeq:change.changeSeq.toString(),category:old?canonicalWorkCategory(old):await scope.categoryResolver.resolve(taskId)};
    await repo.saveRecordedWork(work);await repo.insertWorkRevision(work);await attendanceRevision(scope,{...a,revision:a.revision+1,status:row.status,postingState:row.state,minutes:row.minutes,confirmedMeetingRevision:work.confirmedMeetingRevision,workLog:work},m.projectId,true,now,row.reason,change.changeSeq);
   }
   return {meeting:found(await repo.findMeetingByTask(ws,taskId)),attendances:await repo.listAttendance(ws,m.id)};
  },scope=>authorizeAttendance(scope,taskId,p.rows.map(r=>r.attendanceId)));},
  async listRecordedWork(ctx,input){const q=parse(recordedWorkListQuerySchema,input);return read(ctx,async(repo,c)=>{found(await repo.planning.findPeriod(c.workspaceId,q.periodId));let rows=await repo.planning.listRecordedWork(c.workspaceId,q.periodId);if(q.taskId)rows=rows.filter(r=>r.taskId===q.taskId);if(q.membershipId)rows=rows.filter(r=>r.membershipId===q.membershipId);return page(repo,c,rows,q,{kind:'recorded-work',periodId:q.periodId,taskId:q.taskId??null,membershipId:q.membershipId??null});});},
  async listAttendanceHistory(ctx,id,attendanceId,input){const taskId=parse(idSchema,id),aid=parse(idSchema,attendanceId),q=parse(planningPageQuerySchema,input);return read(ctx,async(repo,c)=>{const m=found(await repo.planning.findMeetingByTask(c.workspaceId,taskId));found((await repo.planning.listAttendance(c.workspaceId,m.id)).find(a=>a.id===aid)??null);return page(repo,c,await repo.listAttendanceHistory(c.workspaceId,aid),q,{kind:'attendance-history',taskId,attendanceId:aid});});},
  async previewMeetingPlan(ctx,id,input){const taskId=parse(idSchema,id),p=parse(meetingPlanPreviewInputSchema,input);return read(ctx,(repo,c)=>buildPreview(repo,c,taskId,p),'plan.write_self');},
  async applyMeetingPlan(ctx,id,input){const taskId=parse(idSchema,id),p=parse(applyMeetingPlanInputSchema,input);return mutate(ctx,'plan.write_self','meeting.plan.apply',{taskId},p,meetingPlanResultSchema,async(scope,now)=>{
   const preview=await buildPreview(scope.meetings,scope.context,taskId,{expectedMeetingRevision:p.expectedMeetingRevision,rows:p.rows.map(({membershipId,plannedMinutes})=>({membershipId,plannedMinutes}))});if(preview.previewHash!==p.previewHash)throw new DomainError('PREVIEW_STALE','The meeting plan changed. Review the preview again.');const m=found(await scope.repository.findMeetingByTask(scope.context.workspaceId,taskId));const commitments:PeriodCommitmentDto[]=[];
   for(const row of preview.rows){const expected=found(p.rows.find(r=>r.membershipId===row.membershipId)??null);if(expected.expectedCommitmentRevision!==row.expectedCommitmentRevision)throw new DomainError('REVISION_CONFLICT','The personal commitment changed.');const old=row.commitment;
    if(old&&old.state==='active'&&old.plannedMinutes===row.plannedMinutes&&canonicalJson(old.allocations)===canonicalJson(row.allocations)){commitments.push(old);continue;}
    const baselines=await scope.repository.listBaselines(m.workspaceId,m.plannedPeriodId),original=baselines.some(b=>(b.scope==='project'||b.membershipId===row.membershipId)&&old&&b.snapshot.commitments.some(c=>c.id===old.id)),added=baselines.some(b=>b.scope==='project'||b.membershipId===row.membershipId)&&!original;
    const next:PeriodCommitmentDto={id:old?.id??newId(),workspaceId:m.workspaceId,projectId:m.projectId,periodId:m.plannedPeriodId,workPackageId:m.workPackageId,membershipId:row.membershipId,plannedMinutes:row.plannedMinutes,allocations:row.allocations,unallocatedMinutes:row.unallocatedMinutes,state:'active',revision:(old?.revision??0)+1,classification:old?.classification==='added'||added?'added':'planned',baselineIds:old?.baselineIds??[],createdAt:old?.createdAt??now,updatedAt:now};
    await scope.repository.saveCommitment(next);const change=await scope.recordChange({entityType:'period_commitment',entityId:next.id,action:old?'updated':'created',entityRevision:next.revision,diff:{meetingId:m.id,periodId:m.plannedPeriodId,membershipId:row.membershipId,plannedMinutes:next.plannedMinutes},outbox:{type:'meeting.plan_applied',payload:{meetingId:m.id,commitmentId:next.id,revision:next.revision}}});await scope.repository.insertCommitmentRevision(next,scope.context.actor.userId,change.changeSeq,newId());commitments.push(next);
   }return {meetingId:m.id,periodId:m.plannedPeriodId,commitments};
  },scope=>authorizeWorkers(scope.meetings,scope.context,p.rows.map(r=>r.membershipId),'plan'));},
 };
}
