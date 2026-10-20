import {DomainError,notFoundError} from '../errors.js';
import type {DependencyRepository,TaskStatusTransitionPolicy,TaskStatusTransitionOptions} from './ports.js';
import type {TaskDto} from '@workloom/contracts';
/** Current graph/policy within the caller's existing workspace transaction. No nested UOW or HTTP rules. */
export function createTaskStatusTransitionPolicy(repo:DependencyRepository,assertCompletion:(task:TaskDto,options?:TaskStatusTransitionOptions)=>Promise<void>):TaskStatusTransitionPolicy {
 return {async assertTransition(task,nextStatusId,options){
  if(task.statusId===nextStatusId&&!options?.creating)return;
  const status=await repo.tasks.findStatus(task.workspaceId,nextStatusId);if(!status)throw notFoundError();
  if(status.projectId!==task.projectId)throw new DomainError('DOMAIN_VALIDATION_FAILED','The status belongs to another project.');
  if(status.group!=='in_progress'&&status.group!=='done')return;
  if((await repo.getPolicy(task.workspaceId,task.projectId)).mode==='enforce'&&((await repo.unresolvedCounts(task.workspaceId,[task.id])).get(task.id)??0))
   throw new DomainError('DOMAIN_VALIDATION_FAILED','Finish the unresolved predecessors before changing this task status.',{details:{fields:['statusId']}});
  if(status.group==='done'){const previous=options?.creating?null:await repo.tasks.findStatus(task.workspaceId,task.statusId);if(options?.creating||previous?.group!=='done')await assertCompletion(task,options);}
 }};
}
