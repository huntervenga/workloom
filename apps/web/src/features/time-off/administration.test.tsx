import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { LeaveWarningsDto, LeaveRequestDto } from '@workloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import { anna, installFakeApi, json } from '../../test/fakeApi';
import { LeaveRequestForm } from './LeaveRequestForm';
import { LeaveRequestList } from './LeaveRequestList';
import { LeaveProfileEditor } from './LeaveProfileEditor';
import { LeaveRecalculationReview } from './LeavePreview';
import { LeaveWarnings } from './LeaveWarnings';
import { fetchOverview } from './api';
import { MEMBER, overview, prefix, profile, settings, VACATION } from './test/fixtures';
const warnings: LeaveWarningsDto = { warnings: [{ code: 'OUTSIDE_EMPLOYMENT', entity: 'request', entityId: VACATION, membershipId: MEMBER, startDate: '2022-10-03', endDate: '2022-10-07', typeId: VACATION, availableMicrodays: null }], totalCount: 1, truncated: false };
function firstWarning(){const warning=warnings.warnings[0];if(!warning)throw new Error('Missing synthetic warning');return warning;}
function wrapper(client: QueryClient) { return function Provider({ children }: { children: ReactNode }) { return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }; }
const preview = () => json(200, { data: { sourceVersion: 'a'.repeat(64), balancesBefore: [], balancesAfter: [], deficits: [] }, meta: { requestId: 'safe-request', leaveWarnings: warnings } });
describe('systemic administrative presentation', () => {
 it('retains validated overview diagnostics from compatible envelope metadata', async () => {
  installFakeApi({ [`GET ${prefix}/overview`]: () => json(200, { data: overview(), meta: { requestId: 'safe-request', leaveWarnings: warnings } }) });
  expect((await fetchOverview(settings().workspaceId)).warnings).toEqual(warnings);
 });
 it('shows server-authored dates and advisory guidance without a blocking approval message', () => {
  const view=render(<LeaveWarnings warnings={warnings} settings={settings()} members={overview().members}/>);
  expect(screen.getByRole('region', {name:'Administrative warnings'})).toHaveTextContent('2022-10-03 → 2022-10-07');
  expect(screen.getByRole('status')).toHaveTextContent('You can save the correction');
  expect(screen.queryByText(/Approval cannot bypass/)).not.toBeInTheDocument();view.unmount();
 });

 it('shows only the selected person’s warnings and leaves workspace presentations unfiltered',()=>{const other='d0000000-0000-4000-8000-000000000001',scoped:LeaveWarningsDto={warnings:[{...firstWarning(),code:'NEGATIVE_OPENING',membershipId:other,availableMicrodays:-2_000_000},{...firstWarning(),code:'OVERLAP'}],totalCount:2,truncated:false};const view=render(<LeaveWarnings warnings={scoped} settings={settings()} members={overview().members} membershipId={MEMBER}/>);expect(screen.getByRole('region',{name:'Administrative warnings'})).toHaveTextContent('overlap');expect(screen.queryByText('The opening balance is negative.')).not.toBeInTheDocument();expect(view.container.textContent).not.toContain('-2 days');view.rerender(<LeaveWarnings warnings={scoped} settings={settings()} members={overview().members}/>);expect(view.container.textContent).toContain('-2 days');view.unmount();});
 it('does not invent a selected-person total when workspace warnings are truncated',()=>{const other='d0000000-0000-4000-8000-000000000001',scoped:LeaveWarningsDto={warnings:[{...firstWarning(),code:'NEGATIVE_OPENING',membershipId:other}],totalCount:500,truncated:true};const view=render(<LeaveWarnings warnings={scoped} membershipId={MEMBER}/>);expect(screen.getByRole('region',{name:'Administrative warnings'})).toHaveTextContent('Some workspace warnings were omitted');expect(view.container.textContent).not.toContain('500');expect(view.container.textContent).not.toMatch(/Showing|zero|0 warnings/);expect(view.container.querySelectorAll('li')).toHaveLength(0);view.unmount();});

 it('keeps ordinary member deficit policy copy and never implies administrator permission', () => {
  const view=render(<LeaveRecalculationReview settings={settings()} preview={{sourceVersion:'a'.repeat(64),balancesBefore:[],balancesAfter:[],deficits:[{requestId:VACATION,membershipId:MEMBER,typeId:VACATION,date:'2026-10-20',availableMicrodays:-1000000,negativeAllowed:false,negativeApprovalRequired:true}],warnings}}/>);
  expect(screen.getByText(/Approval cannot bypass/)).toBeVisible();expect(screen.queryByText(/You can save the correction/)).not.toBeInTheDocument();expect(screen.queryByRole('region',{name:'Administrative warnings'})).not.toBeInTheDocument();view.unmount();
 });
 it('OFF explicitly follows hire, reviews without reason, then saves once after reason is entered', async () => {
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),onSave=vi.fn();
  const saved={...profile(),employmentStart:'2022-01-01',accountingStart:'2022-01-01'};
  installFakeApi({ [`POST ${prefix}/members/${MEMBER}/profile/preview`]: preview });
  const view=render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={saved} settings={settings()} today="2026-10-19" disabled={false} onSave={onSave}/>,{wrapper:wrapper(client)});
  expect(screen.getByText(/Custom accounting is off/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('Employment start'),{target:{value:'2023-01-01'}});
  await user.click(screen.getByRole('button',{name:'Review changes'}));
  await screen.findByRole('region',{name:'Administrative warnings'});
  await user.click(screen.getByRole('button',{name:'Save person settings'}));expect(onSave).not.toHaveBeenCalled();expect(screen.getByLabelText('Reason for change')).toHaveFocus();
  await user.type(screen.getByLabelText('Reason for change'),'Correct actual employment boundary');
  await user.click(screen.getByRole('button',{name:'Save person settings'}));
  expect(onSave).toHaveBeenCalledOnce();expect(onSave).toHaveBeenCalledWith(expect.objectContaining({employmentStart:'2023-01-01',accountingStart:'2023-01-01',expectedSourceVersion:'a'.repeat(64)}));view.unmount();client.clear();
 });
 it('ON preserves independent accounting and submits a mixed negative opening/schedule correction', async () => {
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),onSave=vi.fn();
  const saved={...profile(),employmentStart:'2023-01-01',accountingStart:'2022-01-01'};
  installFakeApi({ [`POST ${prefix}/members/${MEMBER}/profile/preview`]: preview });
  const view=render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={saved} settings={settings()} today="2026-10-19" disabled={false} onSave={onSave}/>,{wrapper:wrapper(client)});
  expect(screen.getByRole('checkbox',{name:'Use a custom accounting start and opening balances'})).toBeChecked();fireEvent.change(screen.getByLabelText('Employment start'),{target:{value:'2024-01-01'}});
  expect(screen.getByLabelText('Balance accounting starts')).toHaveValue('2022-01-01');fireEvent.change(screen.getByLabelText('Vacation'),{target:{value:'-3'}});fireEvent.change(screen.getByLabelText('Mon hours from 2026-01-01'),{target:{value:'4'}});
  await user.click(screen.getByRole('button',{name:'Review changes'}));await screen.findByRole('button',{name:'Save person settings'});await user.type(screen.getByLabelText('Reason for change'),'Correct mixed profile');await user.click(screen.getByRole('button',{name:'Save person settings'}));
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({employmentStart:'2024-01-01',accountingStart:'2022-01-01',openingBalances:[{typeId:VACATION,microdays:-3000000}],schedulePeriods:[expect.objectContaining({weeklyMinutes:[240,480,480,480,480,0,0]})]}));view.unmount();client.clear();
 });
});

