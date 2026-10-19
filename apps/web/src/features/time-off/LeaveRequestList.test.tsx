import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { LeaveOverviewDto, LeaveRequestDto } from '@workloom/contracts';
import { alpha, anna, installFakeApi, ok } from '../../test/fakeApi';
import { LeaveRequestList } from './LeaveRequestList';
import { MEMBER, overview, prefix, required, VACATION } from './test/fixtures';
const request: LeaveRequestDto = { id:'f0000000-0000-4000-8000-000000000001',workspaceId:alpha.id,membershipId:MEMBER,typeId:VACATION,revision:1,startDate:'2026-10-18',endDate:'2026-10-23',status:'approved',note:'Private note',createdBy:MEMBER,createdAt:'2026-10-01T09:00:00.000Z',updatedAt:'2026-10-01T09:00:00.000Z',consumesBalance:true,pausesAccrual:false,capacityUnavailable:true,chargedDays:[],negativeApproved:false };
function mount(data:LeaveOverviewDto) { const client = new QueryClient({defaultOptions:{queries:{retry:false}}}); const onUpdate=vi.fn().mockResolvedValue(request),onDecision=vi.fn().mockResolvedValue(request); const view=render(<QueryClientProvider client={client}><LeaveRequestList actorId={anna.id} overview={data} disabled={false} onUpdate={onUpdate} onDecision={onDecision}/></QueryClientProvider>); return {...view,client,onUpdate,onDecision}; }
describe('leave request history and approval',()=>{
 it('locks started dates and notes while allowing an employee to shorten only the future tail',()=>{
  const data=overview();data.capabilities={canManage:false,canApprove:false,canRequest:true};data.requests=[request];const {container,unmount,client}=mount(data);required(container.querySelector('details')).open=true;
  expect(screen.getByLabelText('Start date')).toBeDisabled();expect(screen.getByLabelText('Private note (you and administrators)')).toBeDisabled();expect(screen.getByLabelText('End date (inclusive)')).toBeEnabled();expect(screen.getByLabelText('End date (inclusive)')).toHaveAttribute('min','2026-10-19');expect(screen.queryByRole('button',{name:'Cancel request'})).not.toBeInTheDocument();expect(screen.getByText(/started and past days stay unchanged/)).toBeVisible();unmount();client.clear();
 });
 it('offers no past edit to an employee',()=>{
  const data=overview();data.capabilities={canManage:false,canApprove:false,canRequest:true};data.requests=[{...request,startDate:'2026-10-12',endDate:'2026-10-16'}];const{container,unmount,client}=mount(data);required(container.querySelector('details')).open=true;expect(screen.queryByLabelText('Start date')).not.toBeInTheDocument();expect(screen.getByText(/Past days are locked/)).toBeVisible();unmount();client.clear();
 });
 it('requires an authoritative review before approving an absence',async()=>{
  const data=overview();data.requests=[{...request,startDate:'2026-11-02',endDate:'2026-11-02',status:'pending'}];installFakeApi({[`POST ${prefix}/preview`]:()=>ok({sourceVersion:'c'.repeat(64),today:data.today,chargedDays:[{date:'2026-11-02',microdays:1_000_000,scheduledMinutes:480}],totalMicrodays:1_000_000,unavailableMinutes:480,overlappingRequestIds:[],pausesAccrual:false,balancesBefore:[],balancesAfter:[],deficits:[]})});const user=userEvent.setup();const{container,onDecision,unmount,client}=mount(data);required(container.querySelector('details')).open=true;
  expect(onDecision).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Review approval'}));const preview=await screen.findByRole('region',{name:'Charge preview'});expect(within(preview).getByText('1 balance days · 8 working hours unavailable')).toBeVisible();expect(onDecision).not.toHaveBeenCalled();await user.click(screen.getByRole('button',{name:'Approve'}));expect(onDecision).toHaveBeenCalledWith(request.id,{expectedRevision:1,decision:'approve',reason:'',approveNegative:false,expectedSourceVersion:'c'.repeat(64)});unmount();client.clear();
 });
});
