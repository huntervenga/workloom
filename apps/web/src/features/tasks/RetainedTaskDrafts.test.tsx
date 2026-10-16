import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppRoutes } from '../../app/AppRoutes';
import { SessionProvider } from '../../app/session';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { createQueryClient } from '../../lib/queryClient';
import { protectedDraftsFor } from '../../lib/protectedDrafts';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { installFakeApi, ok, type RouteTable } from '../../test/fakeApi';
import { lostResponse } from '../planning/test/fixtures';
import { rootPath, task, tablePath, tableRoutes } from '../../features/work-categories/test/fixtures';
beforeAll(async()=>{await import('../../routes/ProjectPage');});
const PARENT='f2000000-0000-4000-8000-000000000010';
const parent={...task,id:PARENT,title:'Pristine parent'};
const child={...task,parentTaskId:PARENT,title:'Actual child'};
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function unload(){const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;}
function setup(initialPath=`${tablePath}?task=${task.id}`, extra:RouteTable={}){const api=installFakeApi({...tableRoutes(),[`GET ${rootPath}/tasks`]:()=>ok([child,parent]),[`GET ${rootPath}/tasks/${task.id}`]:()=>ok(child),[`GET ${rootPath}/tasks/${PARENT}`]:()=>ok(parent),...extra});const client=createQueryClient({retry:false});const router=createMemoryRouter([{path:'*',element:<SessionProvider><ProtectedNavigationGuard/><AppRoutes/></SessionProvider>}],{initialEntries:[initialPath]});const ui=render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);cleanups.push(()=>{ui.unmount();router.dispose();client.clear();});return{...ui,...api,client,router,user:userEvent.setup({pointerEventsCheck:0})};}
describe('actual ordinary retained draft protection',()=>{
 it('protects a dirty edit after drawer Close, while the real retained draft remains resumable',async()=>{
  const ui=setup();const name=await screen.findByLabelText('Task name');expect(unload()).toBe(false);fireEvent.change(name,{target:{value:'Unsaved real ordinary edit'}});expect(unload()).toBe(true);
  await ui.user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await ui.user.click(screen.getByRole('button',{name:'Resume original editor'}));expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Unsaved real ordinary edit');
  await ui.user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const afterClose={beforeUnload:unload(),draftRegistry:protectedDraftsFor(ui.client).protecting,commandRegistry:protectedCommandsFor(ui.client).protecting};
  await act(async()=>{await ui.router.navigate('/outside-repro');});
  expect(afterClose).toEqual({beforeUnload:true,draftRegistry:true,commandRegistry:false});
  const guard=await screen.findByRole('dialog',{name:'Leave this page?'});expect(guard).toHaveTextContent('unsaved');expect(guard).not.toHaveTextContent('The server may have saved');
  expect(ui.router.state.location.pathname).toBe(tablePath);await ui.user.click(within(guard).getByRole('button',{name:'Stay'}));
  await ui.user.click(screen.getByRole('button',{name:'Resume original editor'}));expect(within(await screen.findByRole('dialog')).getByLabelText('Task name')).toHaveValue('Unsaved real ordinary edit');
  expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
 });
 it('protects the hidden dirty child after Open parent even though the currently mounted parent is clean',async()=>{
  const ui=setup();fireEvent.change(await screen.findByLabelText('Description'),{target:{value:'Hidden real rich child text'}});expect(unload()).toBe(true);
  await ui.user.click(screen.getByRole('button',{name:'Open parent'}));expect(await screen.findByDisplayValue(parent.title)).toBeVisible();
  const onParent={beforeUnload:unload(),draftRegistry:protectedDraftsFor(ui.client).protecting,commandRegistry:protectedCommandsFor(ui.client).protecting};
  await act(async()=>{await ui.router.navigate('/outside-repro');});
  expect(onParent).toEqual({beforeUnload:true,draftRegistry:true,commandRegistry:false});expect(ui.router.state.location.pathname).toBe(tablePath);await screen.findByRole('dialog',{name:'Leave this page?'});expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
 });
 it('protects an unsaved child create after Back to parent without claiming a command was sent',async()=>{
  const ui=setup();await ui.user.click(await screen.findByRole('button',{name:'Add subtask'}));fireEvent.change(await screen.findByLabelText('Task name'),{target:{value:'Hidden real new child'}});expect(unload()).toBe(true);
  await ui.user.click(screen.getByRole('button',{name:'Back to parent'}));expect(await screen.findByDisplayValue(child.title)).toBeVisible();
  const onParent={beforeUnload:unload(),draftRegistry:protectedDraftsFor(ui.client).protecting,commandRegistry:protectedCommandsFor(ui.client).protecting};
  await act(async()=>{await ui.router.navigate('/outside-repro');});
  expect(onParent).toEqual({beforeUnload:true,draftRegistry:true,commandRegistry:false});expect(ui.router.state.location.pathname).toBe(tablePath);await screen.findByRole('dialog',{name:'Leave this page?'});expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
 });
});


