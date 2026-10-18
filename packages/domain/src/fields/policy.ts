import type { TaskFieldData, TaskFieldDefinitionDto, TaskFieldPolicyDto, TaskFieldValueDto } from '@workloom/contracts';
import { DomainError } from '../errors.js';
import type { TaskFieldPolicyRepository } from './ports.js';

export function emptyFieldPolicy(field:Pick<TaskFieldDefinitionDto,'workspaceId'|'projectId'|'id'>):TaskFieldPolicyDto {
  return {workspaceId:field.workspaceId,projectId:field.projectId,fieldId:field.id,revision:0,lockAt:null,maxChangesPerActor:null,activatedAt:null,updatedAt:null,updatedByUserId:null};
}
export type FieldPolicyBlock = 'deadline'|'change_limit';
/** Read-only. The workspace barrier serializes this check with the single usage append on commit. */
export async function fieldPolicyBlock(repo:TaskFieldPolicyRepository,policy:TaskFieldPolicyDto,taskId:string|null,actorUserId:string,now:Date):Promise<FieldPolicyBlock|null> {
  if(policy.lockAt!==null&&now.getTime()>=Date.parse(policy.lockAt))return 'deadline';
  if(policy.maxChangesPerActor!==null) {
    const used=taskId===null?0:await repo.count(policy.workspaceId,taskId,policy.fieldId,actorUserId);
    if(used>=policy.maxChangesPerActor)return 'change_limit';
  }
  return null;
}
export function fieldPolicyError(reason:FieldPolicyBlock):DomainError {
  return new DomainError('FIELD_LOCKED',reason==='deadline'?'The field deadline has passed.':'Your change limit for this task field has been reached.',{details:{fields:['fieldId'],policyReason:reason}});
}
/** Exact typed-value equality; absent and typed null deliberately differ. */
export function sameFieldValue(current:TaskFieldValueDto|null,value:TaskFieldData):boolean {
  const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x:unknown)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
  return current!==null&&canonical(current.value)===canonical(value);
}
