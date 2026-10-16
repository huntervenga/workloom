import {recurrenceSnapshotSectionSchema,type MeetingCreationDto,type PlanningPeriodDto,type RecurrenceResolutionDto,type RecurrenceScheduleInput} from '@workloom/contracts';
import {describe,expect,it} from 'vitest';
import type {WorkspaceRole} from '../access/capabilities.js';
import {createPlanningMutationGuard} from '../planning/freeze.js';
import type {PlanningRepository} from '../planning/ports.js';
import {bindingSourceManifestHash,createRecurrenceScopedMaterializer,loadSeriesContext} from './materializer.js';
import type {
 RecurrenceCalendarLock,RecurrenceExceptionVersionRecord,RecurrenceGenerationAuthorizationRecord,RecurrenceInstanceHeader,RecurrenceJobWriteScope,RecurrenceNominalCandidate,
 RecurrenceOccurrenceComposer,RecurrenceOccurrenceResolver,RecurrencePeriodBindingRecord,RecurrenceRepository,RecurrenceSeriesRecord,RecurrenceSeriesVersionRecord,
 RecurrenceTools,RecurrenceWriteScope,
} from './ports.js';
import {createRecurrenceWorkerFacade} from './worker.js';

// In-memory doubles exercise the pure census/guard/chunk decisions. Real PostgreSQL QA owns atomicity, races and FKs.
function required<T>(value:T|null|undefined):T{if(value===null||value===undefined)throw new Error('Missing fixture');return value;}
let seq=0;
const uuid=()=>`00000000-0000-4000-8000-${String(++seq).padStart(12,'0')}`;
const ws='10000000-0000-4000-8000-000000000001',projectA='10000000-0000-4000-8000-00000000000a',projectB='10000000-0000-4000-8000-00000000000b';
const member='10000000-0000-4000-8000-000000000101',user='10000000-0000-4000-8000-000000000201',statusA='10000000-0000-4000-8000-000000000301',statusB='10000000-0000-4000-8000-000000000302';
const now=new Date('2026-10-16T12:00:00.000Z'),stamp=now.toISOString();
const day=(start:string,n:number)=>new Date(Date.parse(`${start}T00:00:00Z`)+n*86400000).toISOString().slice(0,10);

const resolution=(date:string,time:string,timezone:string,minutes:number):RecurrenceResolutionDto=>{
 const start=new Date(`${date}T${time}:00.000Z`);
 return {policyVersion:'first_valid_gap_earlier_overlap_v1',intendedLocalDate:date,intendedLocalTime:time,resolvedStartAt:start.toISOString(),resolvedEndAt:new Date(start.getTime()+minutes*60000).toISOString(),resolvedLocalDate:date,resolvedLocalTime:time,resolvedOffset:'+00:00',plannedDurationMinutes:minutes,warning:null,provenance:{timezone,implementation:'test',tzdataVersion:null,icuVersion:null}};
};
/** UTC-only daily test resolver; the real calendar/DST resolver belongs to the schedule lane. */
const resolver:RecurrenceOccurrenceResolver={
 policyVersion:'first_valid_gap_earlier_overlap_v1',
 provenance:timezone=>({timezone,implementation:'test',tzdataVersion:null,icuVersion:null}),
 enumerateNominalCandidates(segments){
  const first=segments[0];if(!first)return [];const end=first.schedule.end,out:RecurrenceNominalCandidate[]=[];
  for(let i=0;;i++){const key=day(first.schedule.startDate,i);if(end.kind==='on_date'?key>end.endDate:i>=end.count)break;
   const segment=[...segments].reverse().find(s=>s.effectiveFromNominalDate<=key)??first;out.push({occurrenceKey:key,nominalSequence:end.kind==='after_count'?i+1:null,sourceVersionId:segment.versionId});}
  return out;
 },
 resolveOccurrence:resolution,
};
const tools:RecurrenceTools={newId:uuid,digest:v=>{let hash=2166136261;for(const char of v)hash=Math.imul(hash^char.charCodeAt(0),16777619);return (hash>>>0).toString(16).padStart(8,'0').repeat(8);},encodeCursor:()=>'c',decodeCursor:()=>{throw new Error('unused');},resolver,encodeMaterializationCursor:c=>JSON.stringify(c),decodeMaterializationCursor:t=>JSON.parse(t)};

