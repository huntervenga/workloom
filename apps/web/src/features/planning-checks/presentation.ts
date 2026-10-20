import type { PlanningCheckAssessmentDto, PlanningCheckConfigDto, PlanningCheckGroupResultDto, PlanningCheckRuleDto } from '@workloom/contracts';
import type { FieldAdvisory } from '../fields/FieldAdvisory';
import { t } from '../../i18n';
export function checkReason(reason:PlanningCheckGroupResultDto['reason']):string {switch(reason){case'field_unavailable':return t('planningChecks.reason.fieldUnavailable');case'group_unavailable':return t('planningChecks.reason.groupUnavailable');case'member_unavailable':return t('planningChecks.reason.memberUnavailable');case'schedule_unknown':return t('planningChecks.reason.scheduleUnknown');case'project_dates_missing':return t('planningChecks.reason.projectDatesMissing');case'project_dates_too_long':return t('planningChecks.reason.projectDatesTooLong');case'zero_target':return t('planningChecks.reason.zeroTarget');case'incomplete_plan':return t('planningChecks.reason.incompletePlan');case'no_known_plan':return t('planningChecks.reason.noKnownPlan');case'date_field_unavailable':return t('planningChecks.reason.dateFieldUnavailable');case'disabled':return t('planningChecks.disabled');default:return'';}}
export function checkKind(rule:PlanningCheckRuleDto['kind']):string{return rule==='presence'?t('planningChecks.kind.presence'):rule==='overdue'?t('planningChecks.kind.overdue'):t('planningChecks.kind.balance');}
export function sameCheckGroup(a:PlanningCheckGroupResultDto['group'],b:PlanningCheckGroupResultDto['group']):boolean{return a.kind===b.kind&&(a.kind==='section'?b.kind==='section'&&a.sectionId===b.sectionId:b.kind==='assignee'&&a.membershipId===b.membershipId);}
/** Presence is exclusively a trusted server flag, never inferred from a loaded or unsent cell. */
export function createPlanningFieldAdvisory(config:PlanningCheckConfigDto|undefined,assessment:PlanningCheckAssessmentDto|undefined):(taskId:string,fieldId:string,fieldName:string)=>FieldAdvisory|null {
 const flags=new Map(assessment?.taskFlags.map(flag=>[flag.taskId,flag])??[]),results=new Map(assessment?.rules.map(rule=>[rule.ruleId,rule])??[]);
 const rank={notice:0,warning:1,critical:2};
 const byField=new Map<string,Extract<PlanningCheckRuleDto,{kind:'presence'}>[]>();
 for(const rule of config?.rules??[])if(rule.kind==='presence'&&rule.enabled&&results.get(rule.id)?.state==='warning'){const rows=byField.get(rule.fieldId)??[];rows.push(rule);byField.set(rule.fieldId,rows);}
 for(const rows of byField.values())rows.sort((a,b)=>rank[b.severity]-rank[a.severity]);
 return(taskId,fieldId,fieldName)=>{if(!config?.enabled||!assessment?.enabled)return null;const flag=flags.get(taskId);if(!flag?.missingFieldIds.includes(fieldId))return null;const rule=byField.get(fieldId)?.find(row=>flag.missingRuleIds.includes(row.id));return rule?{state:'missing',severity:rule.severity,color:rule.color,label:t('planningChecks.missingField',{field:fieldName})}:null;};
}
export function planningFieldAdvisory(config:PlanningCheckConfigDto|undefined,assessment:PlanningCheckAssessmentDto|undefined,taskId:string,fieldId:string,fieldName:string):FieldAdvisory|null{return createPlanningFieldAdvisory(config,assessment)(taskId,fieldId,fieldName);}
