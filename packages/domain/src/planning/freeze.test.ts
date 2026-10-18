import type { TaskFieldPolicyDto, TaskFieldValueDto, CreateTaskRowInput, PeriodCommitmentDto, PlanBaselineDto, PlanningPeriodDto, PlanningSnapshotDto, TaskDto, TaskFieldDefinitionDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../access/context.js';
import { captureFreezeSnapshot, createPlanningMutationGuard, freezePreviewHash, unwrapPlanningOutcome } from './freeze.js';
import type { PlanningMutationIntent, PlanningRepository, PlanningTools, PlanningWriteScope, ProjectPlanningSources } from './ports.js';

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
// Explicit policy fake for the mandatory census: a workspace without recurrence bindings.
const recurrenceCensus:PlanningWriteScope['recurrenceCensus']={resolveAffectedProjects:async()=>({kind:'none'}),assessPeriod:async p=>({periodId:p.id,status:'complete',missingCount:0,bindings:[]}),ensurePeriod:async p=>({periodId:p.id,status:'complete',missingCount:0,bindings:[],createdCount:0,remainingCount:0,nextCursor:null}),requireCompleteCensus:async()=>{},captureSnapshotSection:async()=>undefined,calendarLocksFor:()=>[],insertCalendarLocks:async()=>{}};

// These doubles exercise pure source-selection/guard decisions; real PG tests own atomicity/races.
function repository(overrides:Partial<PlanningRepository>={}):PlanningRepository {
  return {captureRecurrenceSnapshot:async()=>undefined,listMeetings:async()=>[],listAttendance:async()=>[],listMeetingLocks:async()=>[],findMeetingByTask:async()=>null,captureProject:async()=>clone(sources),listCommitments:async()=>[first,second],listBaselines:async()=>[],listPeriods:async()=>[],listLocks:async()=>[],tasks:{permissionEpoch:async()=>'0',findTask:async()=>task},...overrides} as unknown as PlanningRepository;
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
    const scope={context:ctx,repository:repo,barrierAt:new Date(time),recurrenceCensus} as PlanningWriteScope;
    const outcome=await createPlanningMutationGuard(scope,tools).check({family:'field',command:'field.value.set',target:{taskId,fieldId},input:{expectedRevision:0,value:{type:'text',value:null}}});
    expect(outcome?.details).toEqual({committed:true,baselineIds:[baselineId]});
    expect(()=>unwrapPlanningOutcome(outcome)).toThrow(expect.objectContaining({code:'FIELD_LOCKED',details:{committed:true,baselineIds:[baselineId]}}));
  });

  it('protects an unknown whole-package estimate through any shared child identity',async()=>{
    const baselineId=id(60),repo=repository({listLocks:async()=>[{id:id(61),workspaceId:ws,projectId:project,baselineId,kind:'estimate',taskId:null,fieldId:null,commitmentId:null,workPackageId:pkg}]});
    const scope={context:ctx,repository:repo,barrierAt:new Date(time),recurrenceCensus} as PlanningWriteScope;
    const result=await createPlanningMutationGuard(scope,tools).check({family:'task',command:'task.update',target:taskId,input:{estimateMinutes:0}});
    expect(result?.details.baselineIds).toEqual([baselineId]);
  });
});

