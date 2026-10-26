import type {PlanningCheckSettingsDto,TaskDto,TaskFieldData} from '@workloom/contracts';
import {DomainError} from '../errors.js';
import type {TaskFieldRepository} from '../fields/ports.js';
import {matchesPlanningCheckTask} from './engine.js';
import {planningValuePresent} from './math.js';
import type {TaskStatusTransitionOptions} from '../dependencies/ports.js';

export interface CompletionRequirementRepository {
 settings(workspaceId:string,projectId:string):Promise<PlanningCheckSettingsDto>;
 fields:Pick<TaskFieldRepository,'listFields'|'listTaskValues'>;
 /** Of `fieldIds`, those with a stored number/duration value on a descendant; the table shows that sum on the parent. */
 filledDescendantFieldIds?(workspaceId:string,taskId:string,fieldIds:readonly string[]):Promise<readonly string[]>;
}
/** Same semantics as the advisory projection: zero/false filled, null/absent/trim/[] missing. */
export function hasCompletionFieldValue(value:TaskFieldData|undefined):boolean {
 return planningValuePresent(value?.value);
}
/** Called only for a new entry into done, inside the current authorized workspace transaction. */
export function createTaskCompletionRequirementPolicy(repository:CompletionRequirementRepository){
 return async(task:TaskDto,options:TaskStatusTransitionOptions={}):Promise<void>=>{
  const settings=await repository.settings(task.workspaceId,task.projectId);
  if(!settings.config.enabled)return;
  const rules=settings.config.rules.filter(rule=>rule.enabled&&rule.kind==='presence'&&rule.requireBeforeDone===true);
  if(!rules.length)return;
  const fields=await repository.fields.listFields(task.workspaceId,task.projectId);
  const definitions=new Map(fields.map(field=>[field.id,field]));
  const stored=options.creating?[]:await repository.fields.listTaskValues(task.workspaceId,task.id);
  const values=new Map(stored.map(row=>[row.fieldId,row.value]));
  for(const candidate of options.fieldValues??[])values.set(candidate.fieldId,candidate.value);
  const context=options.prospective??{},parentTaskId=context.parentTaskId===undefined?task.parentTaskId:context.parentTaskId,responsible=context.responsibleMembershipId===undefined?task.responsibleMembershipId:context.responsibleMembershipId,dueDate=context.dueDate===undefined?task.dueDate:context.dueDate,tags=context.tagIds??task.tags.map(tag=>tag.id);
  const missing:string[]=[],unavailable:string[]=[];
  let rolledUp:ReadonlySet<string>|undefined;
  const rollupFor=async(field:{id:string;type:string})=>{
   if(options.creating||(field.type!=='number'&&field.type!=='duration')||!repository.filledDescendantFieldIds)return false;
   rolledUp??=new Set(await repository.filledDescendantFieldIds(task.workspaceId,task.id,rules.flatMap(rule=>rule.kind==='presence'?[rule.fieldId]:[])));
   return rolledUp.has(field.id);
  };
  for(const rule of rules){
   if(rule.kind!=='presence')continue;
   const subject={...task,parentTaskId,responsibleMembershipId:responsible,dueDate,tagIds:[...tags],statusGroup:'done' as const};
   if(!matchesPlanningCheckTask(rule,subject,source=>{if(source.kind==='due_date')return dueDate;const definition=definitions.get(source.fieldId);if(!definition||definition.archivedAt!==null||definition.type!=='date'){unavailable.push(source.fieldId);return null;}const value=values.get(source.fieldId);return value?.type==='date'?value.value:null;}))continue;
   const field=definitions.get(rule.fieldId);
   if(!field||field.archivedAt!==null){unavailable.push(rule.fieldId);continue;}
   const value=values.get(rule.fieldId);
   if((value?.type!==field.type||!hasCompletionFieldValue(value))&&!((value===undefined||value.type===field.type)&&await rollupFor(field)))missing.push(rule.fieldId);
  }
  if(unavailable.length||missing.length)throw new DomainError('DOMAIN_VALIDATION_FAILED','Fill the configured required fields before completing this task.',{details:{fields:['statusId'],policyReason:'completion_fields_required',fieldIds:[...new Set([...missing,...unavailable])].sort(),unavailableFieldIds:[...new Set(unavailable)].sort(),fieldNames:[...new Set([...missing,...unavailable])].map(id=>definitions.get(id)?.name??'').filter(Boolean)}});
 };
}
