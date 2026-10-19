import type { TaskFieldValueDto } from '@workloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, deferred } from '../../test/fakeApi';
import { task, STAMP } from '../planning/test/fixtures';
import { reconcileFieldAcks } from './storeFieldAck';
const fieldId='f3000000-0000-4000-8000-000000000099';
const value=(revision:number,minutes:number|null):TaskFieldValueDto=>({workspaceId:alpha.id,projectId:task.projectId,taskId:task.id,fieldId,definitionVersionId:'f3000000-0000-4000-8000-000000000098',revision,value:{type:'duration',value:minutes},updatedAt:STAMP});
describe('confirmed field ACK reconciliation before refetch',()=>{
 it('cancels older task and project reads before merging the full confirmed row, and ignores their later stale results',async()=>{
  const client=createQueryClient({retry:false}),single=queryKeys.taskFieldValues(anna.id,alpha.id,task.id),batch=queryKeys.projectFieldValueChunk(anna.id,alpha.id,task.projectId,[task.id]);
  client.setQueryData(single,[]);client.setQueryData(batch,[]);
  const first=deferred<TaskFieldValueDto[]>(),second=deferred<TaskFieldValueDto[]>();let singleSignal:AbortSignal|undefined,batchSignal:AbortSignal|undefined;
  const readingSingle=client.fetchQuery({staleTime:0,queryKey:single,queryFn:({signal})=>{singleSignal=signal;return first.promise;}}).catch(()=>undefined);
  const readingBatch=client.fetchQuery({staleTime:0,queryKey:batch,queryFn:({signal})=>{batchSignal=signal;return second.promise;}}).catch(()=>undefined);
  const ack=value(1,150);await reconcileFieldAcks(client,anna.id,alpha.id,[ack]);
  expect(singleSignal?.aborted).toBe(true);expect(batchSignal?.aborted).toBe(true);expect(client.getQueryData(single)).toEqual([ack]);expect(client.getQueryData(batch)).toEqual([ack]);
  first.resolve([]);second.resolve([]);await Promise.all([readingSingle,readingBatch]);expect(client.getQueryData(single)).toEqual([ack]);expect(client.getQueryData(batch)).toEqual([ack]);
 });
 it('preserves a newer cached head that cancellation would otherwise revert to the fetch-start snapshot',async()=>{
  const client=createQueryClient({retry:false}),batch=queryKeys.projectFieldValueChunk(anna.id,alpha.id,task.projectId,[task.id]);client.setQueryData(batch,[value(1,90)]);
  const stale=deferred<TaskFieldValueDto[]>();const reading=client.fetchQuery({staleTime:0,queryKey:batch,queryFn:({signal})=>{void signal;return stale.promise;}}).catch(()=>undefined);
  client.setQueryData(batch,[value(3,180)]);await reconcileFieldAcks(client,anna.id,alpha.id,[value(2,150)]);expect(client.getQueryData(batch)).toEqual([value(3,180)]);
  stale.resolve([value(1,90)]);await reading;expect(client.getQueryData(batch)).toEqual([value(3,180)]);
 });
 it('leaves unrelated task scopes and other actors untouched',async()=>{
  const client=createQueryClient({retry:false}),single=queryKeys.taskFieldValues(anna.id,alpha.id,task.id),other=queryKeys.taskFieldValues(anna.id,alpha.id,fieldId),otherActor=queryKeys.taskFieldValues(fieldId,alpha.id,task.id);
  client.setQueryData(single,[]);client.setQueryData(other,[]);client.setQueryData(otherActor,[]);
  const pending=deferred<TaskFieldValueDto[]>();let signal:AbortSignal|undefined;const reading=client.fetchQuery({staleTime:0,queryKey:other,queryFn:context=>{signal=context.signal;return pending.promise;}}).catch(()=>undefined);
  await reconcileFieldAcks(client,anna.id,alpha.id,[value(1,0)]);expect(signal?.aborted).toBe(false);expect(client.getQueryData(other)).toEqual([]);expect(client.getQueryData(otherActor)).toEqual([]);
  pending.resolve([]);await reading;
 });
 it('does not recreate removed actor scopes while cancellation settles',async()=>{
  const client=createQueryClient({retry:false}),single=queryKeys.taskFieldValues(anna.id,alpha.id,task.id);client.setQueryData(single,[]);
  const barrier=deferred<undefined>();vi.spyOn(client,'cancelQueries').mockImplementation(()=>barrier.promise);
  const reconciling=reconcileFieldAcks(client,anna.id,alpha.id,[value(1,150)]);client.removeQueries({queryKey:queryKeys.actor(anna.id)});barrier.resolve(undefined);await reconciling;expect(client.getQueryState(single)).toBeUndefined();
 });
});