const requestPreview = () => json(200, { data: { sourceVersion:'b'.repeat(64),today:'2026-10-19',chargedDays:[],totalMicrodays:0,unavailableMinutes:0,overlappingRequestIds:[VACATION],pausesAccrual:false,balancesBefore:[],balancesAfter:[],deficits:[] },meta:{requestId:'safe-request',leaveWarnings:warnings} });
function futureRequest(status: LeaveRequestDto['status']='pending'): LeaveRequestDto { return {id:VACATION,workspaceId:settings().workspaceId,membershipId:MEMBER,typeId:VACATION,revision:1,startDate:'2026-11-02',endDate:'2026-11-03',status,note:'Synthetic future request',createdBy:MEMBER,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',consumesBalance:true,pausesAccrual:false,capacityUnavailable:true,chargedDays:[],negativeApproved:false}; }
describe('future administrative conflicts stay advisory without an invented reason',()=>{
 it('submits a new future request with warnings and an empty reason',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),onCreate=vi.fn();installFakeApi({[`POST ${prefix}/preview`]:requestPreview});
  const view=render(<LeaveRequestForm actorId={anna.id} overview={overview()} disabled={false} onCreate={onCreate} onBulk={vi.fn()} onCancel={vi.fn()}/>,{wrapper:wrapper(client)});
  await user.click(screen.getByRole('button',{name:'Review charge'}));await screen.findByRole('button',{name:'Submit request'});await user.click(screen.getByRole('button',{name:'Submit request'}));expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({reason:''}));expect(screen.queryByRole('alert')).not.toBeInTheDocument();view.unmount();client.clear();
 });
 it('saves a future edit and approves a future pending request with warnings and empty reason',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),request=futureRequest(),onUpdate=vi.fn(async()=>({...request,revision:2,endDate:'2026-11-04'})),onDecision=vi.fn(async()=>({...request,revision:2,status:'approved' as const}));installFakeApi({[`POST ${prefix}/preview`]:requestPreview});
  const view=render(<LeaveRequestList actorId={anna.id} overview={{...overview(),requests:[request]}} disabled={false} onUpdate={onUpdate} onDecision={onDecision}/>,{wrapper:wrapper(client)});const details=view.container.querySelector('details');if(details)details.open=true;
  fireEvent.change(screen.getByLabelText('End date (inclusive)'),{target:{value:'2026-11-04'}});await user.click(screen.getByRole('button',{name:'Review charge'}));await user.click(await screen.findByRole('button',{name:'Save request changes'}));expect(onUpdate).toHaveBeenCalledWith(request.id,expect.objectContaining({reason:''}));
  await user.click(screen.getByRole('button',{name:'Review approval'}));await user.click(await screen.findByRole('button',{name:'Approve'}));expect(onDecision).toHaveBeenCalledWith(request.id,expect.objectContaining({decision:'approve',reason:''}));view.unmount();client.clear();
 });
 it('requires and focuses a reason when moving an originally future request into history',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),request=futureRequest(),onUpdate=vi.fn();installFakeApi({[`POST ${prefix}/preview`]:requestPreview});
  const view=render(<LeaveRequestList actorId={anna.id} overview={{...overview(),requests:[request]}} disabled={false} onUpdate={onUpdate} onDecision={vi.fn()}/>,{wrapper:wrapper(client)});const details=view.container.querySelector('details');if(details)details.open=true;
  fireEvent.change(screen.getByLabelText('Start date'),{target:{value:'2026-10-01'}});await user.click(screen.getByRole('button',{name:'Review charge'}));await user.click(await screen.findByRole('button',{name:'Save request changes'}));expect(onUpdate).not.toHaveBeenCalled();expect(screen.getByLabelText('Reason / correction note')).toHaveFocus();expect(screen.getByRole('alert')).toHaveTextContent('reason');view.unmount();client.clear();
 });
});

