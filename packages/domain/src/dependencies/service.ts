import {createTaskDependencyInputSchema,updateTaskDependencyInputSchema,updateDependencyPolicyInputSchema,setGraphLayoutInputSchema,taskDependencyListQuerySchema,taskBlockingQuerySchema,dependencyGraphInputSchema,taskDependencySchema,projectDependencyPolicySchema,graphLayoutSchema,idSchema,type TaskDto,type TaskDependencyDto,type TaskBlockingSummaryDto,type DependencyGraphDto,type ProjectDependencyPolicyDto,type TaskStatusGroup} from '@workloom/contracts';
import type {z} from 'zod';
import {DomainError,notFoundError,unauthenticatedError} from '../errors.js';
import {canonicalJson} from '../tasks/service.js';
import {createPlanningMutationGuard,isCommittedPlanningRejection,unwrapPlanningOutcome} from '../planning/freeze.js';
import type {CommandContext} from '../access/context.js';
import type {Capability} from '../access/capabilities.js';
import type {DependencyApplication} from './application.js';
import type {DependencyApplicationDependencies,DependencyMutationCommand,DependencyRepository,DependencyWriteScope} from './ports.js';
const found=<T>(v:T|null|undefined):T=>{if(v===null||v===undefined)throw notFoundError();return v;};
const rule=(message:string)=>new DomainError('DOMAIN_VALIDATION_FAILED',message);
const revision=(actual:number,expected:number)=>{if(actual!==expected)throw new DomainError('REVISION_CONFLICT','Reload the current revision before saving.');};
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const p=schema.safeParse(value);if(!p.success)throw new DomainError('VALIDATION_FAILED','Invalid dependency input.');return p.data;}
function normalize(ctx:CommandContext):CommandContext{if(!ctx?.actor?.userId)throw unauthenticatedError();return {...ctx,workspaceId:parse(idSchema,ctx.workspaceId),actor:{...ctx.actor,userId:parse(idSchema,ctx.actor.userId)}};}
export function createDependencyApplication({writer,tools}:DependencyApplicationDependencies):DependencyApplication {
 const hash=(v:unknown)=>tools.digest(canonicalJson(v));
 async function requireTasks(repo:DependencyRepository,ws:string,ids:readonly string[]){const rows=await repo.taskContexts(ws,ids);if(new Set(rows.map(r=>r.task.id)).size!==new Set(ids).size)throw notFoundError();return rows;}
 async function summary(repo:DependencyRepository,task:TaskDto,unresolvedCount?:number,group?:TaskStatusGroup,currentPolicy?:ProjectDependencyPolicyDto):Promise<TaskBlockingSummaryDto>{
  const policy=currentPolicy??await repo.getPolicy(task.workspaceId,task.projectId),statusGroup=group??found(await repo.tasks.findStatus(task.workspaceId,task.statusId)).group;
  const count=unresolvedCount??((await repo.unresolvedCounts(task.workspaceId,[task.id])).get(task.id)??0),blocked=count>0,enforced=policy.mode==='enforce'&&blocked;
  return {taskId:task.id,policy:{projectId:policy.projectId,mode:policy.mode,revision:policy.revision},isBlocked:blocked,unresolvedCount:count,canStart:!enforced,canComplete:!enforced,violatesCurrentStatus:enforced&&(statusGroup==='in_progress'||statusGroup==='done')};
 }
 async function addition(repo:DependencyRepository,edge:Pick<TaskDependencyDto,'workspaceId'|'predecessorTaskId'|'successorTaskId'>){
  const ws=edge.workspaceId;if(edge.predecessorTaskId===edge.successorTaskId)throw rule('A task cannot depend on itself.');
  const predecessor=found(await repo.tasks.findTask(ws,edge.predecessorTaskId)),successor=found(await repo.tasks.findTask(ws,edge.successorTaskId));
  if(await repo.wouldCreateCycle(ws,predecessor.id,successor.id))throw new DomainError('DEPENDENCY_CYCLE','This dependency would create a cycle.');
  const pStatus=found(await repo.tasks.findStatus(ws,predecessor.statusId)),sStatus=found(await repo.tasks.findStatus(ws,successor.statusId));
  if(pStatus.group!=='done'&&(sStatus.group==='in_progress'||sStatus.group==='done')&&(await repo.getPolicy(ws,successor.projectId)).mode==='enforce')throw rule('The successor already has a status that requires finished predecessors.');
 }
 async function page<T extends {id:string}>(repo:DependencyRepository,ctx:CommandContext,q:{limit:number;cursor?:string|undefined},filters:unknown,load:(after:string|null,take:number)=>Promise<T[]>){
  const epoch=await repo.tasks.permissionEpoch(ctx.workspaceId),seq=await repo.currentChangeSeq(ctx.workspaceId),queryHash=hash({filters,seq});let after:string|null=null;
  if(q.cursor){const c=tools.decodeCursor(q.cursor);if(c.workspaceId!==ctx.workspaceId||c.actorUserId!==ctx.actor.userId||c.permissionEpoch!==epoch||c.queryHash!==queryHash)throw new DomainError('VALIDATION_FAILED','The dependency list changed. Restart from the first page.');after=parse(idSchema,c.afterId);}
  const rows=await load(after,q.limit+1),items=rows.slice(0,q.limit),last=items.at(-1);
  return {items,nextCursor:rows.length>items.length&&last?tools.encodeCursor({version:1,workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,permissionEpoch:epoch,queryHash,afterId:last.id}):null};
 }
 async function mutate<R>(ctx0:CommandContext,cap:Capability,command:DependencyMutationCommand,target:unknown,input:unknown,schema:z.ZodType<R>,validate:(repo:DependencyRepository,scope:DependencyWriteScope)=>Promise<void>,work:(scope:DependencyWriteScope)=>Promise<R>){
  const ctx=normalize(ctx0),key=ctx.idempotencyKey;if(!key||!/^[\x21-\x7e]{1,128}$/.test(key))throw new DomainError('VALIDATION_FAILED','A valid Idempotency-Key is required.');
  const payloadHash=hash({command,target,input});
  const outcome=await writer.run(ctx,cap,async scope=>{
   const repo=scope.dependencies;await validate(repo,scope);
   const cached=await repo.tasks.findIdempotency(ctx.workspaceId,ctx.actor.userId,command,key);
   if(cached){if(cached.payloadHash!==payloadHash)throw new DomainError('IDEMPOTENCY_KEY_REUSED','This key belongs to a different request.');return isCommittedPlanningRejection(cached.result)?cached.result:parse(schema,cached.result);}
   const currentEdge=command==='dependency.update'?found(await repo.findEdge(ctx.workspaceId,(target as {dependencyId:string}).dependencyId)):null;
   const guardTarget=currentEdge?{...(target as object),predecessorTaskId:currentEdge.predecessorTaskId,successorTaskId:currentEdge.successorTaskId}:target;
   const rejected=await createPlanningMutationGuard(scope,tools).check({family:'dependency',command,target:guardTarget,input});
   const result=rejected??await work(scope);
   await repo.tasks.insertIdempotency({workspaceId:ctx.workspaceId,actorUserId:ctx.actor.userId,command,idempotencyKey:key,payloadHash,result,createdAt:scope.barrierAt.toISOString()});return result;
  });return unwrapPlanningOutcome(outcome);
 }
 async function event(scope:DependencyWriteScope,entityType:string,entityId:string,action:string,entityRevision:number,diff:Record<string,unknown>){await scope.recordChange({entityType,entityId,action,entityRevision,diff,outbox:{type:`${entityType}.${action}`,payload:{workspaceId:scope.context.workspaceId,entityId,revision:entityRevision}}});}
 return {
  async listDependencies(ctx0,input){const ctx=normalize(ctx0),q=parse(taskDependencyListQuerySchema,input);return writer.read(ctx,'task.read',async repo=>{
   const ws=ctx.workspaceId;
   if('taskId'in q)found(await repo.tasks.findTask(ws,q.taskId));else found(await repo.tasks.findProject(ws,q.projectId));
   const {cursor:_cursor,limit:_limit,...filters}=q;
   return page(repo,ctx,q,{kind:'dependencies',...filters},(after,take)=>repo.listScopedEdges(ws,q,after,take));
  });},
  async createDependency(ctx0,input){const p=parse(createTaskDependencyInputSchema,input),ctx=normalize(ctx0),ws=ctx.workspaceId;
   const targets={predecessorTaskId:p.predecessorTaskId,successorTaskId:p.successorTaskId};
   return mutate(ctx,'task.edit','dependency.create',targets,p,taskDependencySchema,async repo=>{await requireTasks(repo,ws,[p.predecessorTaskId,p.successorTaskId]);},async scope=>{
    const repo=scope.dependencies;if(await repo.findNaturalEdge(ws,p.predecessorTaskId,p.successorTaskId))throw new DomainError('REVISION_CONFLICT','This dependency already exists; restore its stable identity if removed.');
    await addition(repo,{workspaceId:ws,...targets});const now=scope.barrierAt.toISOString(),row:TaskDependencyDto={id:tools.newId(),workspaceId:ws,...targets,type:'finish_to_start',state:'active',revision:1,createdAt:now,updatedAt:now};await repo.saveEdge(row,false);await event(scope,'task_dependency',row.id,'created',1,targets);return row;
   });},
  async updateDependency(ctx0,id,input){const dependencyId=parse(idSchema,id),p=parse(updateTaskDependencyInputSchema,input),ctx=normalize(ctx0),ws=ctx.workspaceId;
   return mutate(ctx,'task.edit','dependency.update',{dependencyId},p,taskDependencySchema,async repo=>{const e=found(await repo.findEdge(ws,dependencyId));await requireTasks(repo,ws,[e.predecessorTaskId,e.successorTaskId]);},async scope=>{
    const repo=scope.dependencies,row=found(await repo.findEdge(ws,dependencyId));revision(row.revision,p.expectedRevision);if(row.state===p.state)return row;if(p.state==='active')await addition(repo,row);
    const next={...row,state:p.state,revision:row.revision+1,updatedAt:scope.barrierAt.toISOString()};await repo.saveEdge(next,true);await event(scope,'task_dependency',row.id,p.state==='active'?'restored':'removed',next.revision,{predecessorTaskId:row.predecessorTaskId,successorTaskId:row.successorTaskId});return next;
   });},
  async getTaskBlocking(ctx0,id,input){const ctx=normalize(ctx0),taskId=parse(idSchema,id),q=parse(taskBlockingQuerySchema,input);return writer.read(ctx,'task.read',async repo=>{
   const task=found(await repo.tasks.findTask(ctx.workspaceId,taskId)),count=(await repo.unresolvedCounts(ctx.workspaceId,[taskId])).get(taskId)??0,result=await page(repo,ctx,q,{kind:'blockers',taskId},(after,take)=>repo.unresolvedIncoming(ctx.workspaceId,taskId,after,take)),contexts=await requireTasks(repo,ctx.workspaceId,result.items.map(e=>e.predecessorTaskId));
   return {data:{summary:await summary(repo,task,count),blockers:result.items.map(dependency=>{const row=found(contexts.find(c=>c.task.id===dependency.predecessorTaskId));return {dependency,predecessor:row.task,predecessorContext:row.context};}),asOfChangeSeq:await repo.currentChangeSeq(ctx.workspaceId)},nextCursor:result.nextCursor};
  });},
  async getProjectPolicy(ctx0,id){const ctx=normalize(ctx0),projectId=parse(idSchema,id);return writer.read(ctx,'task.read',async repo=>{found(await repo.tasks.findProject(ctx.workspaceId,projectId));return repo.getPolicy(ctx.workspaceId,projectId);});},
  async updateProjectPolicy(ctx0,id,input){const ctx=normalize(ctx0),projectId=parse(idSchema,id),p=parse(updateDependencyPolicyInputSchema,input);return mutate(ctx,'dependencies.manage','dependency.policy.update',{projectId},p,projectDependencyPolicySchema,async repo=>{found(await repo.tasks.findProject(ctx.workspaceId,projectId));},async scope=>{
   const row=await scope.dependencies.getPolicy(ctx.workspaceId,projectId);revision(row.revision,p.expectedRevision);if(row.mode===p.mode)return row;const next={projectId,mode:p.mode,revision:row.revision+1,updatedAt:scope.barrierAt.toISOString()};await scope.dependencies.savePolicy(ctx.workspaceId,next);await event(scope,'dependency_policy',projectId,'updated',next.revision,{mode:p.mode});return next;
  });},
  async getGraph(ctx0,id,input){const ctx=normalize(ctx0),projectId=parse(idSchema,id),q=parse(dependencyGraphInputSchema,input);return writer.read(ctx,'task.read',async repo=>{
   const ws=ctx.workspaceId;found(await repo.tasks.findProject(ws,projectId));const roots=await requireTasks(repo,ws,q.rootTaskIds);if(roots.some(c=>c.task.projectId!==projectId))throw rule('Graph roots must belong to the selected project.');
   const selected=new Set(q.rootTaskIds);let frontier=[...selected];
   for(let depth=0;depth<q.neighborDepth&&frontier.length;depth++){
    const adjacent=await repo.incidentEdges(ws,frontier,1001);if(adjacent.length>1000)throw rule('The graph exceeds 1000 edges. Narrow the selection.');
    const next=new Set<string>();for(const e of adjacent)for(const id of [e.predecessorTaskId,e.successorTaskId])if(!selected.has(id))next.add(id);
    for(const n of next)selected.add(n);if(selected.size>500)throw rule('The graph exceeds 500 nodes. Select fewer roots or a smaller depth.');frontier=[...next];
   }
   const edges=await repo.inducedEdges(ws,[...selected],1001);if(edges.length>1000)throw rule('The graph exceeds 1000 edges. Narrow the selection.');
   const outside=await repo.outsideDependencies(ws,[...selected]);
   const rows=await requireTasks(repo,ws,[...selected]),counts=await repo.unresolvedCounts(ws,[...selected]),policies=await repo.getPolicies(ws,[...new Set(rows.map(r=>r.task.projectId))]),nodes:DependencyGraphDto['nodes']=[];
   for(const row of rows.toSorted((a,b)=>a.task.id.localeCompare(b.task.id))){const incomingCount=counts.get(row.task.id)??0;
    // External unresolved count excludes all predecessors already present in the graph; their current statuses are in rows.
    const internalUnresolved=edges.filter(e=>e.successorTaskId===row.task.id&&selected.has(e.predecessorTaskId)&&rows.find(r=>r.task.id===e.predecessorTaskId)?.context.status.group!=='done').length;
    nodes.push({...row,blocking:await summary(repo,row.task,counts.get(row.task.id)??0,row.context.status.group,policies.get(row.task.projectId)),hasOutsideDependencies:outside.has(row.task.id),outsideUnresolvedPredecessorCount:Math.max(0,incomingCount-internalUnresolved)});
   }
   return {projectId,rootTaskIds:q.rootTaskIds,neighborDepth:q.neighborDepth,asOfChangeSeq:await repo.currentChangeSeq(ws),nodes,edges:edges.toSorted((a,b)=>a.id.localeCompare(b.id))};
  });},
  async getGraphLayout(ctx0,id){const ctx=normalize(ctx0),projectId=parse(idSchema,id);return writer.read(ctx,'task.read',async(repo,access)=>{found(await repo.tasks.findProject(ctx.workspaceId,projectId));const row=await repo.getLayout(ctx.workspaceId,projectId,access.membership.id);await requireTasks(repo,ctx.workspaceId,row.positions.map(p=>p.taskId));return row;});},
  async setGraphLayout(ctx0,id,input){const ctx=normalize(ctx0),projectId=parse(idSchema,id),p=parse(setGraphLayoutInputSchema,input);return mutate(ctx,'task.read','graph.layout.set',{projectId},p,graphLayoutSchema,async repo=>{found(await repo.tasks.findProject(ctx.workspaceId,projectId));await requireTasks(repo,ctx.workspaceId,p.positions.map(p=>p.taskId));},async scope=>{
   const repo=scope.dependencies,row=await repo.getLayout(ctx.workspaceId,projectId,scope.access.membership.id);revision(row.revision,p.expectedRevision);const positions=p.positions.toSorted((a,b)=>a.taskId.localeCompare(b.taskId));if(canonicalJson(row.positions)===canonicalJson(positions))return row;
   const next={...row,positions,revision:row.revision+1,updatedAt:scope.barrierAt.toISOString()};await repo.saveLayout(next,tools.newId());await event(scope,'graph_layout',projectId,'updated',next.revision,{membershipId:scope.access.membership.id,positionCount:positions.length});return next;
  });},
 };
}
