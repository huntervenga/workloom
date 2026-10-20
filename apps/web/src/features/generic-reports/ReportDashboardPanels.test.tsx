import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReportDashboardPanels } from './ReportDashboardPanels';
import { renderFieldUi, field } from '../fields/test/fixtures';
import { alpha, anna, alphaMembers, installFakeApi, failure, ok } from '../../test/fakeApi';
import { definition, result, rootPath, PROJECT_ID } from './test/fixtures';
import type { GenericReportConfig } from '@workloom/contracts';
describe('authoritative secondary report breakdowns',()=>{
 it('preserves task filters and one canonical task source while omitting unrelated private capacity reads',async()=>{
  const original=result(),category=field('Work type','single_select','90000000-0000-4000-8000-000000000033'),config:GenericReportConfig={...definition().config,groupBy:{kind:'category',fieldId:category.id},capacity:{startDate:'2026-10-01',endDate:'2026-10-31',people:{kind:'selected',membershipIds:['99999999-9999-4999-8999-999999999999']}}};
  const {calls}=installFakeApi({[`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]:request=>ok({...original,reportId:null,definitionRevision:null,config:(request.body as {config:GenericReportConfig}).config,groups:[{key:alphaMembers[0]?.id??'unassigned',label:'Person',taskCount:63,measures:original.measures,comparison:original.comparison,initialComparison:null}]})});
  const callback=vi.fn();renderFieldUi(<ReportDashboardPanels actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} result={{...original,config,fields:[...original.fields,category]}} members={alphaMembers} sections={[]} fields={[category]} disabled onPersonSelect={callback}/>);
  await screen.findByRole('region',{name:'Plan and actual by primary assignee'});await waitFor(()=>expect(calls).toHaveLength(3));
  expect(calls[0]?.body).toMatchObject({config:{projectId:PROJECT_ID,filters:config.filters,groupBy:{kind:'assignee'}},offset:0,limit:1});
  expect((calls[0]?.body as {config:GenericReportConfig}).config.capacity).toBeUndefined();
  expect(screen.queryByRole('button',{name:/Show tasks for/})).not.toBeInTheDocument();
  expect(original.rows).toHaveLength(1);expect(screen.getByText('Paired coverage: 7 of 8 eligible tasks in the full scope.')).toBeVisible();expect(callback).not.toHaveBeenCalled();
 });
});

it('unifies full Plan and Actual, working capacity including a person without tasks, category and task-status panels',async()=>{
 const base=result(),person=alphaMembers[0],idle=alphaMembers[1];if(!person||!idle)throw Error('Expected two members');
 const category=field('Focus area','single_select','90000000-0000-4000-8000-000000000033');
 const comparison=base.config.comparison;if(!comparison)throw Error('Expected comparison');
 const measure=(key:string,fieldId:string,minutes:number)=>({key,fieldId,operation:'sum' as const,unit:'minutes' as const,value:{numerator:String(minutes),denominator:'1',decimal:String(minutes)},coverage:{tasks:2,filled:2,missing:0,null:0,zero:0}});
 const sums=[measure('budget',comparison.planFieldId,600),measure('actual',comparison.factFieldId,480)];
 const config:GenericReportConfig={...base.config,groupBy:{kind:'assignee'},measures:[{key:'budget',operation:'sum',fieldId:comparison.planFieldId},{key:'actual',operation:'sum',fieldId:comparison.factFieldId}],capacity:{startDate:'2026-10-12',endDate:'2026-10-18',people:{kind:'all_active'}}};
 const capacity={startDate:'2026-10-12',endDate:'2026-10-18',settingsConfigured:true,sourceVersion:'c'.repeat(64),days:[],intervals:[],companyHolidays:[],inputVersions:{settingsRevision:1,profiles:[],requests:[]},totals:{scheduledMinutes:4800,holidayMinutes:0,absenceMinutes:480,availableMinutes:4320,unconfiguredMembers:0},members:[{membershipId:person.id,displayName:person.displayName,scheduleKnown:true,scheduledMinutes:2400,holidayMinutes:0,absenceMinutes:480,availableMinutes:1920},{membershipId:idle.id,displayName:idle.displayName,scheduleKnown:true,scheduledMinutes:2400,holidayMinutes:0,absenceMinutes:0,availableMinutes:2400}]};
 installFakeApi({[`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]:request=>{const requested=(request.body as {config:GenericReportConfig}).config;return ok({...base,fields:[...base.fields,category],config:requested,totalTasks:2,measures:sums,groups:[{key:requested.groupBy.kind==='status'?'done':'uncategorized',label:'Group',taskCount:2,measures:sums,comparison:base.comparison,initialComparison:null}]});}});
 renderFieldUi(<ReportDashboardPanels actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} result={{...base,config,capacity,measures:sums,totalTasks:2,groups:[{key:person.id,label:person.displayName,taskCount:2,measures:sums,comparison:base.comparison,initialComparison:null}]}} members={alphaMembers} sections={[]} fields={[category]} disabled={false} onPersonSelect={vi.fn()}/>);
 await screen.findByRole('region',{name:'Distribution by Focus area'});
 expect(screen.getByRole('article',{name:'Available capacity'})).toHaveTextContent('72h');
 expect(screen.getByRole('article',{name:'Plan · Budget'})).toHaveTextContent('10h');
 expect(screen.getByRole('article',{name:'Actual · Spent'})).toHaveTextContent('8h');
 const row=screen.getByRole('row',{name:`${person.displayName} · Available: 32h · Plan: 10h · Actual: 8h`});expect(row.querySelector('[data-series="capacity"]')).toBeInTheDocument();
 expect(screen.getByRole('row',{name:`${idle.displayName} · Available: 40h · Plan: — · Actual: —`})).toHaveTextContent('0 tasks');
 expect(screen.getByRole('region',{name:'Delivery overview'})).toBeVisible();
});

it('does not reuse cached person groups or cards after a denied people refresh',async()=>{const base=result(),category=field('Focus area','single_select','90000000-0000-4000-8000-000000000033');let denied=false;installFakeApi({[`POST ${rootPath}/projects/${PROJECT_ID}/field-aggregates`]:request=>{const config=(request.body as{config:GenericReportConfig}).config;if(config.groupBy.kind==='assignee'&&denied)return failure(403,'FORBIDDEN','Denied');return ok({...base,config,fields:[...base.fields,category],groups:config.groupBy.kind==='assignee'?[{key:alphaMembers[0]?.id??'unassigned',label:'Person',taskCount:63,measures:base.measures,comparison:base.comparison,initialComparison:null}]:[]});}});const view=renderFieldUi(<ReportDashboardPanels actorId={anna.id} workspaceId={alpha.id} projectId={PROJECT_ID} result={{...base,config:{...base.config,groupBy:{kind:'category',fieldId:category.id}}}} members={alphaMembers} sections={[]} fields={[category]} disabled onPersonSelect={vi.fn()}/>);await screen.findByRole('region',{name:'Work types by person'});denied=true;await view.client.invalidateQueries();await waitFor(()=>expect(screen.queryByRole('region',{name:'Work types by person'})).not.toBeInTheDocument());expect(screen.queryByRole('region',{name:'Plan and actual by primary assignee'})).not.toBeInTheDocument();});
