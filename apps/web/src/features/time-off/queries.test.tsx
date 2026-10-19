import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { alpha, anna, failure, installFakeApi, ok } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { reportKeys } from '../generic-reports/queries';
import { timeOffKeys, useTimeOffCommands } from './queries';
import { MEMBER, prefix, required, VACATION } from './test/fixtures';
const input = { membershipId: MEMBER, typeId: VACATION, startDate:'2026-11-02', endDate:'2026-11-02', note:'', reason:'' };
const request = { membershipId: MEMBER, typeId: VACATION, startDate: input.startDate, endDate: input.endDate, note: '', id:'f0000000-0000-4000-8000-000000000001', workspaceId:alpha.id, revision:1, status:'pending', createdBy:MEMBER, createdAt:'2026-10-19T12:00:00.000Z', updatedAt:'2026-10-19T12:00:00.000Z', consumesBalance:true, pausesAccrual:false, capacityUnavailable:true, chargedDays:[], negativeApproved:false };
function mount() { const client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}}); client.setQueryData(queryKeys.me,{actor:anna}); const hook=renderHook(()=>useTimeOffCommands(anna.id,alpha.id),{wrapper:({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>}); return {...hook,client}; }
describe('time off mutation freshness',()=>{
 it('invalidates availability and saved report results after confirmed leave writes',async()=>{
  installFakeApi({[`POST ${prefix}/requests`]:()=>ok(request)});const {result,client,unmount}=mount();const availabilityKey=[...timeOffKeys.root(anna.id,alpha.id),'availability','test'];const reportKey=[...reportKeys.root(anna.id,alpha.id),'definition','report','result'];client.setQueryData(availabilityKey,{available:40});client.setQueryData(reportKey,{available:40});
  await act(async()=>{await result.current.create.mutateAsync({input});});expect(client.getQueryState(availabilityKey)?.isInvalidated).toBe(true);expect(client.getQueryState(reportKey)?.isInvalidated).toBe(true);unmount();client.clear();
 });
 it('retains an unknown write for exact retry and never sends a changed form under its key',async()=>{
  let attempts=0;const {calls}=installFakeApi({[`POST ${prefix}/requests`]:()=>++attempts===1?failure(503,'UNAVAILABLE','Private transport diagnostic'):ok(request)});const {result,client,unmount}=mount();
  await act(async()=>{await expect(result.current.create.mutateAsync({input})).rejects.toThrow();});expect(result.current.create.uncertain).not.toBeNull();
  await act(async()=>{await expect(result.current.create.mutateAsync({input:{...input,endDate:'2026-11-03'}})).rejects.toThrow();});expect(attempts).toBe(1);
  await act(async()=>{await result.current.create.mutateAsync(required(result.current.create.uncertain).variables);});expect(attempts).toBe(2);expect(calls[1]?.body).toEqual(calls[0]?.body);expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));expect(result.current.create.uncertain).toBeNull();unmount();client.clear();
 });
});
