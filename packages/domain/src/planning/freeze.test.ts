import type { PeriodCommitmentDto, PlanBaselineDto, PlanningPeriodDto, PlanningSnapshotDto, TaskDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../access/context.js';
import { captureFreezeSnapshot, createPlanningMutationGuard, freezePreviewHash, unwrapPlanningOutcome } from './freeze.js';
import type { PlanningRepository, PlanningTools, PlanningWriteScope, ProjectPlanningSources } from './ports.js';

const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ws=id(1),project=id(2),periodId=id(3),pkg=id(4),taskId=id(5),fieldId=id(6),a=id(7),b=id(8),time='2026-10-16T00:00:00.000Z';
const period:PlanningPeriodDto={id:periodId,workspaceId:ws,projectId:project,name:'Week',localStart:'2026-10-12',localEndExclusive:'2026-10-19',timezone:'Asia/Nicosia',cutoffAt:'2026-10-18T00:00:00.000Z',state:'planning',revision:1,protectedFieldIds:[fieldId],protectEstimate:false,projectBaselineId:null,createdAt:time,updatedAt:time};
const task:TaskDto={id:taskId,workspaceId:ws,projectId:project,sectionId:null,parentTaskId:null,workPackageId:pkg,workPackageRevision:1,title:'First title',description:'',statusId:id(9),responsibleMembershipId:a,participants:[],participantsRevision:1,dueDate:null,priority:'none',tags:[],estimateMinutes:null,revision:1,position:0,visibility:'workspace',archivedAt:null,createdAt:time,updatedAt:time};
const field:TaskFieldDefinitionDto={id:fieldId,workspaceId:ws,projectId:project,name:'First label',type:'text',revision:1,definitionVersionId:id(10),historyEnabled:true,locked:false,archivedAt:null,options:[],createdAt:time,updatedAt:time};
const commitment=(member:string,n:number):PeriodCommitmentDto=>({id:id(n),workspaceId:ws,projectId:project,periodId,workPackageId:pkg,membershipId:member,plannedMinutes:60,allocations:[],unallocatedMinutes:60,state:'active',revision:1,classification:'planned',baselineIds:[],createdAt:time,updatedAt:time});
const first=commitment(a,11),second=commitment(b,12);
const members=[{id:a,workspaceId:ws,userId:id(20),displayName:'Alice first',role:'member' as const},{id:b,workspaceId:ws,userId:id(21),displayName:'Bob first',role:'member' as const}];
const sources:ProjectPlanningSources={packages:[{id:pkg,projectId:project,revision:1,estimateMinutes:null,createdAt:time,packageBaselineId:null,title:'First package'}],tasks:[task],memberships:members,activeMembershipIds:[a,b],fields:[field],values:[]};
const snapshot=(who:string,c:PeriodCommitmentDto,title:string,label:string):PlanningSnapshotDto=>({schemaVersion:1,period,commitments:[c],packages:[{id:pkg,projectId:project,revision:1,estimateMinutes:null,createdAt:time,packageBaselineId:null,title}],projectPackageIds:[pkg],tasks:[{...task,title}],memberships:members.map(m=>m.id===who?{...m,displayName:`${who===a?'Alice':'Bob'} at own freeze`}:m),fieldDefinitions:[{...field,name:label}],fieldValues:[{taskId,fieldId,value:null}],sourcePersonalBaselineIds:[]});
const baseline=(member:string,c:PeriodCommitmentDto,n:number,seq:string,title:string,label:string):PlanBaselineDto=>({id:id(n),workspaceId:ws,projectId:project,periodId,scope:'self',membershipId:member,mode:'manual',requestedCutoffAt:period.cutoffAt,frozenAt:time,actorUserId:id(20),source:'api',changeSeq:seq,snapshot:snapshot(member,c,title,label)});
const ctx:CommandContext={workspaceId:ws,actor:{userId:id(20),displayName:'Alice',kind:'fixture'},source:'api',requestId:'test'};
const tools:PlanningTools={newId:()=>id(99),digest:value=>value,encodeCursor:()=>'',decodeCursor:()=>{throw new Error('unused');}};

// These doubles exercise pure source-selection/guard decisions; real PG tests own atomicity/races.
function repository(overrides:Partial<PlanningRepository>={}):PlanningRepository {
  return {listMeetings:async()=>[],listAttendance:async()=>[],listMeetingLocks:async()=>[],findMeetingByTask:async()=>null,captureProject:async()=>clone(sources),listCommitments:async()=>[first,second],listBaselines:async()=>[],listPeriods:async()=>[],listLocks:async()=>[],tasks:{permissionEpoch:async()=>'0',findTask:async()=>task},...overrides} as unknown as PlanningRepository;
}

describe('planning immutable source selection',()=>{
  it('uses earliest numeric personal change sequence rather than random UUID order or latest labels',async()=>{
    const early=baseline(a,first,90,'9','Earliest title','Earliest label');
    const later=baseline(b,second,80,'10','Later title','Later label');
    const repo=repository({listBaselines:async()=>[later,early],captureProject:async()=>({...clone(sources),tasks:[{...task,title:'Current title'}],fields:[{...field,name:'Current label'}]})});
    const result=await captureFreezeSnapshot(repo,period,'project',null);
    expect(result.tasks[0]?.title).toBe('Earliest title');
    expect(result.packages[0]?.title).toBe('Earliest title');
    expect(result.fieldDefinitions[0]?.name).toBe('Earliest label');
    expect(result.sourcePersonalBaselineIds).toEqual([later.id,early.id].sort());
    expect(result.commitments.map(c=>c.id).sort()).toEqual([first.id,second.id].sort());
    expect(result.memberships.find(m=>m.id===a)?.displayName).toBe('Alice at own freeze');
    expect(result.memberships.find(m=>m.id===b)?.displayName).toBe('Bob at own freeze');
  });

  it('binds preview to membership activity, current permission epoch and actor even when public labels do not change',async()=>{
    let active=[a,b],epoch='0';
    const repo=repository({captureProject:async()=>({...clone(sources),activeMembershipIds:active}),tasks:{permissionEpoch:async()=>epoch} as unknown as PlanningRepository['tasks']});
    const snap=snapshot(a,first,'Same title','Same label');
    const hash=()=>freezePreviewHash(tools,repo,ctx,periodId,'project',null,snap);
    const original=await hash();
    active=[a];expect(await hash()).not.toBe(original);
    active=[a,b];epoch='1';expect(await hash()).not.toBe(original);
    epoch='0';expect(await freezePreviewHash(tools,repo,{...ctx,actor:{...ctx.actor,userId:id(21)}},periodId,'project',null,snap)).not.toBe(original);
    active=[b,a];expect(await hash()).toBe(original);
  });

  it('does not fold post-personal-freeze added commitments into the original project cohort',async()=>{
    const early=baseline(a,first,90,'9','Title','Label');
    const added={...commitment(a,40),workPackageId:id(41),classification:'added' as const};
    const result=await captureFreezeSnapshot(repository({listBaselines:async()=>[early],listCommitments:async()=>[first,second,added]}),period,'project',null);
    expect(result.commitments.map(c=>c.id)).toEqual([first.id,second.id]);
  });
});

describe('planning identity guards and committed outcome',()=>{
  it('protects a selected field identity even when the value row is absent',async()=>{
    const baselineId=id(50),repo=repository({listLocks:async()=>[{id:id(51),workspaceId:ws,projectId:project,baselineId,kind:'custom_value',taskId,fieldId,commitmentId:null,workPackageId:null}]});
    const scope={context:ctx,repository:repo,barrierAt:new Date(time)} as PlanningWriteScope;
    const outcome=await createPlanningMutationGuard(scope,tools).check({family:'field',command:'field.value.set',target:{taskId,fieldId},input:{expectedRevision:0,value:{type:'text',value:null}}});
    expect(outcome?.details).toEqual({committed:true,baselineIds:[baselineId]});
    expect(()=>unwrapPlanningOutcome(outcome)).toThrow(expect.objectContaining({code:'FIELD_LOCKED',details:{committed:true,baselineIds:[baselineId]}}));
  });

  it('protects an unknown whole-package estimate through any shared child identity',async()=>{
    const baselineId=id(60),repo=repository({listLocks:async()=>[{id:id(61),workspaceId:ws,projectId:project,baselineId,kind:'estimate',taskId:null,fieldId:null,commitmentId:null,workPackageId:pkg}]});
    const scope={context:ctx,repository:repo,barrierAt:new Date(time)} as PlanningWriteScope;
    const result=await createPlanningMutationGuard(scope,tools).check({family:'task',command:'task.update',target:taskId,input:{estimateMinutes:0}});
    expect(result?.details.baselineIds).toEqual([baselineId]);
  });
});
