import { screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { planningCheckAssessmentSchema, planningCheckSettingsSchema, type GenericAggregateSettingsDto, type QueryGenericHeaderWidgetsInput } from '@workloom/contracts';
import { alpha, failure, installFakeApi, ok, renderApp, type RouteTable } from '../../test/fakeApi';
import { PROJECT_ID, definition, plan, result, rootPath, routes, tablePath } from './test/fixtures';
beforeAll(async()=>{await import('../../routes/ProjectPage');});
const settingsPath=`${rootPath}/projects/${PROJECT_ID}/field-aggregate-settings`,totalsPath=`${rootPath}/projects/${PROJECT_ID}/field-aggregates`,headersPath=`${rootPath}/projects/${PROJECT_ID}/header-widgets/query`;
// This suite isolates aggregate recovery; the independent Checks feature starts paused.
function recoveryRoutes(extra:RouteTable):RouteTable {
 const checksPath=`${rootPath}/projects/${PROJECT_ID}/planning-checks`;
 return routes({
  [`GET ${checksPath}/settings`]:()=>ok(planningCheckSettingsSchema.parse({workspaceId:alpha.id,projectId:PROJECT_ID,revision:0,config:{enabled:false,rules:[]}})),
  [`POST ${checksPath}/query`]:()=>ok(planningCheckAssessmentSchema.parse({workspaceId:alpha.id,projectId:PROJECT_ID,settingsRevision:0,sourceVersion:'a'.repeat(64),asOf:'2026-10-20',timezone:alpha.timezone,scope:{kind:'configured_project',placements:'home_tasks',taskCount:1,excludedLinkedTasks:0},enabled:false,summary:{eligibleTasks:0,missingRequiredTasks:0,overdueTasks:0,underplannedGroups:0,overplannedGroups:0,unavailableRules:0},people:[],rules:[],groups:[],taskFlags:[]})),
  ...extra,
 });
}
function settings(revision=2):GenericAggregateSettingsDto{return{workspaceId:alpha.id,projectId:PROJECT_ID,revision,measures:definition().config.measures,headerWidgets:[{group:{kind:'section',sectionId:null},widgets:[{key:'header_budget',kind:'measure',measure:{key:'header_budget',operation:'sum',fieldId:plan.id}}]}]};}
function headerResult(input:QueryGenericHeaderWidgetsInput){return{projectId:PROJECT_ID,settingsRevision:input.expectedSettingsRevision,sourceVersion:'a'.repeat(64),groupBy:input.groupBy,hierarchy:input.hierarchy,filters:input.filters,groups:[{group:{kind:'section',sectionId:null},widgets:[{key:'header_budget',kind:'measure',result:{...result().measures[0],key:'header_budget'},unavailableReason:null}]}]};}
describe('table aggregate read failure recovery',()=>{
 it('shows a reader an explicit footer read failure and retries the full-scope read without writing configuration',async()=>{
  let failed=true;const{calls}=installFakeApi(recoveryRoutes({[`GET ${rootPath}`]:()=>ok({...alpha,role:'viewer'}),[`GET ${settingsPath}`]:()=>ok({...settings(),headerWidgets:[]}),[`POST ${totalsPath}`]:()=>failed?failure(500,'INTERNAL_ERROR','Private backend diagnostic'):ok(result())}));
  const{user}=renderApp(tablePath);const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent('Column totals could not be loaded.');expect(document.querySelector('tfoot')).toHaveTextContent('Unavailable');expect(document.querySelector('tfoot')).not.toHaveTextContent('18h 51m');expect(screen.queryByText('Private backend diagnostic')).not.toBeInTheDocument();failed=false;await user.click(within(alert).getByRole('button',{name:'Retry column totals'}));await waitFor(()=>expect(document.querySelector('tfoot')).toHaveTextContent('18h 51m'));expect(screen.queryByText('Column totals could not be loaded.')).not.toBeInTheDocument();expect(calls.filter(call=>call.path===totalsPath)).toHaveLength(2);expect(calls.some(call=>['PUT','PATCH'].includes(call.method))).toBe(false);
 });
 it('exposes group projection failure to readers and retries without presenting an unknown load as a numeric value',async()=>{
  let failed=true;installFakeApi(recoveryRoutes({[`GET ${rootPath}`]:()=>ok({...alpha,role:'viewer'}),[`GET ${settingsPath}`]:()=>ok(settings()),[`POST ${headersPath}`]:request=>failed?failure(500,'INTERNAL_ERROR','Hidden summary diagnostic'):ok(headerResult(request.body as QueryGenericHeaderWidgetsInput))}));
  const{user}=renderApp(tablePath);const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent('Group summaries could not be loaded.');expect(document.querySelector('[data-task-group-label]')).toHaveTextContent('Unavailable');expect(document.querySelector('[data-task-group-label]')).not.toHaveTextContent('18h 51m');failed=false;await user.click(within(alert).getByRole('button',{name:'Retry group summaries'}));await waitFor(()=>expect(document.querySelector('[data-task-group-label]')).toHaveTextContent('18h 51m'));expect(screen.queryByText('Hidden summary diagnostic')).not.toBeInTheDocument();
 });
 it('refreshes settings after a revision conflict and issues the next header query with the actual new revision',async()=>{
  let current=settings();const revisions:number[]=[];const{calls}=installFakeApi(recoveryRoutes({[`GET ${settingsPath}`]:()=>ok(current),[`POST ${headersPath}`]:request=>{const input=request.body as QueryGenericHeaderWidgetsInput;revisions.push(input.expectedSettingsRevision);if(input.expectedSettingsRevision===2){current=settings(7);return failure(409,'REVISION_CONFLICT','Stale private settings');}return ok(headerResult(input));}}));
  const{user}=renderApp(tablePath);await user.click(await screen.findByRole('button',{name:'Retry group summaries'}));await waitFor(()=>expect(document.querySelector('[data-task-group-label]')).toHaveTextContent('18h 51m'));expect(revisions).toEqual([2,7]);expect(calls.filter(call=>call.method==='GET'&&call.path===settingsPath)).toHaveLength(2);expect(calls.some(call=>['PUT','PATCH'].includes(call.method))).toBe(false);
 });
});
