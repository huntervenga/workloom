import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { alpha, alphaMembers, anna, failure, installFakeApi } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { plan, fact, PROJECT_ID } from '../generic-reports/test/fixtures';
import type { TaskStatusDto } from '@workloom/contracts';
const statuses:TaskStatusDto[]=[{id:'10000000-0000-4000-8000-000000000020',workspaceId:alpha.id,projectId:PROJECT_ID,name:'To do',group:'todo',position:0,revision:1}];
import { CreateSharedActivityDialog } from './CreateSharedActivityDialog';
import { useSharedActivityWorkspace } from './queries';
const path=`/api/v1/workspaces/${alpha.id}/projects/${PROJECT_ID}/shared-activities`;
function required<T>(value:T|undefined):T{if(value===undefined)throw new Error('Missing fixture');return value;}
const owner=required(alphaMembers.find(member=>member.userId===anna.id));
function setup(initiallyReady:boolean,hold=false){
 let release:(response:Response)=>void=()=>undefined;const pending=new Promise<Response>(resolve=>{release=resolve;});let attempts=0;const api=installFakeApi({[`POST ${path}`]:()=>{attempts++;return hold&&attempts===1?pending:failure(409,'REVISION_CONFLICT','Synthetic known response after validated request');}}),client=new QueryClient({defaultOptions:{queries:{retry:false}}});client.setQueryData(queryKeys.me,{actor:anna});
 function Example({ready}:{ready:boolean}){const controller=useSharedActivityWorkspace(anna.id,alpha.id,PROJECT_ID);return <><button onClick={()=>controller.setCreateOpen(true)}>Open shared activity</button><CreateSharedActivityDialog controller={controller} members={ready?[...alphaMembers]:[]} fields={[plan,fact]} statuses={statuses} sections={[]} ownMembershipId={ready?owner.id:''} writable={ready} onCreated={()=>undefined}/></>;}
 const view=(ready:boolean)=><QueryClientProvider client={client}><Example ready={ready}/></QueryClientProvider>,ui=render(view(initiallyReady));return{...api,release,user:userEvent.setup(),ready:()=>ui.rerender(view(true))};
}
async function choose(user:ReturnType<typeof userEvent.setup>,label:string,value:string){await user.click(screen.getByRole('combobox',{name:label}));await user.click(screen.getByRole('option',{name:value}));}
async function fill(user:ReturnType<typeof userEvent.setup>){await user.click(screen.getByRole('button',{name:'Open shared activity'}));const dialog=screen.getByRole('dialog',{name:'New shared activity'});await user.type(within(dialog).getByLabelText('Activity name'),'One canonical call');await choose(user,'Ordinary Plan duration field',plan.name);await choose(user,'Ordinary Actual duration field',fact.name);await user.type(within(dialog).getByLabelText('Event date'),'2026-10-20');await user.type(within(dialog).getByLabelText('Planned event duration, minutes'),'60');await user.type(within(dialog).getByLabelText('Actual event duration, minutes'),'60');return dialog;}
it.each([false,true])('defaults the organizer and call roster from current membership when ready=%s at first mount',async(initiallyReady)=>{
 const ui=setup(initiallyReady);if(!initiallyReady)ui.ready();const dialog=await fill(ui.user);
 expect(within(dialog).getByRole('combobox',{name:'Organizer'})).toHaveTextContent(owner.displayName);
 const roster=within(dialog).getByRole('group',{name:'Call participants'});expect(within(roster).getByText(owner.displayName)).toBeVisible();
 const other=required(alphaMembers.find(member=>member.id!==owner.id));await ui.user.click(within(roster).getByRole('combobox',{name:'Add participant'}));await ui.user.click(screen.getByRole('option',{name:other.displayName}));
 await ui.user.click(within(dialog).getByRole('button',{name:'Create shared activity'}));await waitFor(()=>expect(ui.calls.filter(call=>call.method==='POST')).toHaveLength(1));expect(ui.calls.find(call=>call.method==='POST')?.body).toMatchObject({configuration:{organizerMembershipId:owner.id,attendeeMembershipIds:[owner.id,other.id]},task:{responsibleMembershipId:owner.id,participantMembershipIds:[]}});
});
it('preserves an explicitly selected organizer when membership props refresh',async()=>{const ui=setup(true),dialog=await fill(ui.user);const other=required(alphaMembers.find(member=>member.id!==owner.id));await choose(ui.user,'Organizer',other.displayName);ui.ready();expect(within(dialog).getByRole('combobox',{name:'Organizer'})).toHaveTextContent(other.displayName);});

it('keeps the edited organizer, independent roster and original pending/unknown request through membership refresh',async()=>{
 const ui=setup(false,true);ui.ready();const dialog=await fill(ui.user),other=required(alphaMembers.find(member=>member.id!==owner.id));
 await choose(ui.user,'Organizer',other.displayName);const roster=within(dialog).getByRole('group',{name:'Call participants'});await ui.user.click(within(roster).getByRole('combobox',{name:'Add participant'}));await ui.user.click(screen.getByRole('option',{name:other.displayName}));
 await ui.user.click(within(dialog).getByRole('button',{name:'Create shared activity'}));await waitFor(()=>expect(ui.calls.filter(call=>call.method==='POST')).toHaveLength(1));const first=required(ui.calls.find(call=>call.method==='POST'));
 ui.ready();expect(within(dialog).getByRole('combobox',{name:'Organizer'})).toHaveTextContent(other.displayName);expect(within(roster).getByText(owner.displayName)).toBeVisible();expect(within(roster).getByText(other.displayName)).toBeVisible();
 ui.release(failure(503,'UNAVAILABLE','Synthetic unknown result'));await ui.user.click(await screen.findByRole('button',{name:'Retry the original shared activity command'}));await waitFor(()=>expect(ui.calls.filter(call=>call.method==='POST')).toHaveLength(2));const second=required(ui.calls.filter(call=>call.method==='POST')[1]);expect(second.body).toEqual(first.body);expect(second.headers.get('Idempotency-Key')).toBe(first.headers.get('Idempotency-Key'));expect(first.body).toMatchObject({configuration:{organizerMembershipId:other.id,attendeeMembershipIds:[owner.id,other.id]}});
});
