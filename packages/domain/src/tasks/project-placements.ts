import {attachTaskProjectInputSchema,changeTaskProjectPlacementStateInputSchema,idSchema,projectRowsQuerySchema,taskProjectPlacementSchema,transferTaskProjectInputSchema,transferTaskProjectResultSchema,updateTaskProjectPlacementInputSchema,type AttachTaskProjectInput,type ChangeTaskProjectPlacementStateInput,type TaskDto,type TaskProjectPlacementDto,type SetTaskFieldValueInput,type TaskFieldData,type TransferTaskProjectResult} from '@workloom/contracts';
import {authorizeWorkspace} from '../access/access-queries.js';
import type {CommandContext} from '../access/context.js';
import {DomainError,notFoundError,unauthenticatedError} from '../errors.js';
import {isCommittedPlanningRejection,unwrapPlanningOutcome} from '../planning/freeze.js';
import {canonicalJson} from './service.js';
import {preflightTaskFieldValueInScope,setTaskFieldValueInScope} from '../fields/service.js';
import type {TaskFieldWriteScope} from '../fields/ports.js';
import type {TaskProjectPlacementApplication,TaskProjectPlacementCommand,TaskProjectPlacementDependencies,TaskProjectPlacementWriteScope} from './project-placement-ports.js';

interface Parser<T>{safeParse(value:unknown):{success:true;data:T}|{success:false;error:{issues:readonly {path:readonly PropertyKey[]}[]}}}
function parse<T>(schema:Parser<T>,value:unknown):T {
 const result=schema.safeParse(value);if(result.success)return result.data;
 throw new DomainError('VALIDATION_FAILED','The request is invalid.',{details:{fields:[...new Set(result.error.issues.map(issue=>issue.path.map(String).join('.')||'(root)'))]}});
}
function path(value:string):string {const p=idSchema.safeParse(value);if(!p.success)throw notFoundError();return p.data;}
function context(value:CommandContext):CommandContext {const workspaceId=path(value.workspaceId),actor=idSchema.safeParse(value.actor.userId);if(!actor.success)throw unauthenticatedError();return {...value,workspaceId,actor:{...value.actor,userId:actor.data}};}
function found<T>(value:T|null):T {if(value===null)throw notFoundError();return value;}
function rule(message:string,field:string):never {throw new DomainError('DOMAIN_VALIDATION_FAILED',message,{details:{fields:[field]}});}
function transferRule(message:string,reason:string,field:string):never {throw new DomainError('DOMAIN_VALIDATION_FAILED',message,{details:{fields:[field],transferReason:reason}});}
function revision(current:number,expected:number):void {if(current!==expected)throw new DomainError('REVISION_CONFLICT','Reload the resource and retry.',{details:{currentRevision:current}});}
function ordinary(task:TaskDto):void {if(task.meetingId)rule('Meeting and recurrence placements are outside this slice.','taskId');}
const MAX_POSITION=2_147_483_647;

