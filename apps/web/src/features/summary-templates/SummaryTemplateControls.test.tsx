import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { alpha, alphaMembers, anna, failure, installFakeApi, ok } from '../../test/fakeApi';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { queryKeys } from '../../lib/queryKeys';
import { HeaderWidgets } from '../generic-reports/HeaderWidgets';
import { fact, plan, PROJECT_ID } from '../generic-reports/test/fixtures';
import { useSummaryTemplateWorkspace } from './queries';
const group={kind:'section' as const,sectionId:null},version='a'.repeat(64),catalog={templates:[],bindings:[],aggregateRevision:2,checksRevision:0,sourceVersion:version};
const templateId='10000000-0000-4000-8000-000000000001',bindingId='10000000-0000-4000-8000-000000000002',stamp='2026-10-20T00:00:00.000Z';
const content={widgets:[{key:'plan',kind:'measure' as const,measure:{key:'plan',operation:'sum' as const,fieldId:plan.id}}],balanceChecks:[],taskScope:'group' as const,period:{kind:'project_dates' as const}};
const linkedCatalog={...catalog,templates:[{id:templateId,workspaceId:alpha.id,projectId:PROJECT_ID,name:'Personal delivery',revision:1,content,createdAt:stamp,updatedAt:stamp}],bindings:[{id:bindingId,workspaceId:alpha.id,projectId:PROJECT_ID,group,templateId,revision:1,templateRevision:1,person:null,overrides:{},ruleIds:{},resolved:{widgets:content.widgets,balanceChecks:[]},detached:false}]};
const path=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/summary-templates`;
function setup(uncertain=false,linked=false,pending=false){
 let attempts=0;let release:(response:Response)=>void=()=>undefined;const pendingAnswer=new Promise<Response>(resolve=>{release=resolve;});const currentCatalog=linked?linkedCatalog:catalog;const api=installFakeApi({[`GET ${path}`]:()=>ok(currentCatalog),[`POST ${path}`]:()=>{attempts++;return pending?pendingAnswer:uncertain&&attempts===1?failure(503,'UNAVAILABLE','Synthetic held command'):ok(currentCatalog);}}),client=new QueryClient({defaultOptions:{queries:{retry:false}}}),save=vi.fn();client.setQueryData(queryKeys.me,{actor:anna});
 function Example(){const controller=useSummaryTemplateWorkspace(anna.id,alpha.id,PROJECT_ID,true);return <HeaderWidgets templateController={controller} group={group} title="Delivery" rules={[]} result={undefined} fields={[plan,fact]} members={alphaMembers} workspaceId={alpha.id} writable disabled={false} loading={false} revision={2} feedback={null} uncertain={false} projectDateRange={null} onRetry={()=>undefined} onSave={save}/>;}
 render(<QueryClientProvider client={client}><MemoryRouter><Example/></MemoryRouter></QueryClientProvider>);return{user:userEvent.setup(),api,client,save,release};
}
async function open(user:ReturnType<typeof userEvent.setup>){await user.click(screen.getByRole('button',{name:'Configure summary for Delivery'}));await waitFor(()=>expect(screen.getByRole('button',{name:/Save as template|Edit template for all/})).toBeEnabled());return screen.getByRole('dialog',{name:'Summary · Delivery'});}
it('opening and closing a clean summary does not create a template or dirty draft',async()=>{const{user,api,client}=setup(),dialog=await open(user);expect(protectedDraftsFor(client).protecting).toBe(false);await user.click(within(dialog).getByRole('button',{name:'Discard changes'}));expect(api.calls.filter(call=>call.method!=='GET')).toHaveLength(0);expect(protectedDraftsFor(client).protecting).toBe(false);});
it('Save as template includes the active widget form without requiring Add and retries its exact body/key',async()=>{const{user,api,save}=setup(true),dialog=await open(user);await user.click(within(dialog).getByRole('combobox',{name:'Field'}));await user.click(screen.getByRole('option',{name:'Budget'}));await user.click(within(dialog).getByRole('button',{name:'Save as template'}));await user.type(within(dialog).getByLabelText('Template name'),'Personal delivery');await user.click(within(dialog).getByRole('button',{name:'Save template settings'}));await screen.findByRole('button',{name:'Retry the original template command'});const first=api.calls.filter(call=>call.method==='POST')[0];expect(first?.body).toMatchObject({expectedSourceVersion:version,name:'Personal delivery',content:{widgets:[{kind:'measure',measure:{operation:'sum',fieldId:plan.id}}]},bind:{group,person:null}});expect(save).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Retry the original template command'}));await waitFor(()=>expect(screen.queryByRole('dialog',{name:'Summary · Delivery'})).not.toBeInTheDocument());const writes=api.calls.filter(call=>call.method==='POST');expect(writes).toHaveLength(2);expect(writes[1]?.body).toEqual(writes[0]?.body);expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));});

it.each(['Escape','Close'] as const)('keeps a changed Edit template for all draft on outer %s until explicit discard',async(closeAction)=>{
 const{user,api,client}=setup(false,true),dialog=await open(user);
 await user.click(within(dialog).getByRole('button',{name:'Edit template for all'}));
 const name=within(dialog).getByLabelText('Template name');await user.clear(name);await user.type(name,'Changed for all');
 expect(protectedDraftsFor(client).protecting).toBe(true);
 if(closeAction==='Escape')await user.keyboard('{Escape}');else await user.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(dialog).toBeVisible();expect(name).toHaveValue('Changed for all');expect(within(dialog).getByRole('alert')).toHaveTextContent('Discard unsaved summary and template changes?');
 await user.click(within(dialog).getByRole('button',{name:'Keep editing template'}));expect(name).toHaveValue('Changed for all');expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
 await user.keyboard('{Escape}');await user.click(within(dialog).getByRole('button',{name:'Discard template changes'}));
 expect(screen.queryByRole('dialog',{name:'Summary · Delivery'})).not.toBeInTheDocument();expect(api.calls.filter(call=>call.method!=='GET')).toHaveLength(0);expect(protectedDraftsFor(client).protecting).toBe(false);
});
it('keeps a new Save as template name through X and Cancel, then explicitly discards',async()=>{
 const{user,api}=setup(),dialog=await open(user);await user.click(within(dialog).getByRole('button',{name:'Save as template'}));
 await user.type(within(dialog).getByLabelText('Template name'),'Unsaved template');await user.click(within(dialog).getByRole('button',{name:'Close'}));
 expect(dialog).toBeVisible();await user.click(within(dialog).getByRole('button',{name:'Keep editing template'}));expect(within(dialog).getByLabelText('Template name')).toHaveValue('Unsaved template');
 await user.keyboard('{Escape}');await user.click(within(dialog).getByRole('button',{name:'Discard template changes'}));expect(screen.queryByRole('dialog',{name:'Summary · Delivery'})).not.toBeInTheDocument();expect(api.calls.filter(call=>call.method!=='GET')).toHaveLength(0);
});
it.each([false,true])('closes an untouched nested editor immediately (linked=%s)',async(linked)=>{
 const{user,api,client}=setup(false,linked),dialog=await open(user);await user.click(within(dialog).getByRole('button',{name:linked?'Edit template for all':'Save as template'}));expect(protectedDraftsFor(client).protecting).toBe(false);
 await user.keyboard('{Escape}');expect(screen.queryByRole('dialog',{name:'Summary · Delivery'})).not.toBeInTheDocument();expect(api.calls.filter(call=>call.method!=='GET')).toHaveLength(0);
});
it('keeps a pending template command visible on X and an unknown original retry accessible on Escape',async()=>{
 const{user,release,api}=setup(false,false,true),dialog=await open(user);await user.click(within(dialog).getByRole('button',{name:'Save as template'}));await user.type(within(dialog).getByLabelText('Template name'),'Pending template');await user.click(within(dialog).getByRole('button',{name:'Save template settings'}));
 await waitFor(()=>expect(api.calls.filter(call=>call.method==='POST')).toHaveLength(1));await user.click(within(dialog).getByRole('button',{name:'Close'}));expect(dialog).toBeVisible();expect(within(dialog).getByRole('alert')).toHaveTextContent('This summary command is still unresolved.');expect(within(dialog).queryByRole('button',{name:'Discard template changes'})).not.toBeInTheDocument();
 release(failure(503,'UNAVAILABLE','Synthetic held outcome'));await screen.findByRole('button',{name:'Retry the original template command'});await user.keyboard('{Escape}');expect(dialog).toBeVisible();expect(within(dialog).getByRole('button',{name:'Retry the original template command'})).toBeEnabled();expect(api.calls.filter(call=>call.method==='POST')).toHaveLength(1);
});
