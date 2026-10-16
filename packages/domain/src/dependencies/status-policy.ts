import {DomainError,notFoundError} from '../errors.js';
import type {DependencyRepository,TaskStatusTransitionPolicy} from './ports.js';
/** Current graph/policy within the caller's existing workspace transaction. No nested UOW or HTTP rules. */
export function createTaskStatusTransitionPolicy(repo:DependencyRepository):TaskStatusTransitionPolicy {
 return {async assertTransition(task,nextStatusId){
  if(task.statusId===nextStatusId)return;
  const status=await repo.tasks.findStatus(task.workspaceId,nextStatusId);if(!status)throw notFoundError();
  if(status.projectId!==task.projectId)throw new DomainError('DOMAIN_VALIDATION_FAILED','The status belongs to another project.');
  if(status.group!=='in_progress'&&status.group!=='done')return;
  if((await repo.getPolicy(task.workspaceId,task.projectId)).mode==='enforce'&&((await repo.unresolvedCounts(task.workspaceId,[task.id])).get(task.id)??0))
   throw new DomainError('DOMAIN_VALIDATION_FAILED','Finish the unresolved predecessors before changing this task status.',{details:{fields:['statusId']}});
 }};
}
