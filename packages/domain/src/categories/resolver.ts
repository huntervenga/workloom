import type {ManualPeriodWorkLogDto,ProjectWorkCategoryBindingDto,WorkCategorySnapshot} from '@workloom/contracts';
import {DomainError,notFoundError} from '../errors.js';
import type {WorkCategoryBindingRecord,WorkCategoryRepository,WorkCategoryResolver} from './ports.js';

export const legacyWorkCategory=():WorkCategorySnapshot=>({kind:'uncategorized',reason:'legacy',bindingVersionId:null,bindingRevision:null,fieldId:null});
export function canonicalWorkCategory(row:ManualPeriodWorkLogDto):WorkCategorySnapshot {return row.category??legacyWorkCategory();}
export async function readWorkCategoryBinding(repo:WorkCategoryRepository,workspaceId:string,projectId:string):Promise<ProjectWorkCategoryBindingDto> {
 const row=await repo.findBinding(workspaceId,projectId);
 if(row===null)return {workspaceId,projectId,revision:1,versionId:null,fieldId:null,availability:'unbound'};
 if(row.fieldId===null)return {...row,availability:'unbound'};
 const field=await repo.planning.fields.findField(workspaceId,row.fieldId);
 if(field===null||field.projectId!==projectId||field.type!=='single_select')throw new Error('Stored work category binding is inconsistent.');
 return {...row,availability:field.archivedAt===null?'active':'field_archived'};
}
/** Runs only inside the current time command's workspace barrier; no HTTP policy. */
export function createWorkCategoryResolver(repo:WorkCategoryRepository,workspaceId:string):WorkCategoryResolver {
 return {async resolve(taskId) {
  const task=await repo.planning.tasks.findTask(workspaceId,taskId);if(!task)throw notFoundError();
  const binding=await readWorkCategoryBinding(repo,workspaceId,task.projectId);
  const base={bindingVersionId:binding.versionId,bindingRevision:binding.revision,fieldId:binding.fieldId};
  if(binding.fieldId===null)return {kind:'uncategorized',reason:'unbound',...base};
  if(binding.availability==='field_archived')return {kind:'uncategorized',reason:'field_unavailable',...base};
  const field=await repo.planning.fields.findField(workspaceId,binding.fieldId);if(!field||!binding.versionId)throw new Error('Stored work category definition is missing.');
  const value=await repo.planning.fields.findValue(workspaceId,task.id,field.id);
  if(value===null||value.value.value===null)return {kind:'uncategorized',reason:'unset',...base};
  if(value.value.type!=='single_select')throw new DomainError('DOMAIN_VALIDATION_FAILED','The saved work category value has an incompatible type.');
  const option=field.options.find(o=>o.id===value.value.value);if(!option)throw new Error('Stored work category option is missing.');
  return {kind:'categorized',bindingVersionId:binding.versionId,bindingRevision:binding.revision,fieldId:field.id,fieldDefinitionVersionId:field.definitionVersionId,fieldLabel:field.name,optionId:option.id,optionRevision:option.revision,optionLabel:option.name,color:option.color,optionArchivedAt:option.archivedAt};
 }};
}
export function bindingRecord(binding:ProjectWorkCategoryBindingDto):WorkCategoryBindingRecord {
 if(binding.versionId===null)throw new Error('A virtual binding cannot be stored.');
 return {workspaceId:binding.workspaceId,projectId:binding.projectId,revision:binding.revision,versionId:binding.versionId,fieldId:binding.fieldId};
}
