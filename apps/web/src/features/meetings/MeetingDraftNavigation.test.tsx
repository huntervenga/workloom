import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ProtectedNavigationGuard } from '../../app/ProtectedNavigationGuard';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, alphaMembers, anna } from '../../test/fakeApi';
import { period, PROJECT_ID, task } from '../planning/test/fixtures';
import { CreateMeetingDialog } from './CreateMeetingDialog';
import { useMeetingWorkspace } from './useMeetingWorkspace';
function Page() {
 const controller=useMeetingWorkspace(anna.id,alpha.id,PROJECT_ID);const [mounted,setMounted]=useState(true);
 return <><h1>Встречи</h1><button onClick={()=>{setMounted(true);controller.setCreateOpen(true);}}>Открыть форму</button><button onClick={()=>setMounted(false)}>Убрать компонент формы</button><Link to="/elsewhere">Уйти</Link>{mounted?<CreateMeetingDialog controller={controller} members={alphaMembers} periods={[period()]} statuses={[{id:task.statusId,workspaceId:alpha.id,projectId:PROJECT_ID,name:'План',group:'todo',position:0,revision:1}]} sections={[]} ownMembershipId={alphaMembers[0]?.id??''} timezone="Europe/Berlin" onCreated={()=>undefined}/>:null}</>;
}
function topClose(dialog:HTMLElement):HTMLElement {const found=within(dialog).getAllByRole('button',{name:'Закрыть'}).find(b=>b.hasAttribute('aria-label'));if(!found)throw new Error('No close');return found;}
describe('page-owned unsent meeting drafts',()=>{
 it('protects actual typed data on SPA departure and unload, survives form unmount, and clears only on explicit discard',async()=>{
  const client=createQueryClient({retry:false});const router=createMemoryRouter([{element:<><ProtectedNavigationGuard/><Outlet/></>,children:[{path:'/',element:<Page/>},{path:'/elsewhere',element:<h1>Другая страница</h1>}]}]);const user=userEvent.setup({pointerEventsCheck:0});render(<QueryClientProvider client={client}><RouterProvider router={router}/></QueryClientProvider>);
  await user.click(screen.getByRole('button',{name:'Открыть форму'}));let dialog=await screen.findByRole('dialog',{name:'Новая встреча'});await user.type(within(dialog).getByLabelText('Название встречи'),'Мой несохранённый замысел');await user.click(topClose(dialog));
  const unload=new Event('beforeunload',{cancelable:true});window.dispatchEvent(unload);expect(unload.defaultPrevented).toBe(true);
  await user.click(screen.getByRole('link',{name:'Уйти'}));dialog=await screen.findByRole('dialog',{name:'Уйти со страницы?'});expect(within(dialog).getByText(/несохранённые данные будут потеряны/)).toBeInTheDocument();expect(within(dialog).queryByText(/Сервер мог уже сохранить/)).not.toBeInTheDocument();await user.click(within(dialog).getByRole('button',{name:'Остаться'}));
  await user.click(screen.getByRole('button',{name:'Убрать компонент формы'}));await user.click(screen.getByRole('button',{name:'Открыть форму'}));dialog=await screen.findByRole('dialog',{name:'Новая встреча'});expect(within(dialog).getByLabelText('Название встречи')).toHaveValue('Мой несохранённый замысел');await user.click(within(dialog).getByRole('button',{name:'Сбросить черновик'}));expect(within(dialog).getByLabelText('Название встречи')).toHaveValue('');await user.click(topClose(dialog));const clean=new Event('beforeunload',{cancelable:true});window.dispatchEvent(clean);expect(clean.defaultPrevented).toBe(false);await user.click(screen.getByRole('link',{name:'Уйти'}));expect(await screen.findByRole('heading',{name:'Другая страница'})).toBeInTheDocument();
 });
});
