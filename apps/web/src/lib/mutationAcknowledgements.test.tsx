import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { alpha, anna, boris, installFakeApi, ok, project, deferred } from '../test/fakeApi';
import { task } from '../features/planning/test/fixtures';
import { useUpdateTaskMutation } from '../features/tasks/queries';
import { createProjectRequest } from '../features/projects/api';
import { projectUndoFor, undoScope } from '../features/undo/projectUndo';
import { subscribeMutationAcknowledgements, type MutationAcknowledgement } from './mutationAcknowledgements';
import { createQueryClient } from './queryClient';
import { queryKeys } from './queryKeys';
import { MutationActorChangedError, useIdempotentMutation, type IdempotentVariables } from './useIdempotentMutation';
interface Variables extends IdempotentVariables { name: string }
const saved=project(alpha.id,'e0000000-0000-4000-8000-000000000001','Same');
const path=`/api/v1/workspaces/${alpha.id}/projects`;
function setup(onSuccess?:(ack:MutationAcknowledgement)=>void){
 const client=createQueryClient({retry:false});client.setQueryData(queryKeys.me,{actor:anna});
 const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
 const view=renderHook(()=>useIdempotentMutation({prepare:(v:Variables)=>createProjectRequest(alpha.id,{name:v.name}),onSuccess:(_data,_variables,ack)=>onSuccess?.(ack)}),{wrapper});
 const events:MutationAcknowledgement[]=[];subscribeMutationAcknowledgements(client,ack=>events.push(ack));return{client,view,events};
}
describe('neutral ACK command receipt identity',()=>{
 it('distinguishes identical request bodies with new receipt keys and deduplicates the exact replay',async()=>{
  installFakeApi({[`POST ${path}`]:()=>ok(saved)});const s=setup(),store=projectUndoFor(s.client);store.activate(undoScope(anna.id,alpha.id,saved.id),true);
  await act(async()=>{await s.view.result.current.mutateAsync({name:'Same',idempotencyKey:'a0000000-0000-4000-8000-000000000001'});});expect(store.getSnapshot().count).toBe(1);
  store.record({id:'supported-edit',receipt:'supported-edit',scope:undoScope(anna.id,alpha.id,saved.id),kind:'edit',heads:{task:2},beforeHeads:{task:1},prepare:()=>async()=>({task:3})});
  await act(async()=>{await s.view.result.current.mutateAsync({name:'Same',idempotencyKey:'a0000000-0000-4000-8000-000000000002'});});expect(store.getSnapshot().count).toBe(3);
  expect(s.events[1]?.fingerprint).toBe(s.events[0]?.fingerprint);expect(s.events[1]?.receipt).not.toBe(s.events[0]?.receipt);
  await act(async()=>{await s.view.result.current.mutateAsync({name:'Same',idempotencyKey:'a0000000-0000-4000-8000-000000000002'});});expect(store.getSnapshot().count).toBe(3);await store.undo();expect(store.getSnapshot().notice).toBe('unsupported');
 });
 it('refuses unknown retry under a new actor without sending or losing held body/key; returning actor can retry',async()=>{
  let sent=0;const{calls}=installFakeApi({[`POST ${path}`]:()=>{if(++sent===1)throw new TypeError('lost');return ok(saved);}});const s=setup(),variables={name:'Same'};
  await act(async()=>{await expect(s.view.result.current.mutateAsync(variables)).rejects.toThrow();});expect(s.events).toHaveLength(0);
  s.client.setQueryData(queryKeys.me,{actor:boris});s.view.rerender();
  await act(async()=>{await expect(s.view.result.current.mutateAsync({...variables})).rejects.toBeInstanceOf(MutationActorChangedError);});
  expect(calls).toHaveLength(1);expect(s.view.result.current.uncertain?.variables).toBe(variables);
  s.client.setQueryData(queryKeys.me,{actor:anna});await act(async()=>{await s.view.result.current.mutateAsync(variables);});
  expect(s.events[0]?.actorId).toBe(anna.id);expect(calls[1]?.headers.get('Idempotency-Key')).toBe(calls[0]?.headers.get('Idempotency-Key'));
  s.client.setQueryData(queryKeys.me,{actor:boris});await act(async()=>{await s.view.result.current.mutateAsync(variables);});expect(s.events[1]?.actorId).toBe(boris.id);expect(s.events[1]?.receipt).not.toBe(s.events[0]?.receipt);
 });
 it('isolates throwing configured observers and listeners from confirmed success, refreshes caches and adds a failclosed boundary',async()=>{
  const diagnostic=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  try{
   installFakeApi({[`POST ${path}`]:()=>ok(saved)});const s=setup(()=>{throw new Error('private observer payload');}),store=projectUndoFor(s.client);
   store.activate(undoScope(anna.id,alpha.id,saved.id),true);store.record({id:'earlier',scope:undoScope(anna.id,alpha.id,saved.id),kind:'edit',heads:{task:2},beforeHeads:{task:1},prepare:()=>async()=>({task:3})});
   const invalidation=vi.spyOn(s.client,'invalidateQueries');const later=vi.fn();subscribeMutationAcknowledgements(s.client,()=>{throw new Error('private listener payload');});subscribeMutationAcknowledgements(s.client,later);
   await act(async()=>{expect(await s.view.result.current.mutateAsync({name:'Same'})).toEqual(saved);});
   expect(s.view.result.current.isSuccess).toBe(true);expect(s.view.result.current.uncertain).toBeNull();expect(invalidation).toHaveBeenCalled();expect(later).toHaveBeenCalledTimes(1);expect(s.events[0]?.observerFailed).toBe(true);
   await store.undo();expect(store.getSnapshot()).toMatchObject({count:2,notice:'unsupported'});expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private');
  }finally{diagnostic.mockRestore();}
 });
 it('also isolates asynchronous configured observer rejection after the server ACK',async()=>{
  const diagnostic=vi.spyOn(console,'error').mockImplementation(()=>undefined);try{installFakeApi({[`POST ${path}`]:()=>ok(saved)});
   const client=createQueryClient({retry:false});client.setQueryData(queryKeys.me,{actor:anna});const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
   const view=renderHook(()=>useIdempotentMutation({prepare:(v:Variables)=>createProjectRequest(alpha.id,{name:v.name}),onSuccess:async()=>{throw new Error('private async payload');}}),{wrapper});
   await act(async()=>{expect(await view.result.current.mutateAsync({name:'Same'})).toEqual(saved);});expect(view.result.current.isSuccess).toBe(true);expect(view.result.current.uncertain).toBeNull();
  }finally{diagnostic.mockRestore();}
 });
 it('does not attribute a late old-actor task ACK or its cached detail to a shared hook rerendered for another actor',async()=>{
  const reply=deferred<Response>();installFakeApi({[`PATCH /api/v1/workspaces/${alpha.id}/tasks/${task.id}`]:()=>reply.promise});
  const client=createQueryClient({retry:false});client.setQueryData(queryKeys.me,{actor:anna});client.setQueryData(queryKeys.task(anna.id,alpha.id,task.id),task);
  const store=projectUndoFor(client);store.activate(undoScope(anna.id,alpha.id,task.projectId),true);
  const wrapper=({children}:{children:ReactNode})=><QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view=renderHook(({actorId}:{actorId:string})=>useUpdateTaskMutation(actorId,alpha.id),{wrapper,initialProps:{actorId:anna.id}});let pending:Promise<unknown>|undefined;
  act(()=>{pending=view.result.current.mutateAsync({taskId:task.id,input:{expectedRevision:task.revision,title:'Old actor edit'}});});await waitFor(()=>expect(view.result.current.pendingCommand).not.toBeNull());
  client.setQueryData(queryKeys.me,{actor:boris});store.activate(undoScope(boris.id,alpha.id,task.projectId),true);view.rerender({actorId:boris.id});
  await act(async()=>{reply.resolve(ok({...task,title:'Old actor edit',revision:task.revision+1}));await pending;});
  expect(store.getSnapshot().count).toBe(0);expect(client.getQueryData(queryKeys.task(boris.id,alpha.id,task.id))).toBeUndefined();
 });
 it('delivers supported feature callback before generic boundary and never before an ACK',async()=>{
  installFakeApi({[`POST ${path}`]:()=>ok(saved)});const order:string[]=[];const s=setup(()=>order.push('feature'));subscribeMutationAcknowledgements(s.client,()=>order.push('boundary'));
  await act(async()=>{await s.view.result.current.mutateAsync({name:'Same'});});expect(order).toEqual(['feature','boundary']);
 });
});
