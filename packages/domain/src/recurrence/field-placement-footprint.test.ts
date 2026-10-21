import {describe,expect,it} from 'vitest';
import type {PlanningRepository} from '../planning/ports.js';
import {resolveRecurrenceAffectedProjects,type RecurrenceFootprintScope} from './footprint.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ws=id(1),home=id(2),target=id(3),taskId=id(4),fieldId=id(5);
function scope(active:boolean):RecurrenceFootprintScope {
 return {context:{workspaceId:ws},repository:{tasks:{findTask:async()=>({id:taskId,projectId:home})},fields:{findField:async()=>({id:fieldId,projectId:target}),hasActivePlacement:async(w:string,t:string,p:string)=>active&&w===ws&&t===taskId&&p===target}} as unknown as PlanningRepository,recurrence:{} as RecurrenceFootprintScope['recurrence']};
}
describe('linked field recurrence footprint',()=>{
 for(const command of ['field.value.set','field.value.exception'] as const) {
  it(`${command} includes canonical home and target field project`,async()=>{
   expect(await resolveRecurrenceAffectedProjects(scope(true),{family:'field',command,target:{taskId,fieldId},input:{}})).toEqual({kind:'projects',projectIds:[home,target]});
  });
  it(`${command} rejects inactive project presence before census or freeze`,async()=>{
   await expect(resolveRecurrenceAffectedProjects(scope(false),{family:'field',command,target:{taskId,fieldId},input:{}})).rejects.toMatchObject({code:'DOMAIN_VALIDATION_FAILED'});
  });
 }
});
