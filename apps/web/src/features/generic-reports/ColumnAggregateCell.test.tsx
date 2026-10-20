import { describe, expect, it } from 'vitest';
import { replaceColumnOperation } from './ColumnAggregateCell';
import { replaceHeaderWidgets, sameWidgetGroup } from './HeaderWidgets';
import { setGenericAggregateSettingsInputSchema, type GenericHeaderWidgetRuleDto, type GenericReportMeasure } from '@workloom/contracts';
const fieldId = '90000000-0000-4000-8000-000000000001';
describe('table aggregate settings preserve independent configuration', () => {
 it('changes or disables the selected calculation without dropping other fields or a second calculation of the same field', () => {
  const measures: GenericReportMeasure[] = [{ key:'planned', operation:'sum',fieldId },{ key:'average',operation:'avg',fieldId },{ key:'tasks',operation:'count_tasks' }];
  expect(replaceColumnOperation(measures,fieldId,'min','planned')).toEqual([{ key:'planned',operation:'min',fieldId },measures[1],measures[2]]);
  expect(replaceColumnOperation(measures,fieldId,null,'planned')).toEqual([measures[1],measures[2]]);
  expect(measures[0]?.operation).toBe('sum');
 });
 it('creates stable field identity bindings without colliding with a preserved existing key', () => {
  const first = replaceColumnOperation([],fieldId,'sum');
  expect(first).toEqual([{key:'col_90000000000040008000000000000001',operation:'sum',fieldId}]);
  expect(setGenericAggregateSettingsInputSchema.parse({expectedRevision:0,measures:first}).measures).toEqual(first);
  const measures: GenericReportMeasure[] = [{key:'col_90000000000040008000000000000001',operation:'count_tasks'}];
  const next = replaceColumnOperation(measures,fieldId,'max');
  expect(next).toEqual([...measures,{key:'col_90000000000040008000000000000001_2',operation:'max',fieldId}]);
  expect(setGenericAggregateSettingsInputSchema.parse({expectedRevision:1,measures:next}).measures).toEqual(next);
 });
 it('editing an independent summary preserves its explicit selected-person project scope',()=>{const group={kind:'section' as const,sectionId:null},taskScope={kind:'selected_person_project' as const,membershipId:fieldId};const rules:GenericHeaderWidgetRuleDto[]=[{group,taskScope,widgets:[{key:'fact',kind:'personal_effort',fieldId,membershipId:fieldId}]}];expect(replaceHeaderWidgets(rules,group,[{key:'fact',kind:'personal_effort',fieldId,membershipId:fieldId}])[0]?.taskScope).toEqual(taskScope);});
 it('matches header summaries only by explicit section or membership IDs and preserves other groups', () => {
  const group = {kind:'section' as const,sectionId:fieldId};
  const rules:GenericHeaderWidgetRuleDto[] = [{group,widgets:[{key:'a',kind:'measure',measure:{key:'sum',operation:'sum',fieldId}}]},{group:{kind:'assignee',membershipId:fieldId},widgets:[{key:'b',kind:'capacity',membershipId:fieldId,range:{kind:'this_week'}}]}];
  expect(sameWidgetGroup(group,{kind:'assignee',membershipId:fieldId})).toBe(false);
  expect(replaceHeaderWidgets(rules,group,[])).toEqual([rules[1]]);
  expect(replaceHeaderWidgets(rules,group,[{key:'c',kind:'capacity',membershipId:fieldId,range:{kind:'dates',from:'2026-10-19',to:'2026-10-25'}}])).toEqual([rules[1],{group,widgets:[{key:'c',kind:'capacity',membershipId:fieldId,range:{kind:'dates',from:'2026-10-19',to:'2026-10-25'}}]}]);
 });
});

describe('header widget explicit project periods and local manual overrides', () => {
 const form={editingKey:null,kind:'capacity',fieldId:'',membershipId:fieldId,operation:'sum' as const,range:'project_dates',from:'',to:'',manual:true,minutes:'1920',note:'Team-specific planned availability'};
 it('binds project dates explicitly and restores automatic calculation by removing only the override', async () => {
  const {headerWidgetFromForm}=await import('./HeaderWidgets');
  expect(headerWidgetFromForm(form,'capacity')).toEqual({key:'capacity',kind:'capacity',membershipId:fieldId,range:{kind:'project_dates'},override:{minutes:1920,note:form.note}});
  expect(headerWidgetFromForm({...form,minutes:'0'},'capacity')).toEqual({key:'capacity',kind:'capacity',membershipId:fieldId,range:{kind:'project_dates'},override:{minutes:0,note:form.note}});
  expect(headerWidgetFromForm({...form,manual:false},'capacity')).toEqual({key:'capacity',kind:'capacity',membershipId:fieldId,range:{kind:'project_dates'}});
 });
 it('rejects invalid manual minutes and overlong explicit periods instead of truncating or falling back to a week', async () => {
  const {headerWidgetFromForm}=await import('./HeaderWidgets');
  expect(headerWidgetFromForm({...form,minutes:'-1'},'capacity')).toBeNull();
  expect(headerWidgetFromForm({...form,minutes:'0.5'},'capacity')).toBeNull();
  expect(headerWidgetFromForm({...form,range:'dates',from:'2026-01-01',to:'2028-01-01'},'capacity')).toBeNull();
  expect(headerWidgetFromForm({...form,manual:false,range:'dates',from:'2026-10-05',to:'2026-10-16'},'capacity')).toEqual({key:'capacity',kind:'capacity',membershipId:fieldId,range:{kind:'dates',from:'2026-10-05',to:'2026-10-16'}});
 });
});