/** Canonical tasks/packages/plans/facts remain untouched by every placement command. */
export function createTaskProjectPlacementApplication(deps:TaskProjectPlacementDependencies):TaskProjectPlacementApplication {
 const {reader,tasks,writer,tools}=deps;
 async function read(ctx:CommandContext):Promise<CommandContext>{const normalized=context(ctx);await authorizeWorkspace(tasks.access,normalized,'task.read');return normalized;}
 async function mutate(ctx:CommandContext,command:TaskProjectPlacementCommand,targetId:string,input:unknown,attach:boolean,work:(scope:TaskProjectPlacementWriteScope,task:TaskDto,current:TaskProjectPlacementDto|null,projectId:string,now:string)=>Promise<TaskProjectPlacementDto>):Promise<TaskProjectPlacementDto>{
  const normalized=context(ctx),key=normalized.idempotencyKey;
  if(key===undefined||! /^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');
  const payloadHash=tools.digest(canonicalJson({command,target:targetId,input}));
  const outcome=await writer.run(normalized,'task.edit',async scope=>{
   const ws=normalized.workspaceId,repo=scope.repository;
   // Current workspace capability was checked under the barrier. Resolve current targets BEFORE receipt replay.
   const current=attach?null:found(await scope.placements.find(ws,targetId));
   const task=found(await repo.findTask(ws,current?.taskId??targetId));ordinary(task);
   const projectId=attach?(input as AttachTaskProjectInput).projectId:found(current).projectId;
   found(await repo.findProject(ws,task.projectId));found(await repo.findProject(ws,projectId));
   const existing=await repo.findIdempotency(ws,normalized.actor.userId,command,key);
   if(existing){if(existing.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key belongs to a different request.');if(isCommittedPlanningRejection(existing.result))return existing.result;return parse(taskProjectPlacementSchema,existing.result);}
   const rejected=await scope.planningGuard.check({family:'task_placement',command,target:{taskId:task.id,projectId},input});
   const now=scope.barrierAt.toISOString(),result=rejected??await work(scope,task,current,projectId,now);
   await repo.insertIdempotency({workspaceId:ws,actorUserId:normalized.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:now});return result;
  });
  return unwrapPlanningOutcome(outcome);
 }
 async function targetSection(scope:TaskProjectPlacementWriteScope,ws:string,projectId:string,sectionId:string|null):Promise<void>{
  if(sectionId===null)return;const section=found(await scope.repository.findSection(ws,sectionId));
  if(section.projectId!==projectId)rule('The section belongs to another project.','sectionId');if(section.archivedAt!==null)rule('The section is archived.','sectionId');
 }
 /** A project may forbid its tasks from living in other projects, and may refuse tasks from other projects. */
 async function requireSharingAllowed(scope:TaskProjectPlacementWriteScope,task:TaskDto,projectId:string):Promise<void>{
  const find=scope.repository.findProjectRules;if(!find)return;
  const [target,home]=await Promise.all([find.call(scope.repository,task.workspaceId,projectId),find.call(scope.repository,task.workspaceId,task.projectId)]);
  if(target?.config.singleProject)rule('This project keeps every task in one project only. Move the task here instead of adding it.','projectId');
  if(home?.config.singleProject)rule('The task\'s own project keeps every task in one project only.','projectId');
 }
 async function openTarget(scope:TaskProjectPlacementWriteScope,task:TaskDto,projectId:string):Promise<void>{
  if(task.archivedAt!==null)rule('The task is archived.','taskId');
  if(found(await scope.repository.findProject(task.workspaceId,projectId)).archivedAt!==null)rule('The project is archived.','projectId');
  if(found(await scope.repository.findProject(task.workspaceId,task.projectId)).archivedAt!==null)rule('The home project is archived.','homeProjectId');
 }
 async function record(scope:TaskProjectPlacementWriteScope,row:TaskProjectPlacementDto,action:string,before:TaskProjectPlacementDto|null):Promise<void>{
  await scope.recordChange({entityType:'task_project_placement',entityId:row.id,entityRevision:row.revision,action,diff:{taskId:row.taskId,projectId:row.projectId,homeProjectId:row.homeProjectId,sectionId:{from:before?.sectionId??null,to:row.sectionId},position:{from:before?.position??null,to:row.position},archivedAt:{from:before?.archivedAt??null,to:row.archivedAt}},outbox:{type:`task_project_placement.${action}`,payload:{workspaceId:row.workspaceId,placementId:row.id,taskId:row.taskId,projectId:row.projectId,homeProjectId:row.homeProjectId,revision:row.revision}}});
 }
 async function changeState(ctx:CommandContext,id:string,raw:ChangeTaskProjectPlacementStateInput,archived:boolean):Promise<TaskProjectPlacementDto>{
  const input=parse(changeTaskProjectPlacementStateInputSchema,raw);
  return mutate(ctx,archived?'task.project.detach':'task.project.restore',path(id),input,false,async(scope,task,current,projectId,now)=>{
   const row=found(current);if(row.projectId===row.homeProjectId)rule('The accounting home placement cannot be detached or restored.','placementId');revision(row.revision,input.expectedRevision);
   if(!archived){await openTarget(scope,task,projectId);await requireSharingAllowed(scope,task,projectId);await targetSection(scope,row.workspaceId,projectId,row.sectionId);}
   if((row.archivedAt!==null)===archived)return row;
   const next={...row,archivedAt:archived?now:null,revision:row.revision+1,updatedAt:now};await scope.placements.save(next);await record(scope,next,archived?'detached':'restored',row);return next;
  });
 }
 return {
  async listTaskPlacements(ctx,taskId){const normalized=await read(ctx),id=path(taskId);found(await tasks.findTask(normalized.workspaceId,id));const rows=await reader.listForTask(normalized.workspaceId,id,501);if(rows.length>500)rule('The task has too many placements to list safely.','taskId');return rows;},
  async listProjectRows(ctx,projectId,raw){
   const normalized=await read(ctx),id=path(projectId),input=parse(projectRowsQuerySchema,raw),ws=normalized.workspaceId;found(await tasks.findProject(ws,id));
   const epoch=await tasks.permissionEpoch(ws),queryHash=tools.digest(canonicalJson({namespace:'project-rows-v1',projectId:id,limit:input.limit,includeArchived:input.includeArchived}));
   let after:{position:number;id:string}|null=null;
   if(input.cursor){const token=tools.decodeCursor(input.cursor);if(token.version!==1||token.workspaceId!==ws||token.actorUserId!==normalized.actor.userId||token.permissionEpoch!==epoch||token.queryHash!==queryHash)throw new DomainError('VALIDATION_FAILED','This project-row cursor is no longer valid.');after={position:token.position,id:token.id};}
   const rows=await reader.listProject(ws,id,input.includeArchived,after,input.limit+1),hasMore=rows.length>input.limit,selected=rows.slice(0,input.limit);
   const items=await Promise.all(selected.map(async placement=>{const canonicalTask=found(await tasks.findTask(ws,placement.taskId)),canonicalStatus=found(await tasks.findStatus(ws,canonicalTask.statusId)),homeProject=found(await tasks.findProject(ws,canonicalTask.projectId));return {placement,canonicalTask,canonicalStatus,homeProject};}));
   const last=selected.at(-1);return {items,nextCursor:hasMore&&last?tools.encodeCursor({version:1,workspaceId:ws,actorUserId:normalized.actor.userId,permissionEpoch:epoch,queryHash,position:last.position,id:last.id}):null};
  },
  async attachTaskProject(ctx,taskId,raw){const input=parse(attachTaskProjectInputSchema,raw);return mutate(ctx,'task.project.attach',path(taskId),input,true,async(scope,task,_current,projectId,now)=>{
   revision(task.revision,input.expectedTaskRevision);await openTarget(scope,task,projectId);await requireSharingAllowed(scope,task,projectId);
   if(projectId===task.projectId)rule('The task already has its accounting home placement.','projectId');
   if(await scope.placements.findForTaskProject(task.workspaceId,task.id,projectId))rule('This placement already exists. Restore a detached placement explicitly.','projectId');
   if((await scope.placements.listForTask(task.workspaceId,task.id,501)).length>=500)rule('The task has reached its placement limit.','projectId');
   await targetSection(scope,task.workspaceId,projectId,input.sectionId??null);
   const position=input.position??(await scope.placements.maxPosition(task.workspaceId,projectId))+1;if(position>MAX_POSITION)rule('The project order is full. Pass an explicit position.','position');
   const row:TaskProjectPlacementDto={id:idSchema.parse(tools.newId()),workspaceId:task.workspaceId,taskId:task.id,homeProjectId:task.projectId,projectId,sectionId:input.sectionId??null,position,revision:1,archivedAt:null,createdAt:now,updatedAt:now};await scope.placements.insert(row);await record(scope,row,'attached',null);return row;
  });},
  async updateTaskProjectPlacement(ctx,placementId,raw){const input=parse(updateTaskProjectPlacementInputSchema,raw);return mutate(ctx,'task.project.update',path(placementId),input,false,async(scope,task,current,projectId,now)=>{
   const row=found(current);if(row.projectId===row.homeProjectId)rule('Use the canonical task command to move its home row.','placementId');revision(row.revision,input.expectedRevision);await openTarget(scope,task,projectId);if(row.archivedAt!==null)rule('Restore the detached placement first.','placementId');
   const sectionId=input.sectionId===undefined?row.sectionId:input.sectionId;await targetSection(scope,row.workspaceId,projectId,sectionId);const position=input.position??row.position;if(sectionId===row.sectionId&&position===row.position)return row;
   const next={...row,sectionId,position,revision:row.revision+1,updatedAt:now};await scope.placements.save(next);await record(scope,next,'updated',row);return next;
  });},
  /**
   * The only way a task's home project changes. The whole subtree moves; hours, plans and reports follow the new home
   * from now on (saved baselines and snapshots are never rewritten). The former home keeps a detached placement, so
   * the immutable history of its field values stays attached to something that exists.
   */
  async transferTaskProject(ctx,taskId,raw){
   const input=parse(transferTaskProjectInputSchema,raw),normalized=context(ctx),key=normalized.idempotencyKey,command='task.project.transfer' as const;
   if(key===undefined||! /^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');
   const id=path(taskId),payloadHash=tools.digest(canonicalJson({command,target:id,input}));
   const outcome=await writer.run(normalized,'task.edit',async scope=>{
    const ws=normalized.workspaceId,repo=scope.repository;
    // Current targets exist before any replay; every state-dependent rule runs after it, so a committed transfer replays.
    const task=found(await repo.findTask(ws,id));found(await repo.findProject(ws,task.projectId));
    const targetProject=await repo.findProject(ws,input.projectId);if(targetProject===null)throw notFoundError();
    const existing=await repo.findIdempotency(ws,normalized.actor.userId,command,key);
    if(existing){if(existing.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key belongs to a different request.');if(isCommittedPlanningRejection(existing.result))return existing.result;return parse(transferTaskProjectResultSchema,existing.result);}
    const rejected=await scope.planningGuard.check({family:'task_placement',command,target:{taskId:task.id,projectId:targetProject.id},input});
    const now=scope.barrierAt.toISOString();
    const result=rejected??await (async():Promise<TransferTaskProjectResult>=>{
     revision(task.revision,input.expectedRevision);ordinary(task);
     if(task.archivedAt!==null)transferRule('The task is archived.','archived','taskId');
     if(task.parentTaskId!==null)transferRule('A subtask always stays with its parent. Move the parent task instead.','subtask','taskId');
     if(targetProject.id===task.projectId)transferRule('The task is already in this project.','same_project','projectId');
     if(targetProject.archivedAt!==null)transferRule('The project is archived.','archived','projectId');
     if(found(await repo.findProject(ws,task.projectId)).archivedAt!==null)transferRule('The home project is archived.','archived','homeProjectId');
     const find=repo.findProjectRules;
     if(find){
      const [target,home]=await Promise.all([find.call(repo,ws,targetProject.id),find.call(repo,ws,task.projectId)]);
      if(home?.config.lockMoves)transferRule('The task\'s project does not allow moving tasks out of it.','locked_from','projectId');
      if(target?.config.lockMoves)transferRule('This project does not allow moving tasks into it.','locked_to','projectId');
     }
     // The rule is about the placements that remain: a "one project only" target cannot receive a task that is still shown elsewhere.
     // Keeping the former home means it remains as well.
     const keep=input.keepFormerHome===true;
     if((await find?.call(repo,ws,targetProject.id))?.config.singleProject){
      const others=(await scope.placements.listForTask(ws,task.id,501)).filter(item=>item.archivedAt===null&&(keep||item.projectId!==task.projectId)&&item.projectId!==targetProject.id);
      if(others.length>0)transferRule('This project keeps every task in one project only, and the task is still placed in other projects. Remove it from them first.','single_project','projectId');
     }
     if(keep&&(await find?.call(repo,ws,task.projectId))?.config.singleProject)transferRule('The task\'s current project keeps every task in one project only, so the task cannot stay there once another project is its home.','single_project_former','projectId');
     if(input.sectionId!==undefined)await targetSection(scope,ws,targetProject.id,input.sectionId);
     const moved=await scope.placements.transferTree({workspaceId:ws,taskId:task.id,targetProjectId:targetProject.id,sectionId:input.sectionId,now,keepFormerHome:keep});
     // Values go through the shared field primitive, so locks, policies, history and audit apply as for any other write.
     const lost=new Map(moved.notCarried.map(item=>[item.fieldName,item.count] as const)),fields=scope.fieldRepository;let carriedValues=0;
     const fieldScope=fields?{context:scope.context,access:scope.access,barrierAt:scope.barrierAt,recordChange:scope.recordChange,planningGuard:scope.planningGuard,repository:fields} as TaskFieldWriteScope:null;
     for(const item of moved.values){
      const lose=()=>{lost.set(item.fieldName,(lost.get(item.fieldName)??0)+1);};
      if(!fields||!fieldScope){lose();continue;}
      const field=await fields.findField(ws,item.fieldId),current=await fields.findValue(ws,item.taskId,item.fieldId);
      if(!field){lose();continue;}
      // A project counts the tasks it shows by its own fields, linked ones too. So when the former home stays among the
      // task's projects the value moves: it is cleared there. If it cannot be cleared (a lock, a field rule), it stays
      // in the former home and is not copied, so it is never counted twice.
      let clear:SetTaskFieldValueInput|null=null;
      if(keep&&item.value.value!==null){
       const source=await fields.findField(ws,item.sourceFieldId),held=await fields.findValue(ws,item.taskId,item.sourceFieldId);
       if(!source||!held){lose();continue;}
       clear={expectedRevision:held.revision,expectedDefinitionRevision:source.revision,value:{type:source.type,value:null} as TaskFieldData};
       try{await preflightTaskFieldValueInScope(fieldScope,item.taskId,item.sourceFieldId,clear);}
       catch(error){if(error instanceof DomainError){lose();continue;}throw error;}
      }
      try{await setTaskFieldValueInScope(fieldScope,item.taskId,item.fieldId,{expectedRevision:current?.revision??0,expectedDefinitionRevision:field.revision,value:item.value as TaskFieldData},tools);carriedValues+=1;}
      catch(error){if(error instanceof DomainError){lose();continue;}throw error;}
      if(clear)await setTaskFieldValueInScope(fieldScope,item.taskId,item.sourceFieldId,clear,tools);
     }
     const after=await repo.findTasksByIds(ws,moved.movedTaskIds),byId=new Map(after.map(t=>[t.id,t]));
     for(const movedId of moved.movedTaskIds){
      const current=byId.get(movedId);if(!current)throw notFoundError();
      await scope.recordChange({entityType:'task',entityId:movedId,entityRevision:current.revision,action:'project_transferred',
       diff:{projectId:{from:task.projectId,to:targetProject.id}},
       ...(movedId===task.id?{outbox:{type:'task.project_transferred',payload:{taskId:task.id,fromProjectId:task.projectId,toProjectId:targetProject.id,movedTasks:moved.movedTaskIds.length}}}:{})});
     }
     const root=byId.get(task.id);if(!root)throw notFoundError();
     return {task:root,movedTaskIds:moved.movedTaskIds,carriedValues,notCarried:[...lost].map(([fieldName,count])=>({fieldName,count})).sort((a,b)=>a.fieldName.localeCompare(b.fieldName))};
    })();
    await repo.insertIdempotency({workspaceId:ws,actorUserId:normalized.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:now});return result;
   });
   return parse(transferTaskProjectResultSchema,unwrapPlanningOutcome(outcome));
  },
  detachTaskProjectPlacement:(ctx,id,input)=>changeState(ctx,id,input,true),restoreTaskProjectPlacement:(ctx,id,input)=>changeState(ctx,id,input,false),
 };
}
