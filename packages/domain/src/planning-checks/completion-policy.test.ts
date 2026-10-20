import {describe,expect,it,vi} from 'vitest';
import type {PlanningCheckRuleDto,PlanningCheckSettingsDto,TaskDto,TaskFieldData,TaskFieldDefinitionDto,TaskFieldValueDto} from '@workloom/contracts';
import {recurrenceCompletionScope} from '../recurrence/composer.js';
import {createTaskCompletionRequirementPolicy,hasCompletionFieldValue} from './completion-policy.js';
const task={id:'task',workspaceId:'ws',projectId:'project',parentTaskId:null,responsibleMembershipId:'member',dueDate:'2026-10-20',tags:[{id:'tag'}],statusId:'todo'} as TaskDto;
const definition={id:'field',name:'Ordinary custom field',type:'duration',archivedAt:null} as TaskFieldDefinitionDto;
const rule:Extract<PlanningCheckRuleDto,{kind:'presence'}>={id:'rule',name:'Completion value',kind:'presence',enabled:true,fieldId:'field',severity:'critical',color:'#ff0000',requireBeforeDone:true,hierarchy:'all_tasks',filters:{statusGroups:['done'],tagIds:[],assignee:{kind:'all'},dateRange:null}};
function fixture(changes:Partial<typeof rule>={},configEnabled=true){
 const settings:PlanningCheckSettingsDto={workspaceId:'ws',projectId:'project',revision:1,config:{enabled:configEnabled,rules:[{...rule,...changes}]}};
 const fields=[definition],values:TaskFieldValueDto[]=[];
 const reads={settings:vi.fn(async()=>settings),fields:{listFields:vi.fn(async()=>fields),listTaskValues:vi.fn(async()=>values)}};
 return{assert:createTaskCompletionRequirementPolicy(reads),settings,fields,values,reads};
}
describe('ordinary custom field completion requirements',()=>{
 it.each([undefined,{type:'duration',value:null},{type:'text',value:' \t\n\ufeff'},{type:'person',value:[]} ] as (TaskFieldData|undefined)[])('treats %j as missing',value=>{expect(hasCompletionFieldValue(value)).toBe(false);});
 it.each([{type:'duration',value:0},{type:'number',value:0},{type:'boolean',value:false},{type:'text',value:'\u0085'},{type:'person',value:['member']} ] as TaskFieldData[])('treats %j as filled',value=>{expect(hasCompletionFieldValue(value)).toBe(true);});
 it('evaluates done-only filters against destination and reports IDs without retaining raw values',async()=>{
  const f=fixture();await expect(f.assert(task)).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED',details:{policyReason:'completion_fields_required',fieldIds:['field']}});
  f.values.push({taskId:'task',fieldId:'field',value:{type:'duration',value:0}} as TaskFieldValueDto);await expect(f.assert(task)).resolves.toBeUndefined();
 });
 it.each([{enabled:false},{requireBeforeDone:false},{requireBeforeDone:undefined}])('leaves advisory/disabled rule %j inert',async changes=>{const f=fixture(changes);await expect(f.assert(task)).resolves.toBeUndefined();expect(f.reads.fields.listFields).not.toHaveBeenCalled();});
 it('master disable suppresses enforcement and archived requirements fail explicitly until repaired',async()=>{
  const disabled=fixture({},false);await expect(disabled.assert(task)).resolves.toBeUndefined();expect(disabled.reads.fields.listTaskValues).not.toHaveBeenCalled();
  const f=fixture();f.fields[0]={...definition,archivedAt:'2026-10-20T00:00:00.000Z'};await expect(f.assert(task)).rejects.toMatchObject({details:{unavailableFieldIds:['field']}});
 });
 it('honors all configured task scope filters and prospective changes',async()=>{
  for(const changes of [{hierarchy:'root_tasks' as const},{filters:{...rule.filters,tagIds:['required-tag']}},{filters:{...rule.filters,assignee:{kind:'unassigned' as const}}},{filters:{...rule.filters,assignee:{kind:'member' as const,membershipId:'another'}}},{filters:{...rule.filters,dateRange:{source:{kind:'due_date' as const},from:'2026-11-01',to:'2026-11-30'}}}]){
   const f=fixture(changes);await expect(f.assert(changes.hierarchy?{...task,parentTaskId:'parent'}:task)).resolves.toBeUndefined();
  }
  const f=fixture({filters:{...rule.filters,assignee:{kind:'member',membershipId:'another'},tagIds:['required-tag']}});
  await expect(f.assert(task)).resolves.toBeUndefined();await expect(f.assert(task,{prospective:{responsibleMembershipId:'another',tagIds:['required-tag']}})).rejects.toMatchObject({details:{fieldIds:['field']}});
 });
 it('uses validated atomic field candidates for create, import and bulk without reading stored create values',async()=>{
  const f=fixture();await expect(f.assert(task,{creating:true,fieldValues:[{fieldId:'field',value:{type:'duration',value:0}}]})).resolves.toBeUndefined();expect(f.reads.fields.listTaskValues).not.toHaveBeenCalled();
  f.values.push({fieldId:'field',value:{type:'duration',value:60}} as TaskFieldValueDto);
  await expect(f.assert(task,{fieldValues:[{fieldId:'field',value:{type:'duration',value:null}}]})).rejects.toMatchObject({details:{fieldIds:['field']}});
 });
 it('honors date-field filters using atomic candidate dates and rejects mismatched field type',async()=>{
  const f=fixture({filters:{...rule.filters,dateRange:{source:{kind:'field',fieldId:'date'},from:'2026-10-01',to:'2026-10-31'}}});
  f.fields.push({...definition,id:'date',type:'date'});
  await expect(f.assert(task)).resolves.toBeUndefined();await expect(f.assert(task,{creating:true,fieldValues:[{fieldId:'date',value:{type:'date',value:'2026-10-20'}}]})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  const g=fixture();await expect(g.assert(task,{fieldValues:[{fieldId:'field',value:{type:'text',value:'not duration'}}]})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
 });
});

it('uses prospective recurrence organizer and timezone-local due date when completing into or out of rule scope',async()=>{
 const f=fixture({filters:{...rule.filters,assignee:{kind:'member',membershipId:'member'},dateRange:{source:{kind:'due_date'},from:'2026-10-20',to:'2026-10-20'}}});
 const projected=(person:string,at:string)=>recurrenceCompletionScope({calendarState:'scheduled',resolution:{resolvedStartAt:at},version:{template:{organizerMembershipId:person},schedule:{timezone:'Asia/Nicosia'}}} as Parameters<typeof recurrenceCompletionScope>[0]);
 await expect(f.assert(task,{prospective:projected('another','2026-10-19T22:00:00.000Z')})).resolves.toBeUndefined();
 await expect(f.assert({...task,responsibleMembershipId:'another',dueDate:'2026-10-19'},{prospective:projected('member','2026-10-19T22:00:00.000Z')})).rejects.toMatchObject({details:{fieldIds:['field']}});
 await expect(f.assert(task,{prospective:projected('member','2026-10-20T22:00:00.000Z')})).resolves.toBeUndefined();
});

it.each(['missing','archived','wrong_type'] as const)('does not use an unavailable date filter source as an enforcement bypass: %s',async kind=>{
 const f=fixture({filters:{...rule.filters,dateRange:{source:{kind:'field',fieldId:'date'},from:'2026-10-01',to:'2026-10-31'}}});
 if(kind!=='missing')f.fields.push({...definition,id:'date',type:kind==='wrong_type'?'text':'date',archivedAt:kind==='archived'?'2026-10-20T00:00:00.000Z':null});
 await expect(f.assert(task)).rejects.toMatchObject({details:{policyReason:'completion_fields_required',unavailableFieldIds:['date']}});
});