function memory() {
 const series=new Map<string,RecurrenceSeriesRecord>(),versions:RecurrenceSeriesVersionRecord[]=[],grants=new Map<string,RecurrenceGenerationAuthorizationRecord>();
 const bindings=new Map<string,RecurrencePeriodBindingRecord>(),headers=new Map<string,RecurrenceInstanceHeader>(),exceptions:RecurrenceExceptionVersionRecord[]=[],locks:RecurrenceCalendarLock[]=[];
 const periods=new Map<string,PlanningPeriodDto>(),meetings=new Map<string,{id:string;revision:number;participantsRevision:number}>(),tasks=new Map<string,{id:string;projectId:string;workPackageId:string;meetingId:null}>();
 const roles=new Map<string,{role:WorkspaceRole;state:'active'|'revoked'}>([[user,{role:'member',state:'active'}]]);
 const calls={listPeriods:0,listBaselines:0};
 const planning={
  findPeriod:async(_:string,id:string)=>periods.get(id)??null,
  listPeriods:async(_:string,projectId?:string)=>{calls.listPeriods++;return [...periods.values()].filter(p=>!projectId||p.projectId===projectId);},
  captureRecurrenceSnapshot:async()=>undefined,
  captureProject:async()=>({packages:[],tasks:[],memberships:[],activeMembershipIds:[member],fields:[],values:[]}),
  findMeetingByTask:async(_:string,taskId:string)=>meetings.get(taskId)??null,
  listMeetingLocks:async()=>[],listLocks:async()=>[],
  listBaselines:async()=>{calls.listBaselines++;return [];},
  fields:{findField:async()=>null},
  tasks:{permissionEpoch:async()=>'1',findProject:async(_:string,id:string)=>({id,archivedAt:null}),findStatus:async(_:string,id:string)=>({id,projectId:id===statusA?projectA:projectB,group:'todo'}),findSection:async()=>null,
   findTask:async(_:string,id:string)=>tasks.get(id)??null,listProjects:async()=>[{id:projectA},{id:projectB}],
   access:{findWorkspaceAccess:async(_:string,userId:string)=>{const r=roles.get(userId);return r?{workspace:{id:ws},membership:{id:member,workspaceId:ws,userId,displayName:'M',role:r.role,state:r.state,revision:1}}:null;}}},
 } as unknown as PlanningRepository;
 const receipts=new Map<string,{payloadHash:string;result:unknown}>();
 const repo:RecurrenceRepository={
  planning,findJobReceipt:async(_,key)=>receipts.get(key)??null,insertJobReceipt:async(_,actor,key,payloadHash,result)=>{receipts.set(key,{payloadHash,result});},
  listSeries:async(_,projectId)=>[...series.values()].filter(s=>s.projectId===projectId),findSeries:async(_,id)=>series.get(id)??null,saveSeries:async row=>{series.set(row.id,row);},
  listSeriesVersions:async(_,id)=>versions.filter(v=>v.seriesId===id),insertSeriesVersion:async row=>{versions.push(row);},
  findAuthorization:async(_,id)=>grants.get(id)??null,insertAuthorization:async row=>{grants.set(row.id,row);},
  listBindings:async(_,id)=>[...bindings.values()].filter(b=>b.seriesId===id),listBindingsForPeriod:async(_,id)=>[...bindings.values()].filter(b=>b.periodId===id),
  findBinding:async(_,id)=>bindings.get(id)??null,saveBinding:async row=>{bindings.set(row.id,row);},
  listInstanceHeaders:async(_,id)=>[...headers.values()].filter(h=>h.bindingId===id),
  findInstanceHeader:async(_,seriesId,key)=>[...headers.values()].find(h=>h.seriesId===seriesId&&h.occurrenceKey===key)??null,
  reserveInstanceHeaders:async rows=>{for(const r of rows)if(![...headers.values()].some(h=>h.seriesId===r.seriesId&&h.occurrenceKey===r.occurrenceKey))headers.set(r.id,r);},
  saveInstanceHeader:async row=>{headers.set(row.id,row);},
  attachInstanceLocator:async(_,id,expected,locator)=>{const h=headers.get(id);if(!h||h.revision!==expected||h.locator)throw new Error('attach conflict');headers.set(id,{...h,locator,revision:h.revision+1});},
  listExceptionVersions:async(_,id)=>exceptions.filter(e=>e.instanceId===id),insertExceptionVersion:async row=>{exceptions.push(row);},
  listCalendarLocks:async(_,id)=>locks.filter(l=>l.instanceId===id),insertCalendarLocks:async rows=>{locks.push(...rows);},
 };
 const created:string[]=[];
 const composer:RecurrenceOccurrenceComposer={async createOccurrenceInScope(scope,header,authority,input){
  expect(authority.seriesId).toBe(header.seriesId);expect(input.plannedPeriodId).toBe(header.periodId);
  const locator={meetingId:uuid(),taskId:uuid(),workPackageId:uuid()};await scope.recurrence.attachInstanceLocator(ws,header.id,header.revision,locator);
  meetings.set(locator.taskId,{id:locator.meetingId,revision:1,participantsRevision:1});created.push(header.occurrenceKey);
  return {header:{...header,locator,revision:header.revision+1},creation:{} as MeetingCreationDto};
 }};
 const events:{type?:string;payload?:Readonly<Record<string,unknown>>}[]=[];
 const scope={context:{workspaceId:ws,actor:{userId:user,displayName:'M',kind:'fixture'},source:'api',requestId:'t'},access:{membership:{id:member}},barrierAt:now,
  recordChange:async(e:{outbox?:{type:string;payload:Readonly<Record<string,unknown>>}})=>{events.push({...(e.outbox?{type:e.outbox.type,payload:e.outbox.payload}:{})});return {changeSeq:1n,eventOrdinal:events.length};},
  repository:planning,recurrence:repo,meetings:{},categoryResolver:{}} as unknown as {-readonly [K in keyof RecurrenceWriteScope]:RecurrenceWriteScope[K]};
 scope.recurrenceCensus=createRecurrenceScopedMaterializer(scope,tools,composer);
 function period(projectId:string,localStart:string,localEndExclusive:string,cutoffAt:string):PlanningPeriodDto{
  const p:PlanningPeriodDto={id:uuid(),workspaceId:ws,projectId,name:'Week',localStart,localEndExclusive,timezone:'UTC',cutoffAt,state:'planning',revision:1,protectedFieldIds:[],protectEstimate:false,projectBaselineId:null,createdAt:stamp,updatedAt:stamp};
  periods.set(p.id,p);return p;
 }
 function addSeries(projectId:string,p:PlanningPeriodDto,startDate:string,endDate:string,opts:{reserve?:boolean;authorized?:boolean}={}){
  const id=uuid(),versionId=uuid(),grantId=uuid(),bindingId=uuid();
  const schedule:RecurrenceScheduleInput={startDate,localTime:'09:00',timezone:'UTC',frequency:'daily',plannedDurationMinutes:30,end:{kind:'on_date',endDate}};
  versions.push({id:versionId,seriesId:id,revision:1,effectiveFromNominalDate:startDate,schedule,template:{title:'Standup',statusId:projectId===projectA?statusA:statusB,organizerMembershipId:member,attendeeMembershipIds:[member]},policyVersion:'first_valid_gap_earlier_overlap_v1',actorUserId:user,createdAt:stamp,changeSeq:'1'});
  const s:RecurrenceSeriesRecord={id,workspaceId:ws,projectId,revision:1,state:'active',currentVersionId:versionId,authorizationId:opts.authorized===false?null:grantId,authorizationRevision:opts.authorized===false?null:1,createdAt:stamp,updatedAt:stamp};
  series.set(id,s);
  if(opts.authorized!==false)grants.set(grantId,{id:grantId,workspaceId:ws,seriesId:id,revision:1,authorizerUserId:user,authorizerMembershipId:member,actorUserId:user,source:'api',recordedAt:stamp,changeSeq:'1'});
  const binding:RecurrencePeriodBindingRecord={id:bindingId,workspaceId:ws,projectId,seriesId:id,periodId:p.id,revision:1,sourceManifestHash:'0'.repeat(64),createdAt:stamp};
  bindings.set(bindingId,binding);
  if(opts.reserve)for(let i=0;day(startDate,i)<=endDate;i++){const key=day(startDate,i);const h:RecurrenceInstanceHeader={id:uuid(),workspaceId:ws,projectId,seriesId:id,bindingId,periodId:p.id,occurrenceKey:key,nominalSequence:null,sourceVersionId:versionId,revision:1,calendarState:'scheduled',resolution:resolution(key,'09:00','UTC',30),exceptionVersionId:null,locator:null,createdAt:stamp,updatedAt:stamp};headers.set(h.id,h);}
  return {series:s,binding};
 }
 return {repo,scope,periods,series,bindings,headers,exceptions,meetings,tasks,roles,calls,created,events,composer,period,addSeries};
}
const headersOf=(m:ReturnType<typeof memory>,bindingId:string)=>[...m.headers.values()].filter(h=>h.bindingId===bindingId);