it('does not warn after clean quick creation opens More details in its original section', async () => {
 const sectionId='e1000000-0000-4000-8000-000000000007';
 const ui=setup(tablePath,{[`GET ${rootPath}/projects/${task.projectId}/sections`]:()=>ok([{id:sectionId,workspaceId:task.workspaceId,projectId:task.projectId,name:'Original section',position:0,revision:1,archivedAt:null}])});
 await ui.user.click(await screen.findByRole('button',{name:'Add task to “Original section”'}));expect(unload()).toBe(false);expect(protectedDraftsFor(ui.client).protecting).toBe(false);
 await ui.user.click(screen.getByRole('button',{name:'More details'}));const dialog=await screen.findByRole('dialog',{name:'New task'});
 const toggle=within(dialog).getByText('More details',{selector:'summary'});await ui.user.click(toggle);
 expect(within(dialog).getByRole('combobox',{name:'Section'})).toHaveTextContent('Original section');expect(unload()).toBe(false);expect(protectedDraftsFor(ui.client).protecting).toBe(false);
 await ui.user.keyboard('{Escape}');await act(async()=>{await ui.router.navigate('/outside-repro');});expect(ui.router.state.location.pathname).toBe('/outside-repro');expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
});

it('protects an explicit status-only new-task choice even while its title is still empty', async () => {
 const other='f6000000-0000-4000-8000-000000000008';
 const ui=setup(tablePath,{[`GET ${rootPath}/projects/${task.projectId}/statuses`]:()=>ok([{id:task.statusId,workspaceId:task.workspaceId,projectId:task.projectId,name:'Original status',group:'todo',position:0,revision:1},{id:other,workspaceId:task.workspaceId,projectId:task.projectId,name:'Chosen status',group:'in_progress',position:1,revision:1}])});
 await ui.user.click(await screen.findByRole('button',{name:'Add task'}));await ui.user.click(screen.getByRole('button',{name:'More details'}));await screen.findByRole('dialog',{name:'New task'});
 await ui.user.click(screen.getByRole('combobox',{name:'Status'}));await ui.user.click(screen.getByRole('option',{name:'Chosen status'}));expect(screen.getByLabelText('Task name')).toHaveValue('');await ui.user.keyboard('{Escape}');await waitFor(()=>expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
 expect(unload()).toBe(true);expect(protectedCommandsFor(ui.client).protecting).toBe(false);
 await act(async()=>{await ui.router.navigate('/outside-repro');});const guard=await screen.findByRole('dialog',{name:'Leave this page?'});await ui.user.click(within(guard).getByRole('button',{name:'Stay'}));
 await ui.user.click(screen.getByRole('button',{name:'Resume original editor'}));expect(await screen.findByRole('combobox',{name:'Status'})).toHaveTextContent('Chosen status');expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
});

it('releases a reverted or explicitly discarded draft and disposes protection after explicit departure', async () => {
 const ui=setup();const name=await screen.findByLabelText('Task name');fireEvent.change(name,{target:{value:'Temporary edit'}});expect(unload()).toBe(true);
 fireEvent.change(name,{target:{value:child.title}});expect(unload()).toBe(false);expect(protectedDraftsFor(ui.client).protecting).toBe(false);
 fireEvent.change(name,{target:{value:'Kept until discarded'}});await ui.user.keyboard('{Escape}');await ui.user.click(screen.getByRole('button',{name:'Resume original editor'}));
 await ui.user.click(await screen.findByRole('button',{name:'Discard draft'}));expect(screen.getByLabelText('Task name')).toHaveValue(child.title);expect(unload()).toBe(false);
 fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Explicitly leaving this draft'}});await ui.user.keyboard('{Escape}');
 await act(async()=>{await ui.router.navigate('/outside-repro');});await ui.user.click(within(await screen.findByRole('dialog',{name:'Leave this page?'})).getByRole('button',{name:'Leave without saving'}));
 await waitFor(()=>expect(ui.router.state.location.pathname).toBe('/outside-repro'));expect(protectedDraftsFor(ui.client).protecting).toBe(false);expect(unload()).toBe(false);expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
});


it('protects an actual collapsed inline title draft without claiming a write was sent', async () => {
 const ui=setup(tablePath);await ui.user.click(await screen.findByRole('button',{name:child.title}));
 fireEvent.change(screen.getByLabelText('Task name'),{target:{value:'Collapsed actual inline title'}});await ui.user.keyboard('{Escape}');expect(unload()).toBe(true);expect(protectedCommandsFor(ui.client).protecting).toBe(false);
 await act(async()=>{await ui.router.navigate('/outside-repro');});const guard=await screen.findByRole('dialog',{name:'Leave this page?'});expect(guard).toHaveTextContent('You have an unsaved draft');await ui.user.click(within(guard).getByRole('button',{name:'Stay'}));
 await ui.user.click(screen.getByRole('button',{name:'Resume original editor'}));expect(await screen.findByLabelText('Task name')).toHaveValue('Collapsed actual inline title');expect(ui.calls.filter(c=>c.method!=='GET')).toHaveLength(0);
});

it('keeps actual pending/unknown task writes in the existing command registry and clears only after exact confirmation', async () => {
 const gate=lostResponse();let current=child;let attempts=0;
 const ui=setup(`${tablePath}?task=${task.id}`,{[`GET ${rootPath}/tasks/${task.id}`]:()=>ok(current),[`PATCH ${rootPath}/tasks/${task.id}`]:()=>++attempts===1?gate.promise:ok(current={...child,title:'Confirmed ordinary task',revision:2})});
 fireEvent.change(await screen.findByLabelText('Task name'),{target:{value:'Confirmed ordinary task'}});await ui.user.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(attempts).toBe(1));
 await ui.user.keyboard('{Escape}');expect(protectedCommandsFor(ui.client).protecting).toBe(true);expect(unload()).toBe(true);
 await act(async()=>{await ui.router.navigate('/outside-repro');});let guard=await screen.findByRole('dialog',{name:'Leave this page?'});expect(guard).toHaveTextContent('The server may have saved');await ui.user.click(within(guard).getByRole('button',{name:'Stay'}));
 await act(async()=>gate.lose());await screen.findByText('A task command is unconfirmed. Its original values and key are kept.');expect(protectedCommandsFor(ui.client).protecting).toBe(true);
 await act(async()=>{await ui.router.navigate('/outside-repro');});guard=await screen.findByRole('dialog',{name:'Leave this page?'});expect(guard).toHaveTextContent('The server may have saved');await ui.user.click(within(guard).getByRole('button',{name:'Stay'}));
 await ui.user.click(screen.getByRole('button',{name:'Resume original editor'}));await ui.user.click(await screen.findByRole('button',{name:'Retry submission'}));await waitFor(()=>expect(protectedCommandsFor(ui.client).protecting).toBe(false));await waitFor(()=>expect(unload()).toBe(false));
 const writes=ui.calls.filter(c=>c.method==='PATCH');expect(writes).toHaveLength(2);expect(writes[1]?.body).toEqual(writes[0]?.body);expect(writes[0]?.headers.get('Idempotency-Key')).toBeTruthy();expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
});
