import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { LeaveAvailabilityInput, LeaveRequestDto } from '@workloom/contracts';
import { alpha, anna, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { isWorkspaceRefreshProtected } from '../../lib/workspaceRefreshProtection';
import { timeOffKeys, useAvailability, useTimeOffCommands } from './queries';
import { availability, MEMBER, prefix, UNPAID } from './test/fixtures';

const request: LeaveRequestDto = { id:'f0000000-0000-4000-8000-000000000001',workspaceId:alpha.id,membershipId:MEMBER,typeId:UNPAID,startDate:'2026-10-20',endDate:'2026-10-20',note:'',revision:2,status:'approved',createdBy:MEMBER,createdAt:'2026-10-19T12:00:00.000Z',updatedAt:'2026-10-19T12:00:00.000Z',consumesBalance:false,pausesAccrual:true,capacityUnavailable:true,chargedDays:[],negativeApproved:false };
const input:LeaveAvailabilityInput={startDate:'2026-10-19',endDate:'2026-10-25',people:{kind:'all_active'}};

describe('confirmed leave writes keep their current availability read protected',()=>{
 for(const outcome of ['success','read_failure']as const)it(`${outcome}: awaits the active read before acknowledgement, without turning a committed decision into an uncertain write`,async()=>{
  const gate=deferred<Response>(),ack=vi.fn();let reads=0;
  const {calls}=installFakeApi({[`POST ${prefix}/requests/${request.id}/decision`]:()=>ok(request),[`POST ${prefix}/availability`]:()=>{reads++;return gate.promise;}});
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity},mutations:{retry:false}}});
  client.setQueryData(queryKeys.me,{actor:anna});const before=availability();before.days=before.days.map(day=>({...day,absenceMinutes:0,availableMinutes:day.scheduledMinutes}));
  client.setQueryData(timeOffKeys.availability(anna.id,alpha.id,input),before);
  const hook=renderHook(()=>({commands:useTimeOffCommands(anna.id,alpha.id,{onRequest:ack}),availability:useAvailability(anna.id,alpha.id,input)}),{wrapper:({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>});
  let completed:Promise<LeaveRequestDto>|undefined;
  try{
   act(()=>{completed=hook.result.current.commands.decision.mutateAsync({requestId:request.id,input:{expectedRevision:1,decision:'approve',reason:'',approveNegative:false}});});
   await waitFor(()=>expect(reads).toBe(1));
   await act(async()=>{await Promise.resolve();});
   expect(hook.result.current.availability.isFetching).toBe(true);
   expect(hook.result.current.commands.decision.pendingCommand).not.toBeNull();
   expect(protectedCommandsFor(client).protecting).toBe(true);
   expect(isWorkspaceRefreshProtected(client)).toBe(true);
   expect(ack).not.toHaveBeenCalled();
   expect(hook.result.current.availability.data?.days[0]?.availableMinutes).toBe(480);
   await act(async()=>{gate.resolve(outcome==='success'?ok(availability()):failure(503,'UNAVAILABLE','Availability read failed after a committed decision'));await completed;});
   await waitFor(()=>expect(protectedCommandsFor(client).protecting).toBe(false));
   expect(hook.result.current.commands.decision.isSuccess).toBe(true);
   expect(hook.result.current.commands.decision.uncertain).toBeNull();
   expect(ack).toHaveBeenCalledExactlyOnceWith(request);
   if(outcome==='success')expect(hook.result.current.availability.data?.days[0]?.availableMinutes).toBe(0);
   else expect(hook.result.current.availability.isError).toBe(true);
   expect(reads).toBe(1);
   expect(calls.filter(call=>call.path.endsWith('/decision'))).toHaveLength(1);
  }finally{await act(async()=>{gate.resolve(ok(availability()));await completed;});hook.unmount();client.clear();}
 });
});