describe('profile schedule reason feedback matches the shared server boundary',()=>{
 it('saves a future-only schedule edit without a reason even when the preview has warnings',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),onSave=vi.fn();const saved={...profile(),schedulePeriods:[...profile().schedulePeriods,{effectiveFrom:'2027-01-01',weeklyMinutes:[480,480,480,480,480,0,0] as [number,number,number,number,number,number,number]}]};installFakeApi({[`POST ${prefix}/members/${MEMBER}/profile/preview`]:preview});
  const view=render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={saved} settings={settings()} today="2026-10-19" disabled={false} onSave={onSave}/>,{wrapper:wrapper(client)});fireEvent.change(screen.getByLabelText('Mon hours from 2027-01-01'),{target:{value:'4'}});await user.click(screen.getByRole('button',{name:'Review changes'}));await user.click(await screen.findByRole('button',{name:'Save person settings'}));expect(onSave).toHaveBeenCalledWith(expect.objectContaining({reason:'',schedulePeriods:[saved.schedulePeriods[0],expect.objectContaining({effectiveFrom:'2027-01-01',weeklyMinutes:[240,480,480,480,480,0,0]})]}));view.unmount();client.clear();
 });
 it('requires a reason for mixed current and future schedule edits and keeps the reviewed calculation',async()=>{
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}}),user=userEvent.setup(),onSave=vi.fn();const saved={...profile(),schedulePeriods:[...profile().schedulePeriods,{effectiveFrom:'2027-01-01',weeklyMinutes:[480,480,480,480,480,0,0] as [number,number,number,number,number,number,number]}]};installFakeApi({[`POST ${prefix}/members/${MEMBER}/profile/preview`]:preview});
  const view=render(<LeaveProfileEditor actorId={anna.id} membershipId={MEMBER} profile={saved} settings={settings()} today="2026-10-19" disabled={false} onSave={onSave}/>,{wrapper:wrapper(client)});fireEvent.change(screen.getByLabelText('Mon hours from 2026-01-01'),{target:{value:'4'}});fireEvent.change(screen.getByLabelText('Mon hours from 2027-01-01'),{target:{value:'6'}});await user.click(screen.getByRole('button',{name:'Review changes'}));await user.click(await screen.findByRole('button',{name:'Save person settings'}));expect(onSave).not.toHaveBeenCalled();expect(screen.getByLabelText('Reason for change')).toHaveFocus();await user.type(screen.getByLabelText('Reason for change'),'Correct recorded schedule');await user.click(screen.getByRole('button',{name:'Save person settings'}));expect(onSave).toHaveBeenCalledOnce();view.unmount();client.clear();
 });
});
