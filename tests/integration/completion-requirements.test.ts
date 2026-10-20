// Actual command factories on a random synthetic child of TEST_DATABASE_URL; never the application database.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import * as D from '@workloom/db';
import type * as C from '@workloom/contracts';
import type {CommandContext,PlanningCheckApplication,TaskApplication,TaskFieldApplication} from '@workloom/domain';
import {databaseSnapshot} from './support/p1b.js';
import {createThrowawayDatabase,type ThrowawayDatabase} from './support/test-database.js';
import {requireTestDatabaseUrl} from './support/test-database-url.js';
requireTestDatabaseUrl();
const W=D.FIXTURE_WORKSPACE_IDS,U=D.FIXTURE_USER_IDS,ctx=(userId:string=U.owner,key=randomUUID()):CommandContext=>({workspaceId:W.team,actor:{userId,displayName:'Synthetic completion actor',kind:'fixture'},source:'web',requestId:randomUUID(),idempotencyKey:key});
function must<T>(v:T|null|undefined):T{if(v===null||v===undefined)throw Error('Missing completion fixture');return v;}
describe('optional ordinary-field completion gates on real isolated PostgreSQL',()=>{
 let target:ThrowawayDatabase|undefined,db:D.Database,tasks:TaskApplication,fields:TaskFieldApplication,checks:PlanningCheckApplication;
 beforeAll(async()=>{target=await createThrowawayDatabase('completion_requirements');db=D.createDatabase(target.url,{requireLoopback:true});await D.runMigrations(target.url,{requireLoopback:true});await D.seedDemoData(db);tasks=D.createTaskApplication(db);fields=D.createTaskFieldApplication(db);checks=D.createPlanningCheckApplication(db);},60000);
 afterAll(async()=>{await db?.close();await target?.drop();},30000);
 async function fixture(type:C.TaskFieldType='duration'){
  const project=await tasks.createProject(ctx(),{name:'Completion '+randomUUID().slice(0,8)}),statuses=await tasks.listStatuses(ctx(),project.id),todo=must(statuses.find(s=>s.group==='todo')),done=must(statuses.find(s=>s.group==='done'));
  const field=await fields.createField(ctx(),{projectId:project.id,name:'Ordinary required value',type,historyEnabled:true,locked:false,options:[]});
  const rule:Extract<C.PlanningCheckRuleDto,{kind:'presence'}>={id:randomUUID(),name:'Record value before completion',enabled:true,kind:'presence',fieldId:field.id,color:'#dc2626',severity:'critical',hierarchy:'all_tasks',filters:{statusGroups:['done'],tagIds:[],assignee:{kind:'all'},dateRange:null},requireBeforeDone:true};
  await checks.setSettings(ctx(),project.id,{expectedRevision:0,config:{enabled:true,rules:[rule]}});return{project,todo,done,field,rule};
 }
 async function set(taskId:string,field:C.TaskFieldDefinitionDto,value:C.TaskFieldData,revision=0){return fields.setTaskValue(ctx(),taskId,field.id,{expectedRevision:revision,expectedDefinitionRevision:field.revision,value});}
 async function rejectUnchanged(work:()=>Promise<unknown>,reason='completion_fields_required'){
  const before=await databaseSnapshot(db.sql);await expect(work()).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED',details:{policyReason:reason}});expect(await databaseSnapshot(db.sql)).toEqual(before);
 }
 it('blocks completion without writing and allows zero, exact replay and fixing historical completed tasks',async()=>{
  const f=await fixture(),task=await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.todo.id,title:'Needs a recorded answer'});
  await rejectUnchanged(()=>tasks.updateTask(ctx(),task.id,{expectedRevision:task.revision,statusId:f.done.id}));
  const zero=await set(task.id,f.field,{type:'duration',value:0}),key=randomUUID(),body={expectedRevision:task.revision,statusId:f.done.id};
  const completed=await tasks.updateTask(ctx(U.owner,key),task.id,body);expect(completed.statusId).toBe(f.done.id);
  await set(task.id,f.field,{type:'duration',value:null},zero.revision);
  const fixed=await tasks.updateTask(ctx(),task.id,{expectedRevision:completed.revision,title:'Historical record can be corrected',statusId:f.done.id});expect(fixed.title).toBe('Historical record can be corrected');
  const before=await databaseSnapshot(db.sql);expect(await tasks.updateTask(ctx(U.owner,key),task.id,body)).toEqual(completed);expect(await databaseSnapshot(db.sql)).toEqual(before);
  const report=await checks.query(ctx(),f.project.id,{expectedSettingsRevision:1});expect(report.summary.missingRequiredTasks).toBe(1);
 });
 it('treats false as a filled Boolean and keeps master/rule disabling optional',async()=>{
  const f=await fixture('boolean'),task=await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.todo.id,title:'No is an answer'});
  await set(task.id,f.field,{type:'boolean',value:false});expect((await tasks.updateTask(ctx(),task.id,{expectedRevision:task.revision,statusId:f.done.id})).statusId).toBe(f.done.id);
  await checks.setSettings(ctx(),f.project.id,{expectedRevision:1,config:{enabled:false,rules:[f.rule]}});
  const noValue=await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.done.id,title:'Explicitly disabled'});expect(noValue.statusId).toBe(f.done.id);
  await checks.setSettings(ctx(),f.project.id,{expectedRevision:2,config:{enabled:true,rules:[{...f.rule,enabled:false}]}});expect((await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.done.id,title:'Rule paused'})).statusId).toBe(f.done.id);
 });
 it('rejects an entire multi-row completion if any row is missing, and accepts atomic field+status changes',async()=>{
  const f=await fixture(),a=await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.todo.id,title:'First'}),b=await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.todo.id,title:'Second'});
  const first=await set(a.id,f.field,{type:'duration',value:0});
  await rejectUnchanged(()=>tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,tasks:[a,b].map(t=>({taskId:t.id,expectedRevision:t.revision})),changes:{statusId:f.done.id}}));
  const saved=await tasks.bulkUpdateTasks(ctx(),{projectId:f.project.id,tasks:[{taskId:a.id,expectedRevision:a.revision,expectedFieldValueRevision:first.revision},{taskId:b.id,expectedRevision:b.revision,expectedFieldValueRevision:0}],changes:{statusId:f.done.id,customField:{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:0}}}});
  expect(saved).toHaveLength(2);expect((await tasks.getTask(ctx(),a.id)).statusId).toBe(f.done.id);expect((await tasks.getTask(ctx(),b.id)).statusId).toBe(f.done.id);
 });
 it('gates Board moves and undo into Done without changing position, receipt or audit on refusal',async()=>{
  const f=await fixture(),task=await tasks.createTask(ctx(),{projectId:f.project.id,statusId:f.todo.id,title:'Move safely'});
  await rejectUnchanged(()=>tasks.moveTask(ctx(),task.id,{expectedRevision:task.revision,statusId:f.done.id,anchorTaskId:null,placement:'after',captureUndo:true}));
  const zero=await set(task.id,f.field,{type:'duration',value:0});let current=await tasks.moveTask(ctx(),task.id,{expectedRevision:task.revision,statusId:f.done.id,anchorTaskId:null,placement:'after'});expect(current.statusId).toBe(f.done.id);
  const reopened=await tasks.moveTask(ctx(),task.id,{expectedRevision:current.revision,statusId:f.todo.id,anchorTaskId:null,placement:'after',captureUndo:true}),ack=must(reopened.moveUndo),input={expectedRevision:reopened.revision,originalMoveKey:ack.originalKey,expectedOrderFingerprint:ack.orderFingerprint,expectedHeads:ack.afterHeads};
  const cleared=await set(task.id,f.field,{type:'duration',value:null},zero.revision);await rejectUnchanged(()=>tasks.restoreMoveTask(ctx(),task.id,input));
  await set(task.id,f.field,{type:'duration',value:30},cleared.revision);current=await tasks.restoreMoveTask(ctx(),task.id,input);expect(current.statusId).toBe(f.done.id);
 });
 it('checks direct create and atomically validates row candidates, including late type failures',async()=>{
  const f=await fixture(),rows=D.createTaskRowApplication(db),task={projectId:f.project.id,statusId:f.done.id,title:'Created already done'};
  await rejectUnchanged(()=>tasks.createTask(ctx(),task));await rejectUnchanged(()=>rows.createRow(ctx(),{task}));
  const saved=await rows.createRow(ctx(),{task,fields:[{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'duration',value:0}}]});expect(saved.task.statusId).toBe(f.done.id);expect(saved.fields[0]?.value).toEqual({type:'duration',value:0});
  const before=await databaseSnapshot(db.sql);await expect(rows.createRow(ctx(),{task:{...task,title:'No typed-value bypass'},fields:[{fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,value:{type:'text',value:'not a duration'}}]})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});expect(await databaseSnapshot(db.sql)).toEqual(before);
 });
 it('checks imported Done tasks and accepts legitimate mapped values in the same atomic import',async()=>{
  const f=await fixture(),imports=D.createProjectImportApplication(db),mapping:C.ProjectImportMapping={externalIdColumn:0,titleColumn:1,defaultStatusId:f.done.id,dateFormat:'iso',shareableScopeConfirmed:true,people:[],statuses:[],sections:[],tags:[],customFields:[{column:2,fieldId:f.field.id,expectedDefinitionRevision:f.field.revision,empty:'missing',sourceMeaning:'ordinary',sourceUnit:'minutes'}],preserveColumns:[]};
  const staged=await imports.stageCsv(ctx(),f.project.id,{fileName:'synthetic.csv',sourceNamespace:randomUUID(),csvText:'ID,Name,Value\nmissing,Missing value,'}),preview=await imports.previewImport(ctx(),f.project.id,staged.id,{expectedImportRevision:staged.revision,mapping});
  await rejectUnchanged(()=>imports.applyImport(ctx(),f.project.id,staged.id,{expectedImportRevision:staged.revision,mapping,previewHash:preview.previewHash}));
  const good=await imports.stageCsv(ctx(),f.project.id,{fileName:'synthetic.csv',sourceNamespace:randomUUID(),csvText:'ID,Name,Value\nzero,Zero value,0'}),goodPreview=await imports.previewImport(ctx(),f.project.id,good.id,{expectedImportRevision:good.revision,mapping}),key=randomUUID(),body={expectedImportRevision:good.revision,mapping,previewHash:goodPreview.previewHash},result=await imports.applyImport(ctx(U.owner,key),f.project.id,good.id,body);
  expect(result.tasks).toHaveLength(1);expect(result.tasks[0]?.statusId).toBe(f.done.id);expect((await fields.listTaskValues(ctx(),must(result.tasks[0]).id))[0]?.value).toEqual({type:'duration',value:0});
  const before=await databaseSnapshot(db.sql);expect(await imports.applyImport(ctx(U.owner,key),f.project.id,good.id,body)).toEqual(result);expect(await databaseSnapshot(db.sql)).toEqual(before);
 });
 it('checks meeting-backed task creation through the same shared policy',async()=>{
  const f=await fixture(),planning=D.createPlanningApplication(db),meetings=D.createMeetingApplication(db),membershipId=String(must((await db.sql`select id from memberships where workspace_id=${W.team} and user_id=${U.owner}`)[0]).id),period=await planning.createPeriod(ctx(),{projectId:f.project.id,name:'Synthetic future',localStart:'2027-06-07',timezone:'UTC',cutoffAt:'2027-06-07T18:00:00.000Z',protectedFieldIds:[],protectEstimate:false});
  await rejectUnchanged(()=>meetings.createMeeting(ctx(),f.project.id,{title:'Cannot bypass through meetings',statusId:f.done.id,plannedPeriodId:period.id,plannedStartAt:'2027-06-07T10:00:00.000Z',timezone:'UTC',plannedDurationMinutes:30,organizerMembershipId:membershipId,attendeeMembershipIds:[membershipId]}));
 });
});