describe('recurrence guard footprint and prerequisite modes',()=>{
 it('an unrelated blocked project A census never blocks a write to project B, but blocks an affected write to A',async()=>{
  const m=memory(),dueA=m.period(projectA,'2026-10-05','2026-10-12','2026-10-11T00:00:00.000Z');m.period(projectB,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z');
  m.addSeries(projectA,dueA,'2026-10-05','2026-10-09');m.roles.set(user,{role:'member',state:'revoked'});
  const taskA=uuid(),taskB=uuid();m.tasks.set(taskA,{id:taskA,projectId:projectA,workPackageId:uuid(),meetingId:null});m.tasks.set(taskB,{id:taskB,projectId:projectB,workPackageId:uuid(),meetingId:null});
  expect((await m.scope.recurrenceCensus.assessPeriod(dueA)).status).toBe('blocked');
  const guard=createPlanningMutationGuard(m.scope,tools);
  await expect(guard.check({family:'task',command:'task.update',target:taskB,input:{title:'B only'}})).resolves.toBeNull();
  expect(m.calls.listBaselines).toBe(0); // A was not frozen and not even attempted
  await expect(guard.check({family:'task',command:'task.update',target:taskA,input:{title:'A'}})).rejects.toMatchObject({code:'MATERIALIZATION_REQUIRED',details:{periodId:dueA.id,state:'blocked'}});
  expect(m.created).toEqual([]);
 });
 it('typed materialize_period recovery and generation reauthorization bypass every due-freeze loop',async()=>{
  const m=memory(),dueA=m.period(projectA,'2026-10-05','2026-10-12','2026-10-11T00:00:00.000Z');m.addSeries(projectA,dueA,'2026-10-05','2026-10-09');
  const guard=createPlanningMutationGuard(m.scope,tools);
  await expect(guard.check({family:'recurrence',command:'recurrence.period.materialize',target:{periodId:dueA.id},input:{limit:100}})).resolves.toBeNull();
  await expect(guard.check({family:'recurrence',command:'recurrence.generation.authorize',target:{seriesId:uuid()},input:{}})).resolves.toBeNull();
  expect(m.calls.listPeriods).toBe(0);expect(m.created).toEqual([]);
 });
 it('fails closed for a scope without the mandatory census',async()=>{
  const m=memory(),withoutCensus={...m.scope,recurrenceCensus:undefined} as unknown as RecurrenceWriteScope;
  await expect(createPlanningMutationGuard(withoutCensus,tools).check({family:'task',command:'project.create',target:null,input:{}})).rejects.toThrow('mandatory recurrence census');
 });
});

describe('calendar census snapshot',()=>{
 it('counts a never-materialized cancelled header as census, not missing, and locks it by instance identity',async()=>{
  const m=memory(),p=m.period(projectA,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z'),{binding}=m.addSeries(projectA,p,'2026-10-19','2026-10-20',{reserve:true});
  const [first,second]=headersOf(m,binding.id).sort((a,b)=>a.occurrenceKey.localeCompare(b.occurrenceKey));
  if(!first||!second)throw new Error('fixture');
  const taskId=uuid();m.meetings.set(taskId,{id:uuid(),revision:3,participantsRevision:2});
  m.headers.set(first.id,{...first,locator:{meetingId:m.meetings.get(taskId)?.id??'',taskId,workPackageId:uuid()},revision:2});
  m.headers.set(second.id,{...second,calendarState:'cancelled',revision:2});
  const assessment=await m.scope.recurrenceCensus.assessPeriod(p);
  expect(assessment).toMatchObject({status:'complete',missingCount:0});
  const section=await m.scope.recurrenceCensus.captureSnapshotSection(p,'project',null);
  expect(recurrenceSnapshotSectionSchema.parse(section)).toEqual(section);
  expect(section?.census.map(e=>[e.occurrenceKey,e.calendarState,e.meetingId===null,e.meetingRevision])).toEqual([['2026-10-19','scheduled',false,3],['2026-10-20','cancelled',true,null]]);
  expect(section?.bindings).toEqual([expect.objectContaining({bindingId:binding.id,seriesState:'active'})]);
  const locks=m.scope.recurrenceCensus.calendarLocksFor(required(section),uuid(),p.projectId);
  expect(locks.map(l=>[l.instanceId,l.meetingId===null,l.kind,l.projectId])).toEqual([[first.id,false,'recurrence_calendar',projectA],[second.id,true,'recurrence_calendar',projectA]]);
 });
 it('returns no section for a period without bindings so old snapshot JSON stays unchanged',async()=>{
  const m=memory(),p=m.period(projectA,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z');
  await expect(m.scope.recurrenceCensus.captureSnapshotSection(p,'project',null)).resolves.toBeUndefined();
 });
});

describe('source manifest hash',()=>{
 it('hashes generation inputs only: stable across materialization progress, sensitive to exceptions, grant and period bounds',async()=>{
  const m=memory(),p=m.period(projectA,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z'),{series,binding}=m.addSeries(projectA,p,'2026-10-19','2026-10-23',{reserve:true});
  const context=await loadSeriesContext(m.repo,ws,series),base=bindingSourceManifestHash(tools,context,binding,p);
  expect(base).toMatch(/^[0-9a-f]{64}$/);
  const progressed=context.headers.map((h,i)=>i<2?{...h,locator:{meetingId:uuid(),taskId:uuid(),workPackageId:uuid()},revision:h.revision+1,updatedAt:'2026-10-17T00:00:00.000Z'}:h);
  expect(bindingSourceManifestHash(tools,{...context,headers:progressed},binding,p)).toBe(base);
  expect(bindingSourceManifestHash(tools,context,binding,{...p,revision:p.revision+1,state:'frozen',updatedAt:'2026-10-26T00:00:00.000Z'})).toBe(base);
  const h=required(context.headers[0]),head:RecurrenceExceptionVersionRecord={id:uuid(),workspaceId:ws,instanceId:h.id,revision:1,kind:'skip',localDate:null,localTime:null,reason:'Holiday',actorUserId:user,source:'api',recordedAt:stamp,changeSeq:'2'};
  expect(bindingSourceManifestHash(tools,{...context,headers:context.headers.map(x=>x.id===h.id?{...x,exceptionVersionId:head.id}:x),heads:new Map([[h.id,head]])},binding,p)).not.toBe(base);
  expect(bindingSourceManifestHash(tools,{...context,series:{...series,authorizationRevision:2}},binding,p)).not.toBe(base);
  expect(bindingSourceManifestHash(tools,context,binding,{...p,localEndExclusive:'2026-10-27'})).not.toBe(base);
 });
});

describe('bounded chunks',()=>{
 it('creates at most 100 REAL compositions per chunk, reserves headers, and resumes with a signed stable cursor',async()=>{
  const m=memory(),p=m.period(projectA,'2026-01-01','2026-06-01','2026-05-31T00:00:00.000Z'),{binding}=m.addSeries(projectA,p,'2026-01-01','2026-05-30');
  const census=m.scope.recurrenceCensus;
  const first=await census.ensurePeriod(p,{maxCreates:100,reason:'explicit',cursor:null,bindingId:null});
  expect(first).toMatchObject({status:'pending',missingCount:150,createdCount:100,remainingCount:50});
  expect(headersOf(m,binding.id)).toHaveLength(150);expect(m.created).toHaveLength(100);
  expect(first.nextCursor).toMatchObject({periodId:p.id,actorUserId:user,afterOccurrenceKey:'2026-04-10'});
  const second=await census.ensurePeriod(p,{maxCreates:100,reason:'explicit',cursor:first.nextCursor,bindingId:null});
  expect(second).toMatchObject({status:'complete',createdCount:50,remainingCount:0,nextCursor:null});
  expect(new Set(m.created).size).toBe(150);
  expect((await census.assessPeriod(p)).status).toBe('complete');
 });
 it('rejects a cursor whose source manifest changed instead of continuing a stale enumeration',async()=>{
  const m=memory(),p=m.period(projectA,'2026-01-01','2026-06-01','2026-05-31T00:00:00.000Z'),{series}=m.addSeries(projectA,p,'2026-01-01','2026-05-30');
  const first=await m.scope.recurrenceCensus.ensurePeriod(p,{maxCreates:10,reason:'explicit',cursor:null,bindingId:null});
  m.series.set(series.id,{...series,authorizationRevision:2});
  await expect(m.scope.recurrenceCensus.ensurePeriod(p,{maxCreates:10,reason:'explicit',cursor:first.nextCursor,bindingId:null})).rejects.toMatchObject({code:'PREVIEW_STALE'});
 });
 it('progresses two overdue periods above the cap independently',async()=>{
  const m=memory(),p1=m.period(projectA,'2026-01-01','2026-06-01','2026-05-31T00:00:00.000Z'),p2=m.period(projectB,'2026-01-01','2026-06-01','2026-05-31T00:00:00.000Z');
  const a=m.addSeries(projectA,p1,'2026-01-01','2026-04-30'),b=m.addSeries(projectB,p2,'2026-01-01','2026-04-30');
  const one=await m.scope.recurrenceCensus.ensurePeriod(p1,{maxCreates:100,reason:'explicit',cursor:null,bindingId:null});
  expect(one).toMatchObject({createdCount:100,remainingCount:20});
  expect(headersOf(m,b.binding.id)).toHaveLength(0);
  const two=await m.scope.recurrenceCensus.ensurePeriod(p2,{maxCreates:100,reason:'explicit',cursor:null,bindingId:null});
  expect(two).toMatchObject({createdCount:100,remainingCount:20});
  expect(headersOf(m,a.binding.id).filter(h=>h.locator).length).toBe(100);
 });
 it('a freeze-time ensure never exceeds one chunk and reports a blocked grant instead of creating',async()=>{
  const m=memory(),p=m.period(projectA,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z');m.addSeries(projectA,p,'2026-10-19','2026-10-23',{authorized:false});
  const outcome=await m.scope.recurrenceCensus.ensurePeriod(p,{maxCreates:100,reason:'freeze',cursor:null,bindingId:null});
  expect(outcome).toMatchObject({status:'blocked',createdCount:0,remainingCount:5,nextCursor:null,bindings:[expect.objectContaining({blockedCode:'authorization_missing'})]});
  expect(m.created).toEqual([]);
 });
});

describe('worker facade',()=>{
 function worker(m:ReturnType<typeof memory>){
  return createRecurrenceWorkerFacade({tools,composer:m.composer,writer:{run:async(_job,work)=>work({...m.scope,context:{...m.scope.context,source:'job'},authorization:{kind:'valid',authority:{__workloomGenerationAuthority:'validated',seriesId:'',authorizationId:[...m.series.values()][0]?.authorizationId??'',authorizationRevision:1,authorizerUserId:user,authorizerMembershipId:member,validatedAt:now}}} as RecurrenceJobWriteScope)}});
 }
 async function currentHash(m:ReturnType<typeof memory>,binding:RecurrencePeriodBindingRecord){const s=required(m.series.get(binding.seriesId));return bindingSourceManifestHash(tools,await loadSeriesContext(m.repo,ws,s),binding,required(m.periods.get(binding.periodId)));}
 it('returns paused without writes and without retry pressure',async()=>{
  const m=memory(),p=m.period(projectA,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z'),{series,binding}=m.addSeries(projectA,p,'2026-10-19','2026-10-23');
  m.series.set(series.id,{...series,state:'paused'});
  const out=await worker(m).materializeBinding({workspaceId:ws,seriesId:series.id,bindingId:binding.id,sourceManifestHash:await currentHash(m,binding),authorizationRevision:1,requestId:'r1'});
  expect(out).toMatchObject({status:'paused',createdCount:0});expect(m.events).toEqual([]);expect(m.created).toEqual([]);
 });
 it('a stale job durably requests the current inputs and creates nothing',async()=>{
  const m=memory(),p=m.period(projectA,'2026-10-19','2026-10-26','2026-10-25T00:00:00.000Z'),{series,binding}=m.addSeries(projectA,p,'2026-10-19','2026-10-23');
  const out=await worker(m).materializeBinding({workspaceId:ws,seriesId:series.id,bindingId:binding.id,sourceManifestHash:'f'.repeat(64),authorizationRevision:1,requestId:'r2'});
  expect(out).toMatchObject({status:'stale',remainingCount:5});expect(m.created).toEqual([]);
  expect(m.events).toEqual([{type:'recurrence.materialization_requested',payload:{seriesId:series.id,bindingId:binding.id,sourceManifestHash:await currentHash(m,binding),authorizationRevision:1}}]);
 });
 it('a pending chunk writes exactly one continuation with the same stable hash',async()=>{
  const m=memory(),p=m.period(projectA,'2026-01-01','2026-06-01','2026-05-31T00:00:00.000Z'),{series,binding}=m.addSeries(projectA,p,'2026-01-01','2026-05-30');
  const hash=await currentHash(m,binding);
  const out=await worker(m).materializeBinding({workspaceId:ws,seriesId:series.id,bindingId:binding.id,sourceManifestHash:hash,authorizationRevision:1,requestId:'r3'});
  expect(out).toMatchObject({status:'pending',createdCount:100,remainingCount:50});
  expect(m.events.filter(e=>e.type==='recurrence.materialization_requested')).toEqual([{type:'recurrence.materialization_requested',payload:{seriesId:series.id,bindingId:binding.id,sourceManifestHash:hash,authorizationRevision:1}}]);
  expect(await currentHash(m,binding)).toBe(hash);
 });
});
