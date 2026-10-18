// Source-only authored for the root-owned disposable PostgreSQL gate; never run against the main database.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createDatabase,createTaskApplication,createTaskFieldApplication,createPlanningApplication,runMigrations,seedDemoData,FIXTURE_USER_IDS as U,FIXTURE_MEMBERSHIP_IDS as M,FIXTURE_WORKSPACE_IDS as W,type Database} from '@workloom/db';
import {createTaskRowApplication} from '../../packages/db/src/task-rows/task-row-application.js';
import {isDomainError,type CommandContext,type TaskApplication,type TaskFieldApplication,type PlanningApplication} from '@workloom/domain';
import {databaseSnapshot} from './support/p1b.js';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
requireTestDatabaseUrl();
const ctx=(userId:string=U.owner,key:string=randomUUID()):CommandContext=>({workspaceId:W.team,actor:{userId,displayName:'Synthetic field rules',kind:'fixture'},source:'web',requestId:randomUUID(),idempotencyKey:key});
function required<T>(value:T|null|undefined):T {if(value===null||value===undefined)throw new Error('Field rules fixture required');return value;}
async function rejection(operation:Promise<unknown>) {try{await operation;}catch(error){if(isDomainError(error))return error;throw error;}throw new Error('Expected policy rejection');}

describe('field deadlines, actor budgets and audited one-shot exceptions on owned PostgreSQL',()=>{
  let target:ThrowawayDatabase|undefined,db:Database,tasks:TaskApplication,fields:TaskFieldApplication,planning:PlanningApplication;
  beforeAll(async()=>{
    target=await createThrowawayDatabase('field_rules');db=createDatabase(target.url,{requireLoopback:true});
    await runMigrations(target.url,{requireLoopback:true});await seedDemoData(db);
    tasks=createTaskApplication(db);fields=createTaskFieldApplication(db);planning=createPlanningApplication(db);
  },60_000);
  afterAll(async()=>{await db?.close();await target?.drop();},30_000);
  async function fixture(label:string) {
    const project=await tasks.createProject(ctx(),{name:`${label} ${randomUUID().slice(0,8)}`});
    const status=required((await tasks.listStatuses(ctx(),project.id)).find(s=>s.group==='todo'));
    const task=await tasks.createTask(ctx(),{projectId:project.id,statusId:status.id,title:label,estimateMinutes:60});
    const field=await fields.createField(ctx(),{projectId:project.id,name:'Notes',type:'text',historyEnabled:false,locked:false,options:[]});
    return {project,status,task,field};
  }
  it('serializes the last actor slot, counts first entry with history off, and replays without another usage',async()=>{
    const f=await fixture('Concurrent quota');
    await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:1});
    const calls=['first','second'].map(value=>({context:ctx(U.memberA),input:{expectedRevision:0,expectedDefinitionRevision:f.field.revision,value:{type:'text' as const,value}}}));
    const results=await Promise.allSettled(calls.map(c=>fields.setTaskValue(c.context,f.task.id,f.field.id,c.input)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const winner=required(results.findIndex(r=>r.status==='fulfilled')>=0?calls[results.findIndex(r=>r.status==='fulfilled')]:undefined);
    const state=await fields.getPolicyState(ctx(U.memberA),f.task.id,f.field.id);expect(state.currentActorChangesUsed).toBe(1);
    const before=await databaseSnapshot(db.sql);
    await fields.setTaskValue(winner.context,f.task.id,f.field.id,winner.input);
    expect(await databaseSnapshot(db.sql)).toEqual(before);
    const current=required((await fields.listTaskValues(ctx(),f.task.id))[0]);
    expect((await rejection(fields.setTaskValue(ctx(U.memberA),f.task.id,f.field.id,{...winner.input,expectedRevision:current.revision,value:{type:'text',value:'third'}}))).code).toBe('FIELD_LOCKED');
    expect((await fields.listValueHistory(ctx(),f.task.id,f.field.id,{limit:100})).items).toEqual([]);
    expect((await fields.getPolicyState(ctx(U.memberA),f.task.id,f.field.id)).currentActorChangesUsed).toBe(1);
  });
  it('rolls the complete value command back when a late usage append fails, then permits its exact retry once',async()=>{
    const f=await fixture('Atomic usage');await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:1});
    const context=ctx(),input={expectedRevision:0,expectedDefinitionRevision:1,value:{type:'text' as const,value:'private'}};
    await db.sql.unsafe("create function qa_field_usage_fault() returns trigger language plpgsql as $$ begin raise exception 'qa_field_usage_fault'; end $$");
    await db.sql.unsafe('create trigger qa_field_usage_fault before insert on task_field_policy_usage for each row execute function qa_field_usage_fault()');
    const before=await databaseSnapshot(db.sql);
    try {await expect(fields.setTaskValue(context,f.task.id,f.field.id,input)).rejects.toThrow();expect(await databaseSnapshot(db.sql)).toEqual(before);}
    finally {await db.sql.unsafe('drop trigger qa_field_usage_fault on task_field_policy_usage');await db.sql.unsafe('drop function qa_field_usage_fault()');}
    await fields.setTaskValue(context,f.task.id,f.field.id,input);
    expect((await fields.getPolicyState(ctx(),f.task.id,f.field.id)).currentActorChangesUsed).toBe(1);
  });
  it('blocks quick and bulk composers, and makes an explicit owner correction with safe metadata even when history is off',async()=>{
    const f=await fixture('Owner exception'),policy=await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:new Date(Date.now()-60_000).toISOString(),maxChangesPerActor:0});
    const row=createTaskRowApplication(db);
    expect((await rejection(row.createRow(ctx(),{task:{projectId:f.project.id,statusId:f.status.id,title:'Must not exist'},fields:[{fieldId:f.field.id,expectedDefinitionRevision:1,value:{type:'text',value:'new'}}]}))).details).toMatchObject({committed:true,policyReason:'deadline'});
    expect((await rejection(tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,tasks:[{taskId:f.task.id,expectedRevision:f.task.revision,expectedFieldValueRevision:0}],changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:1,value:{type:'text',value:'bulk'}}}}))).details).toMatchObject({committed:true,policyReason:'deadline'});
    expect((await fields.listTaskValues(ctx(),f.task.id))).toEqual([]);
    const key=randomUUID(),input={expectedRevision:0,expectedDefinitionRevision:1,expectedPolicyRevision:policy.revision,value:{type:'text' as const,value:'private correction'},reason:'Correct accidental source entry'};
    const value=await fields.setTaskValueException(ctx(U.owner,key),f.task.id,f.field.id,input);
    expect(value.revision).toBe(1);expect((await fields.getPolicyState(ctx(),f.task.id,f.field.id)).currentActorChangesUsed).toBe(1);
    const [event]=await db.sql<{diff:Record<string,unknown>;reason:string;payload:Record<string,unknown>}[]>`select a.diff,a.reason,o.payload from audit_events a join outbox_events o on o.workspace_id=a.workspace_id and o.change_seq=a.change_seq and o.event_ordinal=a.event_ordinal where a.entity_id=${f.task.id} and a.action='owner_exception'`;
    expect(required(event).diff).toMatchObject({ownerException:{policyRevision:policy.revision,reason:input.reason},historyCaptured:false});
    expect(required(event).reason).toBe(input.reason);expect(JSON.stringify(required(event).payload)).not.toContain(input.reason);expect(JSON.stringify(event)).not.toContain('private correction');
    const locked=await fields.updateField(ctx(),f.field.id,{expectedRevision:1,locked:true});
    expect((await rejection(fields.setTaskValueException(ctx(),f.task.id,f.field.id,{...input,expectedRevision:1,expectedDefinitionRevision:locked.revision}))).code).toBe('FIELD_LOCKED');
    const [count]=await db.sql<{n:number}[]>`select count(*)::int as n from tasks where project_id=${f.project.id}`;expect(required(count).n).toBe(1);
  });
  it('never changes an immutable original or its source value through an owner exception',async()=>{
    const f=await fixture('Frozen original');
    const value=await fields.setTaskValue(ctx(),f.task.id,f.field.id,{expectedRevision:0,expectedDefinitionRevision:1,value:{type:'text',value:'original'}});
    const monday=new Date();monday.setUTCDate(monday.getUTCDate()-((monday.getUTCDay()+6)%7));
    const period=await planning.createPeriod(ctx(),{projectId:f.project.id,name:'Original week',localStart:monday.toISOString().slice(0,10),timezone:'UTC',cutoffAt:new Date(Date.now()+3_600_000).toISOString(),protectedFieldIds:[f.field.id],protectEstimate:true});
    await planning.createCommitment(ctx(),period.id,{workPackageId:f.task.workPackageId,membershipId:M.teamOwner,expectedAbsent:true,plannedMinutes:60,allocations:[]});
    const preview=await planning.previewFreeze(ctx(),period.id,{scope:'project'});
    const baseline=await planning.freezePlan(ctx(),period.id,{scope:'project',previewHash:preview.previewHash});
    const before=await planning.getBaseline(ctx(),baseline.id);
    const policy=await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:0});
    expect((await rejection(fields.setTaskValueException(ctx(),f.task.id,f.field.id,{expectedRevision:value.revision,expectedDefinitionRevision:1,expectedPolicyRevision:policy.revision,value:{type:'text',value:'cannot rewrite'},reason:'Owner request'}))).code).toBe('FIELD_LOCKED');
    expect(await planning.getBaseline(ctx(),baseline.id)).toEqual(before);
    expect(await fields.listTaskValues(ctx(),f.task.id)).toEqual([value]);
    expect((await fields.getPolicyState(ctx(),f.task.id,f.field.id)).currentActorChangesUsed).toBe(0);
  });
});
