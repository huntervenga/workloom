import { QueryClientProvider } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenericAggregateSettingsDto, GenericHeaderWidgetsResultDto, QueryGenericAggregatesInput, QueryGenericHeaderWidgetsInput } from '@workloom/contracts';
import { alpha, anna, deferred, failure, installFakeApi, ok, project } from '../../test/fakeApi';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { renderFieldUi } from '../fields/test/fixtures';
import { emptyTaskFilters, type TaskFilterValue } from '../tasks/TaskFilters';
import { useColumnAggregates } from './ColumnAggregates';
import { reportKeys } from './queries';
import { amount, fact, plan, PROJECT_ID, result } from './test/fixtures';
afterEach(()=>vi.unstubAllGlobals());
const group={kind:'no_section' as const,key:'no_section',section:null,sectionId:null,roots:[],taskCount:63};
const saved:GenericAggregateSettingsDto={workspaceId:alpha.id,projectId:PROJECT_ID,revision:2,measures:[{key:'budget',operation:'sum',fieldId:plan.id}],headerWidgets:[{group:{kind:'section',sectionId:null},widgets:[{key:'header_budget',kind:'measure',measure:{key:'header_budget',operation:'sum',fieldId:plan.id}},{key:'header_spent',kind:'measure',measure:{key:'header_spent',operation:'sum',fieldId:fact.id}}]}]};
function totals(input:QueryGenericAggregatesInput,minutes=1131){return{...result(),reportId:null,definitionRevision:null,config:input.config,measures:result().measures.map(measure=>({...measure,value:amount(minutes)}))};}
function headers(input:QueryGenericHeaderWidgetsInput,minutes=1131):GenericHeaderWidgetsResultDto {
 const measure=result().measures[0];if(!measure)throw new Error('Expected fixture measure.');
 return{projectId:PROJECT_ID,settingsRevision:input.expectedSettingsRevision,sourceVersion:'a'.repeat(64),groupBy:input.groupBy,hierarchy:input.hierarchy,filters:input.filters,groups:[{group:{kind:'section',sectionId:null},widgets:[{key:'header_budget',kind:'measure',result:{...measure,key:'header_budget',value:amount(minutes)},unavailableReason:null},{key:'header_spent',kind:'measure',result:{...measure,key:'header_spent',fieldId:fact.id,value:amount(480)},unavailableReason:null}]}]};
}
function example(){
 const client=createQueryClient({retry:false}),prefix=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}`;
 client.setQueryData(queryKeys.me,{actor:anna});client.setQueryData(queryKeys.workspace(anna.id,alpha.id),alpha);client.setQueryData(queryKeys.project(anna.id,alpha.id,PROJECT_ID),project(alpha.id,PROJECT_ID,'Delivery'));
 const settingsRefresh=deferred<Response>(),totalsRefresh=deferred<Response>(),headersRefresh=deferred<Response>();let settingsReads=0,totalReads=0,headerReads=0;let totalInput:QueryGenericAggregatesInput|undefined,headerInput:QueryGenericHeaderWidgetsInput|undefined;
 const api=installFakeApi({[`GET ${prefix}/field-aggregate-settings`]:()=>++settingsReads===1?ok(saved):settingsRefresh.promise.then(response=>response.clone()),[`POST ${prefix}/field-aggregates`]:request=>{totalInput=request.body as QueryGenericAggregatesInput;return++totalReads===1?ok(totals(totalInput)):totalsRefresh.promise.then(response=>response.clone());},[`POST ${prefix}/header-widgets/query`]:request=>{headerInput=request.body as QueryGenericHeaderWidgetsInput;return++headerReads===1?ok(headers(headerInput)):headersRefresh.promise.then(response=>response.clone());}});
 function Harness({filters=emptyTaskFilters,enabled=true}:{filters?:TaskFilterValue;enabled?:boolean}){
  const summary=useColumnAggregates({actorId:anna.id,workspaceId:alpha.id,projectId:PROJECT_ID,fields:[plan,fact],members:[],sections:[],grouping:'section',filters,writable:false,enabled,projectRevision:1});
  return<MemoryRouter><div data-testid="column">{summary.renderColumn(plan.id)}</div><div data-testid="header">{summary.renderGroupMetadata(group)}</div><div data-testid="line">{summary.footer}</div></MemoryRouter>;
 }
 const ui=renderFieldUi(<Harness/>,client);
 return{...ui,api,settingsRefresh,totalsRefresh,headersRefresh,reads:()=>({settings:settingsReads,totals:totalReads,headers:headerReads}),inputs:()=>{if(!totalInput||!headerInput)throw new Error('Expected query inputs.');return{totalInput,headerInput};},rerenderFilters:(filters:TaskFilterValue,enabled=true)=>ui.rerender(<QueryClientProvider client={client}><Harness filters={filters} enabled={enabled}/></QueryClientProvider>)};
}
function expectConfirmed(budget='18h 51m'){
 expect(screen.getByTestId('column')).toHaveTextContent(budget);expect(screen.getByTestId('header')).toHaveTextContent(budget);expect(screen.getByTestId('header')).toHaveTextContent('8h');expect(screen.getByTestId('line')).toHaveTextContent(budget);expect(screen.getByTestId('column')).not.toHaveTextContent('…');expect(screen.getByTestId('header')).not.toHaveTextContent('…');
}
describe('same-scope table summary refresh display',()=>{
 it('retains confirmed numbers during settings and value refresh, then changes only the returned values',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});await waitFor(()=>expect(ui.reads().settings).toBe(2));expectConfirmed();ui.settingsRefresh.resolve(ok(saved));await waitFor(()=>expect(ui.reads().headers).toBeGreaterThanOrEqual(2));expectConfirmed();
  const{totalInput,headerInput}=ui.inputs();ui.totalsRefresh.resolve(ok(totals(totalInput,1140)));ui.headersRefresh.resolve(ok(headers(headerInput,1140)));await waitFor(()=>expectConfirmed('19h'));expect(ui.api.calls.some(call=>['PUT','PATCH'].includes(call.method))).toBe(false);
 });
 it('keeps unchanged summaries after a successful refresh',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});await waitFor(()=>expect(ui.reads().settings).toBe(2));expectConfirmed();ui.settingsRefresh.resolve(ok(saved));await waitFor(()=>expect(ui.reads().headers).toBeGreaterThanOrEqual(2));const{totalInput,headerInput}=ui.inputs();ui.totalsRefresh.resolve(ok(totals(totalInput)));ui.headersRefresh.resolve(ok(headers(headerInput)));await waitFor(()=>expect(ui.client.isFetching({queryKey:reportKeys.root(anna.id,alpha.id)})).toBe(0));expectConfirmed();
 });
 it('removes failed results instead of retaining stale numbers after an error',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});await waitFor(()=>expect(ui.reads().settings).toBe(2));ui.settingsRefresh.resolve(ok(saved));await waitFor(()=>expect(ui.reads().headers).toBeGreaterThanOrEqual(2));expectConfirmed();ui.totalsRefresh.resolve(failure(503,'UNAVAILABLE','Private failure'));ui.headersRefresh.resolve(failure(503,'UNAVAILABLE','Private failure'));await waitFor(()=>expect(screen.getByTestId('column')).toHaveTextContent('Unavailable'));expect(screen.getByTestId('header')).toHaveTextContent('Unavailable');expect(screen.getByTestId('header')).not.toHaveTextContent('18h 51m');expect(screen.getByTestId('line')).not.toHaveTextContent('18h 51m');
 });
 it('hides old-revision headers until the new settings assessment arrives',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());act(()=>ui.client.setQueryData(reportKeys.settings(anna.id,alpha.id,PROJECT_ID),{...saved,revision:3}));await waitFor(()=>expect(ui.reads().headers).toBeGreaterThanOrEqual(2));expect(screen.getByTestId('header')).not.toHaveTextContent('18h 51m');expect(screen.getByTestId('header')).not.toHaveTextContent('8h');const{headerInput}=ui.inputs();ui.headersRefresh.resolve(ok(headers(headerInput)));await waitFor(()=>expect(screen.getByTestId('header')).toHaveTextContent('18h 51m'));
 });
 it('rejects a successful header response carrying the wrong settings revision',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());act(()=>{void ui.client.invalidateQueries({queryKey:reportKeys.root(anna.id,alpha.id)});});await waitFor(()=>expect(ui.reads().settings).toBe(2));ui.settingsRefresh.resolve(ok(saved));await waitFor(()=>expect(ui.reads().headers).toBeGreaterThanOrEqual(2));const{totalInput,headerInput}=ui.inputs();ui.totalsRefresh.resolve(ok(totals(totalInput)));ui.headersRefresh.resolve(ok({...headers(headerInput),settingsRevision:1}));await waitFor(()=>expect(ui.client.isFetching({queryKey:reportKeys.root(anna.id,alpha.id)})).toBe(0));expect(screen.getByTestId('column')).toHaveTextContent('18h 51m');expect(screen.getByTestId('header')).not.toHaveTextContent('18h 51m');expect(screen.getByTestId('header')).not.toHaveTextContent('8h');
 });
 it('does not carry totals into a new filter query or unsupported search',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());ui.rerenderFilters({...emptyTaskFilters,completion:'open'});await waitFor(()=>expect(ui.reads().totals).toBeGreaterThanOrEqual(2));expect(screen.getByTestId('column')).not.toHaveTextContent('18h 51m');expect(screen.getByTestId('header')).not.toHaveTextContent('18h 51m');ui.rerenderFilters({...emptyTaskFilters,search:'Different scope'});expect(screen.getByTestId('column')).not.toHaveTextContent('18h 51m');expect(screen.getByTestId('header')).toBeEmptyDOMElement();
 });
 it('clears all values immediately when authority or feature eligibility is invalidated',async()=>{
  const ui=example();await waitFor(()=>expectConfirmed());act(()=>{void ui.client.invalidateQueries({queryKey:queryKeys.workspace(anna.id,alpha.id),exact:true});});expect(screen.getByTestId('column')).not.toHaveTextContent('18h 51m');expect(screen.getByTestId('header')).toBeEmptyDOMElement();expect(screen.getByTestId('line')).toBeEmptyDOMElement();ui.rerenderFilters(emptyTaskFilters,false);expect(screen.getByTestId('column')).toBeEmptyDOMElement();
 });
});