describe('atomic task row aggregate guard',()=>{
  const lockedFieldId=id(70),otherProject=id(72);
  const lockedField:TaskFieldDefinitionDto={...field,id:lockedFieldId,locked:true};
  const overdue:PlanningPeriodDto={...period,id:id(71),cutoffAt:'2026-10-15T00:00:00.000Z',protectedFieldIds:[lockedFieldId]};
  // A fresh project: no packages, tasks or members, so the cutoff freeze has no personal freezes to fan out.
  const empty:ProjectPlanningSources={packages:[],tasks:[],memberships:[],activeMembershipIds:[],fields:[lockedField],values:[]};
  const rowInput=(fields?:CreateTaskRowInput['fields'],task:Partial<CreateTaskRowInput['task']>={}):CreateTaskRowInput=>({task:{projectId:project,title:'New row',statusId:id(9),...task},...(fields?{fields}:{})});
  const rowIntent=(input:CreateTaskRowInput):PlanningMutationIntent=>({family:'task_row',command:'task.row.create',target:{projectId:input.task.projectId},input});
  const selected=(fid:string)=>({fieldId:fid,expectedDefinitionRevision:1,value:{type:'text' as const,value:'Draft'}});

  function rowGuard(periods:PlanningPeriodDto[],definitions:TaskFieldDefinitionDto[],parent?:TaskDto,policy?:TaskFieldPolicyDto) {
    const writes:string[]=[],baselines:PlanBaselineDto[]=[];
    let stored=[...periods],next=200;
    const repo=repository({
      captureProject:async()=>clone(empty),listCommitments:async()=>[],
      listPeriods:async()=>stored,findPeriod:async(_ws,pid)=>stored.find(p=>p.id===pid)??null,
      listBaselines:async(_ws,pid)=>baselines.filter(b=>b.periodId===pid),
      insertBaseline:async row=>{writes.push(`baseline:${row.id}`);baselines.push(row);},
      insertLocks:async rows=>{writes.push(`locks:${rows.length}`);},
      savePeriod:async row=>{writes.push(`period:${row.state}`);stored=stored.map(p=>p.id===row.id?row:p);},
      saveCommitment:async()=>{writes.push('commitment');},saveManualWork:async()=>{writes.push('work');},
      // Read-only doubles: any task core or field value write would fail as a missing method.
      tasks:{permissionEpoch:async()=>'0',findTask:async(_ws:string,tid:string)=>parent?.id===tid?parent:null} as unknown as PlanningRepository['tasks'],
      fields:{policies:{find:async()=>policy??null,count:async()=>0},findField:async(_ws:string,fid:string)=>definitions.find(f=>f.id===fid)??null} as unknown as PlanningRepository['fields'],
    });
    const recordChange=(async(change:{entityType:string;action:string})=>{writes.push(`${change.entityType}:${change.action}`);return {changeSeq:7n};}) as unknown as PlanningWriteScope['recordChange'];
    const scope={context:ctx,repository:repo,barrierAt:new Date(time),recurrenceCensus,recordChange} as PlanningWriteScope;
    return {guard:createPlanningMutationGuard(scope,{...tools,newId:()=>id(next++)}),writes,baselines,periods:()=>stored};
  }

  it('first commits the overdue cutoff freeze, then rejects a manually locked selected field with that baseline',async()=>{
    const {guard,writes,baselines,periods}=rowGuard([overdue],[lockedField]);
    const outcome=await guard.check(rowIntent(rowInput([selected(lockedFieldId)])));
    const baselineId=baselines[0]?.id;
    expect(baselineId).toBeDefined();
    expect(outcome).toEqual({__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[baselineId]}});
    expect(()=>unwrapPlanningOutcome(outcome)).toThrow(expect.objectContaining({code:'FIELD_LOCKED',details:{committed:true,baselineIds:[baselineId]}}));
    expect(writes).toEqual(['plan_baseline:frozen',`baseline:${baselineId}`,'locks:0','period:frozen']);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatchObject({periodId:overdue.id,scope:'project',membershipId:null,mode:'cutoff'});
    expect(baselines[0]?.snapshot.fieldDefinitions.map(f=>f.id)).toEqual([lockedFieldId]);
    expect(periods()[0]).toMatchObject({id:overdue.id,state:'frozen',projectBaselineId:baselineId,revision:overdue.revision+1});
  });

  it('commits due freezes before rejecting a deadline or zero-budget initial value, with no proposal writes',async()=>{
    for(const rule of [{lockAt:time,maxChangesPerActor:null},{lockAt:null,maxChangesPerActor:0}]) {
      const policy:TaskFieldPolicyDto={workspaceId:ws,projectId:project,fieldId,revision:1,...rule,activatedAt:time,updatedAt:time,updatedByUserId:ctx.actor.userId};
      const {guard,writes,baselines}=rowGuard([overdue],[field],undefined,policy);
      const result=await guard.check(rowIntent(rowInput([selected(fieldId)])));
      expect(result).toMatchObject({code:'FIELD_LOCKED',details:{committed:true,baselineIds:[baselines[0]?.id],policyReason:rule.lockAt?'deadline':'change_limit'}});
      expect(writes).toEqual(['plan_baseline:frozen',`baseline:${baselines[0]?.id}`,'locks:0','period:frozen']);
      expect(()=>unwrapPlanningOutcome(result)).toThrow(expect.objectContaining({code:'FIELD_LOCKED'}));
    }
  });

  it('rejects a locked field as committed with empty baseline IDs when nothing is overdue',async()=>{
    const {guard,writes}=rowGuard([period],[lockedField]);
    expect(await guard.check(rowIntent(rowInput([selected(lockedFieldId)])))).toEqual({__workloomPlanningOutcome:'rejected',code:'FIELD_LOCKED',details:{committed:true,baselineIds:[]}});
    expect(writes).toEqual([]);
  });

  it('passes unlocked, absent and cross-project definitions to the service preflight',async()=>{
    const foreign={...lockedField,id:id(74),projectId:otherProject};
    const {guard,writes}=rowGuard([period],[{...field,locked:false},foreign]);
    expect(await guard.check(rowIntent(rowInput([selected(fieldId)])))).toBeNull();
    expect(await guard.check(rowIntent(rowInput([selected(foreign.id),selected(id(76))])))).toBeNull();
    expect(await guard.check(rowIntent(rowInput()))).toBeNull();
    expect(writes).toEqual([]);
  });

  it('keeps a generic row out of a meeting package as task.create does',async()=>{
    const meetingTask:TaskDto={...task,id:id(73),meetingId:id(75)};
    const {guard,writes}=rowGuard([period],[],meetingTask);
    await expect(guard.check(rowIntent(rowInput(undefined,{parentTaskId:meetingTask.id})))).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
    expect(await guard.check(rowIntent(rowInput(undefined,{parentTaskId:meetingTask.id,workScope:'added_scope'})))).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('assignee move and atomic bulk meeting policy', () => {
  const meetingTask = { ...task, meetingId: id(901) };
  const scope = (locked: boolean) => ({ context: ctx, repository: repository({ tasks: { findTask: async () => meetingTask } as unknown as PlanningRepository['tasks'], listMeetingLocks: async () => locked ? [{ baselineId: id(902) }] as Awaited<ReturnType<PlanningRepository['listMeetingLocks']>> : [] }), barrierAt: new Date(time), recurrenceCensus }) as PlanningWriteScope;
  it('permits same-current-assignee meeting reordering and unchanged legacy moves', async () => {
    const guard = createPlanningMutationGuard(scope(true), tools);
    expect(await guard.check({ family: 'task', command: 'task.move', target: taskId, input: { responsibleMembershipId: a } })).toBeNull();
    expect(await guard.check({ family: 'task', command: 'task.move', target: taskId, input: {} })).toBeNull();
  });
  it('does not bypass meeting roster locks through a move or bulk patch', async () => {
    const guard = createPlanningMutationGuard(scope(true), tools);
    expect((await guard.check({ family: 'task', command: 'task.move', target: taskId, input: { responsibleMembershipId: b } }))?.details).toEqual({ committed: true, baselineIds: [id(902)] });
    expect((await guard.check({ family: 'task_bulk', command: 'task.bulk.update', target: { projectId: project }, input: { projectId: project, tasks: [{ taskId, expectedRevision: 1 }], changes: { dueDate: null } } }))?.code).toBe('FIELD_LOCKED');
    await expect(createPlanningMutationGuard(scope(false), tools).check({ family: 'task', command: 'task.move', target: taskId, input: { responsibleMembershipId: b } })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
  });
});

function bulkGuardFields(findField: PlanningRepository['fields']['findField']): PlanningRepository['fields'] {
  const unused = async (): Promise<never> => { throw new Error('Unexpected field repository call in planning guard fixture.'); };
  return { policies:{find:async()=>null,save:unused,count:async()=>0,insertUsage:unused}, tasks: repository().tasks, findField, listFields: unused, insertField: unused, saveField: unused,
    insertDefinitionVersion: unused, findOption: unused, insertOption: unused, saveOption: unused,
    findProjectColumns: unused, saveProjectColumns: unused, findValue: unused, listTaskValues: unused,
    listProjectValues: unused, saveValue: unused, insertValueHistory: unused, listValueHistory: unused };
}

describe('bulk selected-cell estimate and custom locks', () => {
  const input = { projectId: project, tasks: [{ taskId, expectedRevision: 1, expectedWorkPackageRevision: 1 }], changes: { estimateMinutes: 30 } };
  const scope = (repo: PlanningRepository) => ({ context: ctx, repository: repo, barrierAt: new Date(time), recurrenceCensus }) as PlanningWriteScope;
  it('rejects a bulk shared estimate through the same package lock as an ordinary estimate', async () => {
    const repo = repository({ listLocks: async () => [{ kind: 'estimate', workPackageId: pkg, baselineId: id(920) }] as Awaited<ReturnType<PlanningRepository['listLocks']>> });
    const result = await createPlanningMutationGuard(scope(repo), tools).check({ family: 'task_bulk', command: 'task.bulk.update', target: { projectId: project }, input });
    expect(result).toMatchObject({ code: 'FIELD_LOCKED', details: { committed: true, baselineIds: [id(920)] } });
  });
  it('rejects a selected custom value including a frozen absent value', async () => {
    const repo = repository({ fields: bulkGuardFields(async () => field), listLocks: async () => [{ kind: 'custom_value', taskId, fieldId, baselineId: id(921) }] as Awaited<ReturnType<PlanningRepository['listLocks']>> });
    const result = await createPlanningMutationGuard(scope(repo), tools).check({ family: 'task_bulk', command: 'task.bulk.update', target: { projectId: project }, input: {
      projectId: project, tasks: [{ taskId, expectedRevision: 1, expectedFieldValueRevision: 0 }],
      changes: { customField: { fieldId, expectedDefinitionRevision: 1, value: { type: 'text', value: null } } },
    } });
    expect(result).toMatchObject({ code: 'FIELD_LOCKED', details: { committed: true, baselineIds: [id(921)] } });
  });
  it('keeps a manual definition lock a committed controlled rejection', async () => {
    const repo = repository({ fields: bulkGuardFields(async () => ({ ...field, locked: true })) });
    const result = await createPlanningMutationGuard(scope(repo), tools).check({ family: 'task_bulk', command: 'task.bulk.update', target: { projectId: project }, input: {
      projectId: project, tasks: [{ taskId, expectedRevision: 1, expectedFieldValueRevision: 0 }],
      changes: { customField: { fieldId, expectedDefinitionRevision: 1, value: { type: 'text', value: '' } } },
    } });
    expect(result).toMatchObject({ code: 'FIELD_LOCKED', details: { committed: true, baselineIds: [] } });
  });
});


describe('shared policy pre-handler classification',()=>{
  const policy:TaskFieldPolicyDto={workspaceId:ws,projectId:project,fieldId,revision:1,lockAt:time,maxChangesPerActor:null,activatedAt:time,updatedAt:time,updatedByUserId:ctx.actor.userId};
  const current:TaskFieldValueDto={workspaceId:ws,projectId:project,taskId,fieldId,revision:1,value:{type:'text',value:'same'},definitionVersionId:field.definitionVersionId,updatedAt:time};
  function guarded() {
    const fields={...bulkGuardFields(async()=>field),policies:{find:async()=>policy,count:async()=>0,save:async()=>{throw new Error('guard must not write policy');},insertUsage:async()=>{throw new Error('preflight must not consume');}},findValue:async()=>current};
    fields.tasks={...fields.tasks,findTask:async()=>task,findProject:async()=>({id:project,workspaceId:ws,name:'Policy project',revision:1,archivedAt:null,createdAt:time,updatedAt:time})} as PlanningRepository['tasks'];
    const repo=repository({fields,tasks:fields.tasks});
    return createPlanningMutationGuard({context:ctx,repository:repo,barrierAt:new Date(time),recurrenceCensus} as PlanningWriteScope,tools);
  }
  it('classifies a changed ordinary value, leaves equality free, and retains stale-revision errors',async()=>{
    const guard=guarded();
    const intent={family:'field' as const,command:'field.value.set' as const,target:{taskId,fieldId},input:{expectedRevision:1,expectedDefinitionRevision:1,value:{type:'text',value:'changed'}}};
    expect(await guard.check(intent)).toMatchObject({code:'FIELD_LOCKED',details:{committed:true,policyReason:'deadline'}});
    expect(await guard.check({...intent,input:{...intent.input,value:{type:'text',value:'same'}}})).toBeNull();
    await expect(guard.check({...intent,input:{...intent.input,expectedRevision:0}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  });
  it('classifies all selected bulk values and import initial values before any handler',async()=>{
    const guard=guarded();
    expect(await guard.check({family:'task_bulk',command:'task.bulk.update',target:{projectId:project},input:{projectId:project,tasks:[{taskId,expectedRevision:1,expectedFieldValueRevision:1}],changes:{customField:{fieldId,expectedDefinitionRevision:1,value:{type:'text',value:'changed'}}}}})).toMatchObject({details:{policyReason:'deadline',committed:true}});
    expect(await guard.check({family:'import',command:'import.project.apply',target:{projectId:project},input:{},previewMatches:async()=>true,fieldPolicyCandidates:[{fieldId,value:{type:'text',value:'new'}}]})).toMatchObject({details:{policyReason:'deadline',committed:true}});
  });
  it('never allows an owner-exception command to rewrite an immutable planning baseline',async()=>{
    const repo=repository({listLocks:async()=>[{kind:'custom_value',taskId,fieldId,baselineId:id(950)}] as Awaited<ReturnType<PlanningRepository['listLocks']>>});
    const guard=createPlanningMutationGuard({context:ctx,repository:repo,barrierAt:new Date(time),recurrenceCensus} as PlanningWriteScope,tools);
    expect(await guard.check({family:'field',command:'field.value.exception',target:{taskId,fieldId},input:{reason:'Owner correction'}})).toMatchObject({code:'FIELD_LOCKED',details:{baselineIds:[id(950)]}});
  });
});
