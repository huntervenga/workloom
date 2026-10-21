// Every write in this suite targets its own throwaway PostgreSQL database.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createDatabase,createSharedAuthStore,createTaskApplication,createTaskFieldApplication,createTaskCommentsApplication,runMigrations,type Database} from '@workloom/db';
import type {CommandContext,TaskApplication,TaskFieldApplication} from '@workloom/domain';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {databaseSnapshot} from './support/p1b.js';
const must=<T>(v:T|null|undefined):T=>{if(v===null||v===undefined)throw Error('Placement-field fixture required');return v;};
describe('ordinary fields retain independent project scope for one linked canonical task',()=>{
 let target:ThrowawayDatabase|undefined,db:Database,tasks:TaskApplication,fields:TaskFieldApplication,workspaceId:string,userId:string;
 const ctx=(key=randomUUID()):CommandContext=>({workspaceId,actor:{userId,displayName:'Linked field owner',kind:'real'},source:'import',requestId:'linked-field-pg',idempotencyKey:key});
 beforeAll(async()=>{
  target=await createThrowawayDatabase('placement_fields');await runMigrations(target.url,{requireLoopback:true});db=createDatabase(target.url,{requireLoopback:true});
  const owner=await createSharedAuthStore(db).provisionIdentity({issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Linked field owner',workspaceName:'Linked fields workspace',timezone:'UTC'});
  workspaceId=owner.workspaceId;userId=owner.user.id;tasks=createTaskApplication(db);fields=createTaskFieldApplication(db);
 },60000);
 afterAll(async()=>{await db?.close();await target?.drop();},30000);
 async function fixture(label:string){
  const home=await tasks.createProject(ctx(),{name:label+' home'}),linked=await tasks.createProject(ctx(),{name:label+' linked'});
  const status=must((await tasks.listStatuses(ctx(),home.id)).find(s=>s.group==='todo'));
  const task=await tasks.createTask(ctx(),{projectId:home.id,statusId:status.id,title:label,estimateMinutes:null});
  const homeField=await fields.createField(ctx(),{projectId:home.id,name:'Hours',type:'duration',historyEnabled:true,locked:false,options:[]});
  const field=await fields.createField(ctx(),{projectId:linked.id,name:'Hours',type:'duration',historyEnabled:true,locked:false,options:[]});
  await fields.setTaskValue(ctx(),task.id,homeField.id,{expectedRevision:0,expectedDefinitionRevision:1,value:{type:'duration',value:60}});
  const placement=await must(tasks.placements).attachTaskProject(ctx(),task.id,{projectId:linked.id,expectedTaskRevision:task.revision});
  return {home,linked,task,homeField,field,placement};
 }
 it('scopes values, history, policy usage and Activity to the field project; detach hides values without deleting history',async()=>{
  const f=await fixture('Independent field history');
  await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:1});
  const context=ctx(),input={expectedRevision:0,expectedDefinitionRevision:1,value:{type:'duration' as const,value:120}};
  const value=await fields.setTaskValue(context,f.task.id,f.field.id,input);
  expect(value.projectId).toBe(f.linked.id);expect(await fields.setTaskValue(context,f.task.id,f.field.id,input)).toEqual(value);
  expect(await tasks.getTask(ctx(),f.task.id)).toEqual(f.task);
  expect((await fields.listProjectValues(ctx(),f.home.id,{taskIds:[f.task.id]})).map(v=>v.value)).toEqual([{type:'duration',value:60}]);
  expect(await fields.listProjectValues(ctx(),f.linked.id,{taskIds:[f.task.id]})).toEqual([value]);
  expect((await fields.listValueHistory(ctx(),f.task.id,f.field.id,{limit:10})).items[0]).toMatchObject({projectId:f.linked.id,definition:{projectId:f.linked.id},after:input.value});
  expect((await fields.getPolicyState(ctx(),f.task.id,f.field.id)).currentActorChangesUsed).toBe(1);
  expect(await db.sql`select project_id from task_field_policy_usage where field_id=${f.field.id}`).toEqual([{project_id:f.linked.id}]);
  await expect(fields.setTaskValue(ctx(),f.task.id,f.field.id,{...input,expectedRevision:1,value:{type:'duration',value:180}})).rejects.toMatchObject({code:'FIELD_LOCKED',details:{policyReason:'change_limit'}});
  const timeline=await createTaskCommentsApplication(db).listTimeline(ctx(),f.task.id,{limit:100});
  const linkedItem=must(timeline.items.find(i=>i.type==='activity'&&i.kind==='field_value'&&JSON.stringify(i).includes(f.field.id)));
  expect(linkedItem).toMatchObject({detail:'exact',changes:expect.arrayContaining([expect.objectContaining({field:'custom',fieldId:f.field.id})])});
  const detached=await must(tasks.placements).detachTaskProjectPlacement(ctx(),f.placement.id,{expectedRevision:f.placement.revision});
  await expect(fields.listProjectValues(ctx(),f.linked.id,{taskIds:[f.task.id]})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  await expect(fields.listValueHistory(ctx(),f.task.id,f.field.id,{limit:10})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  await expect(fields.getPolicyState(ctx(),f.task.id,f.field.id)).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  await expect(fields.setTaskValue(ctx(),f.task.id,f.field.id,{...input,expectedRevision:1})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  await expect(fields.setTaskValue(context,f.task.id,f.field.id,input)).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  expect((await fields.listTaskValues(ctx(),f.task.id)).map(v=>v.fieldId)).toEqual([f.homeField.id]);
  expect(await db.sql`select count(*)::int n from task_field_value_history where field_id=${f.field.id}`).toEqual([{n:1}]);
  const detachedTimeline=await createTaskCommentsApplication(db).listTimeline(ctx(),f.task.id,{limit:100});
  const redacted=must(detachedTimeline.items.find(item=>item.id===linkedItem.id));
  expect(redacted).toMatchObject({detail:'partial',changes:[{field:'custom',fieldId:null,availability:'redacted'}]});
  expect(JSON.stringify(redacted)).not.toContain(f.field.id);
  await must(tasks.placements).restoreTaskProjectPlacement(ctx(),detached.id,{expectedRevision:detached.revision});
  expect(await fields.listProjectValues(ctx(),f.linked.id,{taskIds:[f.task.id]})).toEqual([value]);
  expect(await tasks.getTask(ctx(),f.task.id)).toEqual(f.task);
 });
 it('enforces home/target archival, manual target locks and current workspace access, without partial writes',async()=>{
  const f=await fixture('Protected linked field'),input={expectedRevision:0,expectedDefinitionRevision:1,value:{type:'duration' as const,value:0}};
  for(const project of [f.home,f.linked]){
   const archived=await tasks.updateProject(ctx(),project.id,{expectedRevision:project.revision,archived:true});
   await expect(fields.setTaskValue(ctx(),f.task.id,f.field.id,input)).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
   await tasks.updateProject(ctx(),project.id,{expectedRevision:archived.revision,archived:false});
  }
  const locked=await fields.updateField(ctx(),f.field.id,{expectedRevision:1,locked:true});
  await expect(fields.setTaskValue(ctx(),f.task.id,f.field.id,{...input,expectedDefinitionRevision:locked.revision})).rejects.toMatchObject({code:'FIELD_LOCKED'});
  const other=await createSharedAuthStore(db).provisionIdentity({issuer:'https://auth.example.test',subject:randomUUID(),displayName:'Other owner',workspaceName:'Other scope',timezone:'UTC'});
  const foreign={...ctx(),workspaceId:other.workspaceId,actor:{userId:other.user.id,displayName:'Other owner',kind:'real' as const}};
  await expect(fields.listProjectValues(foreign,f.linked.id,{taskIds:[f.task.id]})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await db.sql`select count(*)::int n from task_field_values where field_id=${f.field.id}`).toEqual([{n:0}]);
 });
 it('rolls target value, history, usage, audit and receipt back on a late failure, then accepts an exact retry',async()=>{
  const f=await fixture('Atomic linked field');await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:2});
  const context=ctx(),input={expectedRevision:0,expectedDefinitionRevision:1,value:{type:'duration' as const,value:0}};
  await db.sql.unsafe("create function qa_linked_history_fault() returns trigger language plpgsql as $$ begin raise exception 'qa_linked_history_fault'; end $$");
  await db.sql.unsafe('create trigger qa_linked_history_fault before insert on task_field_value_history for each row execute function qa_linked_history_fault()');
  const before=await databaseSnapshot(db.sql);
  try{await expect(fields.setTaskValue(context,f.task.id,f.field.id,input)).rejects.toThrow();expect(await databaseSnapshot(db.sql)).toEqual(before);}
  finally{await db.sql.unsafe('drop trigger qa_linked_history_fault on task_field_value_history');await db.sql.unsafe('drop function qa_linked_history_fault()');}
  expect(await fields.setTaskValue(context,f.task.id,f.field.id,input)).toMatchObject({projectId:f.linked.id,value:{type:'duration',value:0},revision:1});
 });
});
