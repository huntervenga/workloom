import { expect, it } from 'vitest';
import { summaryTemplateContentSchema, type PlanningCheckRuleDto, type GenericHeaderWidgetDto, type SummaryTemplateContentDto } from '@workloom/contracts';
import { contentNeedsPerson, initialTemplateContent, initialTemplatePerson, keyedTemplateOverrides, portableBalance, portableWidget } from './model';
const person='10000000-0000-4000-8000-000000000001',field='10000000-0000-4000-8000-000000000002';
const group={kind:'section' as const,sectionId:null};
const base:SummaryTemplateContentDto={widgets:[{key:'plan',kind:'measure',measure:{key:'plan',operation:'sum',fieldId:field}},{key:'available',kind:'capacity'}],balanceChecks:[],taskScope:'group',period:{kind:'project_dates'}};
it('parameterizes personal effort and capacity identities without retaining concrete people',()=>{
 const effort:GenericHeaderWidgetDto={key:'effort',kind:'personal_effort',fieldId:field,membershipId:person};
 expect(portableWidget(effort)).toEqual({key:'effort',kind:'personal_effort',fieldId:field});
 expect(contentNeedsPerson({...base,widgets:[portableWidget(effort)]})).toBe(true);
 expect(initialTemplatePerson([effort],group)).toEqual({kind:'selected',membershipId:person});
});
it('preserves selected-person task scope and the saved capacity range during conversion',()=>{
 const widgets:GenericHeaderWidgetDto[]=[{key:'available',kind:'capacity',membershipId:person,range:{kind:'dates',from:'2026-10-01',to:'2026-10-20'}}];
 const converted=initialTemplateContent(widgets,[],group,{kind:'selected_person_project',membershipId:person});
 expect(converted.taskScope).toBe('selected_person_project');expect(converted.period).toEqual(widgets[0]?.kind==='capacity'?widgets[0].range:null);
 expect(initialTemplatePerson(widgets,group,{kind:'selected_person_project',membershipId:person})).toEqual({kind:'selected',membershipId:person});
});
it('a local manual target does not pin an unrelated inherited widget',()=>{
 const customized={...base,widgets:base.widgets.map(widget=>widget.kind==='capacity'?{...widget,override:{minutes:120}}:widget)};
 const overrides=keyedTemplateOverrides(base,customized);
 expect(overrides).toEqual({widgets:[{key:'available',kind:'capacity',override:{minutes:120}}]});
 const updated={...base,widgets:base.widgets.map(widget=>widget.kind==='measure'?{...widget,measure:{...widget.measure,operation:'max' as const}}:widget)};
 const resolved=updated.widgets.map(widget=>overrides?.widgets?.find(local=>local.key===widget.key)??widget);
 expect(resolved[0]).toMatchObject({measure:{operation:'max'}});expect(resolved[1]).toMatchObject({override:{minutes:120}});
});
it('cannot represent local structural removal as a silent keyed replacement',()=>{expect(keyedTemplateOverrides(base,{...base,widgets:base.widgets.slice(1)})).toBeNull();expect(keyedTemplateOverrides(base,base)).toEqual({});});

it('turns a detached concrete personal balance back into a portable template without pinning its member',()=>{
 const rule:Extract<PlanningCheckRuleDto,{kind:'balance'}>={id:'10000000-0000-4000-8000-000000000003',name:'Detached personal effort',kind:'balance',enabled:true,hierarchy:'all_tasks',filters:{statusGroups:[],tagIds:[],assignee:{kind:'all'},dateRange:null},group,taskScope:{kind:'selected_person_project',membershipId:person},membershipId:person,source:'personal_effort',sumFieldId:field,cohort:{kind:'all_tasks'},missingPlan:'unknown',target:{kind:'capacity',membershipId:person,range:{kind:'dates',from:'2026-10-01',to:'2026-10-20'},basis:'computed'},under:{enabled:true,thresholdBps:9000,fullIntensityAtBps:5000,nearColor:'#fde68a',farColor:'#dc2626'},over:{enabled:true,thresholdBps:10000,fullIntensityAtBps:15000,nearColor:'#fecaca',farColor:'#b91c1c'}};
 const before=structuredClone(rule),portable=portableBalance(rule);
 expect(portable).not.toHaveProperty('membershipId');expect(portable).not.toHaveProperty('group');expect(portable).not.toHaveProperty('taskScope');expect(portable.target).toEqual({kind:'capacity',basis:'computed'});
 const converted=initialTemplateContent([], [rule],group,{kind:'selected_person_project',membershipId:person});
 expect(summaryTemplateContentSchema.safeParse(converted).success).toBe(true);expect(converted.balanceChecks).toEqual([portable]);expect(converted.period).toEqual({kind:'dates',from:'2026-10-01',to:'2026-10-20'});expect(contentNeedsPerson(converted)).toBe(true);expect(rule).toEqual(before);
});
