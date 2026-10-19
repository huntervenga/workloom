// This suite owns a fresh disposable child; never reads DATABASE_URL or the running demo.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkUpdateTasksInput, TaskDto } from '@workloom/contracts';
import type { CommandContext, TaskApplication, TaskFieldApplication } from '@workloom/domain';
import { createDatabase, createTaskApplication, createTaskFieldApplication, createDependencyApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { changedTables, databaseSnapshot } from './support/p1b.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';
requireTestDatabaseUrl();
const ctx = (key = randomUUID()): CommandContext => ({ workspaceId: W.team, actor: { userId: U.owner, displayName: 'Synthetic undo', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: key });
function required<T>(value: T | undefined | null): T { if (value === null || value === undefined) throw new Error('Missing disposable undo fixture'); return value; }
const ref = (task: TaskDto) => ({ taskId: task.id, expectedRevision: task.revision });
describe('atomic user-command inverse on isolated PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined, db: Database, tasks: TaskApplication, fields: TaskFieldApplication;
  beforeAll(async () => {
    target = await createThrowawayDatabase('bulk_undo'); db = createDatabase(target.url, { requireLoopback: true });
    if ((await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`).length) throw new Error('Child must be empty');
    await runMigrations(target.url, { requireLoopback: true }); await seedDemoData(db);
    tasks = createTaskApplication(db); fields = createTaskFieldApplication(db);
  }, 60_000);
  afterAll(async () => { try { await db?.close(); } finally { await target?.drop(); } });
  async function fixture(name: string) {
    const project = await tasks.createProject(ctx(), { name }); const statuses = await tasks.listStatuses(ctx(),project.id);
    const todo = required(statuses.find(row => row.group === 'todo')), done = required(statuses.find(row => row.group === 'done'));
    const a = await tasks.createTask(ctx(), { projectId:project.id,title:'A',statusId:todo.id,responsibleMembershipId:M.teamMemberA,participantMembershipIds:[M.teamMemberA],dueDate:'2030-01-02' });
    const b = await tasks.createTask(ctx(), { projectId:project.id,title:'B',statusId:done.id,responsibleMembershipId:null,participantMembershipIds:[],dueDate:null });
    const field = await fields.createField(ctx(), {projectId:project.id,name:'Ordinary fact',type:'duration',historyEnabled:true,locked:false,options:[]});
    return {project,todo,done,a,b,field};
  }
  async function unchanged(code: string, run: () => Promise<unknown>) { const before=await databaseSnapshot(db.sql); await expect(run()).rejects.toMatchObject({code}); expect(await databaseSnapshot(db.sql)).toEqual(before); }
  it('restores heterogeneous scalar/roster values atomically, persists new audit and exact replay without rewriting past history',async()=>{
    const f=await fixture('Inverse scalar roster');
    const changed=await tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,tasks:[f.a,f.b].map(task=>({...ref(task),expectedParticipantsRevision:task.participantsRevision})),changes:{statusId:f.todo.id,responsibleMembershipId:M.teamOwner,participantMembershipIds:[M.teamOwner],dueDate:'2030-02-01'}});
    const body:BulkUpdateTasksInput={projectId:f.project.id,tasks:changed.map(task=>({...ref(task),expectedParticipantsRevision:task.participantsRevision})),changes:{restore:[f.a,f.b].map(task=>({taskId:task.id,changes:{statusId:task.statusId,responsibleMembershipId:task.responsibleMembershipId,participantMembershipIds:task.participants.filter(row=>row.active).map(row=>row.membershipId),dueDate:task.dueDate}}))}};
    const key=randomUUID(),restored=await tasks.bulkUpdateTasks(ctx(key),body);
    for(const [index,task]of restored.entries()){const original=required([f.a,f.b][index]);expect(task).toMatchObject({statusId:original.statusId,responsibleMembershipId:original.responsibleMembershipId,dueDate:original.dueDate});expect(task.participants.filter(row=>row.active).map(row=>row.membershipId)).toEqual(original.participants.filter(row=>row.active).map(row=>row.membershipId));expect(task.revision).toBeGreaterThan(original.revision);}
    const snapshot=await databaseSnapshot(db.sql);expect(await tasks.bulkUpdateTasks(ctx(key),body)).toEqual(restored);expect(await databaseSnapshot(db.sql)).toEqual(snapshot);
    const audit=await db.sql`select * from audit_events where entity_id=${f.a.id} and action='updated'`;expect(audit.length).toBeGreaterThanOrEqual(2);
  });
  it('ACKs persisted custom heads in the same receipt and clears first-fill semantically without deleting its history',async()=>{
    const f=await fixture('Inverse custom explicit clear');
    const before=await fields.setTaskValue(ctx(),f.a.id,f.field.id,{expectedRevision:0,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:0}});
    const forward:BulkUpdateTasksInput={projectId:f.project.id,includeFieldValueAck:true,tasks:[{...ref(f.a),expectedFieldValueRevision:before.revision},{...ref(f.b),expectedFieldValueRevision:0}],changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:90}}}};
    const key=randomUUID(),changed=await tasks.bulkUpdateTasks(ctx(key),forward);
    for(const task of changed) expect(task.customFieldAck).toEqual(required((await fields.listTaskValues(ctx(),task.id)).find(row=>row.fieldId===f.field.id)));
    const receipt=await databaseSnapshot(db.sql);expect(await tasks.bulkUpdateTasks(ctx(key),forward)).toEqual(changed);expect(await databaseSnapshot(db.sql)).toEqual(receipt);
    const inverse:BulkUpdateTasksInput={projectId:f.project.id,includeFieldValueAck:true,tasks:changed.map(task=>({...ref(task),expectedFieldValueRevision:required(task.customFieldAck).revision})),changes:{restore:changed.map(task=>({taskId:task.id,changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:task.id===f.a.id?0:null}}}}))}};
    const undone=await tasks.bulkUpdateTasks(ctx(),inverse);expect(undone.map(task=>task.customFieldAck?.value)).toEqual([{type:'duration',value:0},{type:'duration',value:null}]);
    const rows=await db.sql`select * from task_field_values where task_id=${f.b.id}`;expect(rows).toHaveLength(1);
    const history=await db.sql`select * from task_field_value_history where task_id=${f.b.id}`;expect(history.length).toBeGreaterThanOrEqual(2);
  });
  it('rejects a stale later value or a locked different field before any inverse proposal',async()=>{
    const f=await fixture('Inverse custom guards');const other=await fields.createField(ctx(),{projectId:f.project.id,name:'Other',type:'boolean',historyEnabled:true,locked:false,options:[]});
    const a=await fields.setTaskValue(ctx(),f.a.id,f.field.id,{expectedRevision:0,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:30}});
    const b=await fields.setTaskValue(ctx(),f.b.id,other.id,{expectedRevision:0,expectedDefinitionRevision:other.revision,value:{type:'boolean',value:false}});
    const body:BulkUpdateTasksInput={projectId:f.project.id,includeFieldValueAck:true,tasks:[{...ref(f.a),expectedFieldValueRevision:a.revision},{...ref(f.b),expectedFieldValueRevision:b.revision+1}],changes:{restore:[{taskId:f.a.id,changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:0}}}},{taskId:f.b.id,changes:{customField:{fieldId:other.id,expectedDefinitionRevision:other.revision,value:{type:'boolean',value:true}}}}]}};
    await unchanged('REVISION_CONFLICT',()=>tasks.bulkUpdateTasks(ctx(),body));required(body.tasks[1]).expectedFieldValueRevision=b.revision;
    await fields.updateField(ctx(),other.id,{expectedRevision:other.revision,locked:true});
    const before=await databaseSnapshot(db.sql);await expect(tasks.bulkUpdateTasks(ctx(),body)).rejects.toMatchObject({code:'FIELD_LOCKED',details:{committed:true}});expect(changedTables(before,await databaseSnapshot(db.sql))).toEqual(['command_idempotency']);
  });
  it('rolls back every earlier inverse value, audit, policy counter and receipt on late SQL failure',async()=>{
    const f=await fixture('Inverse rollback');const changed=await tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,includeFieldValueAck:true,tasks:[f.a,f.b].map(task=>({...ref(task),expectedFieldValueRevision:0})),changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:90}}}});
    const inverse:BulkUpdateTasksInput={projectId:f.project.id,includeFieldValueAck:true,tasks:changed.map(task=>({...ref(task),expectedFieldValueRevision:required(task.customFieldAck).revision})),changes:{restore:changed.map(task=>({taskId:task.id,changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:0}}}}))}};
    if(!/^[0-9a-f-]{36}$/.test(f.b.id))throw new Error('Unexpected fixture ID');
    await db.sql.unsafe(`create function undo_late_fault() returns trigger language plpgsql as $$ begin if new.task_id='${f.b.id}'::uuid then raise exception 'undo_late_fault'; end if; return new; end $$`);
    try{await db.sql.unsafe('create trigger undo_late_fault before insert or update on task_field_values for each row execute function undo_late_fault()');const snapshot=await databaseSnapshot(db.sql);await expect(tasks.bulkUpdateTasks(ctx(),inverse)).rejects.toThrow();expect(await databaseSnapshot(db.sql)).toEqual(snapshot);}finally{await db.sql.unsafe('drop trigger if exists undo_late_fault on task_field_values');await db.sql.unsafe('drop function if exists undo_late_fault()');}
  });
  it('counts inverse writes as new actor changes and never refunds a consumed change budget',async()=>{
    const f=await fixture('Inverse quota');await fields.setPolicy(ctx(),f.field.id,{expectedRevision:0,lockAt:null,maxChangesPerActor:2});
    const first=await tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,includeFieldValueAck:true,tasks:[{...ref(f.a),expectedFieldValueRevision:0}],changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:90}}}});
    const changed=required(first[0]);const inverse:BulkUpdateTasksInput={projectId:f.project.id,includeFieldValueAck:true,tasks:[{...ref(changed),expectedFieldValueRevision:required(changed.customFieldAck).revision}],changes:{restore:[{taskId:changed.id,changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:null}}}}]}};
    const undone=required((await tasks.bulkUpdateTasks(ctx(),inverse))[0]);expect((await fields.getPolicyState(ctx(),f.a.id,f.field.id)).currentActorChangesUsed).toBe(2);
    const before=await databaseSnapshot(db.sql);await expect(tasks.bulkUpdateTasks(ctx(),{...inverse,tasks:[{...ref(undone),expectedFieldValueRevision:required(undone.customFieldAck).revision}],changes:{restore:[{taskId:f.a.id,changes:{customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:90}}}}]}})).rejects.toMatchObject({code:'FIELD_LOCKED',details:{policyReason:'change_limit',committed:true}});
    expect(changedTables(before,await databaseSnapshot(db.sql))).toEqual(['command_idempotency']);expect((await fields.getPolicyState(ctx(),f.a.id,f.field.id)).currentActorChangesUsed).toBe(2);
  });
  it('applies current dependency status policy to every heterogeneous inverse target',async()=>{
    const f=await fixture('Inverse dependency');
    // This must exercise a real transition into done; reapplying done is an allowed no-op.
    const blocked = await tasks.updateTask(ctx(), f.b.id, { expectedRevision: f.b.revision, statusId: f.todo.id });
    expect(blocked.statusId).toBe(f.todo.id); expect(blocked.statusId).not.toBe(f.done.id);
    const dependency=createDependencyApplication(db);
    await dependency.createDependency(ctx(),{predecessorTaskId:f.a.id,successorTaskId:blocked.id,type:'finish_to_start',expectedAbsent:true});
    await dependency.updateProjectPolicy(ctx(),f.project.id,{expectedRevision:0,mode:'enforce'});
    await unchanged('DOMAIN_VALIDATION_FAILED',()=>tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,tasks:[ref(f.a),ref(blocked)],changes:{restore:[{taskId:f.a.id,changes:{priority:'high'}},{taskId:blocked.id,changes:{statusId:f.done.id}}]}}));
  });
});
