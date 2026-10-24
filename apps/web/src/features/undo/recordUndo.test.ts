import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, installFakeApi, ok, failure } from '../../test/fakeApi';
import { task, PROJECT_ID, STAMP } from '../planning/test/fixtures';
import type { BulkUpdateTasksInput, TaskFieldDefinitionDto, TaskFieldValueDto } from '@workloom/contracts';
import { bulkUpdateTasksRequest } from '../tasks/api';
import { sendMutation } from '../../lib/api';
import { captureTask, recordBulkUndo, recordFieldUndo, recordTaskUndo } from './recordUndo';
import { projectUndoFor, undoScope } from './projectUndo';
import { storeFieldAcks } from './storeFieldAck';
const field: TaskFieldDefinitionDto = { id:'f3000000-0000-4000-8000-000000000099', workspaceId:alpha.id,projectId:PROJECT_ID,name:'Hours Fact',type:'duration',historyEnabled:true,locked:false,archivedAt:null,revision:1,definitionVersionId:'f3000000-0000-4000-8000-000000000098',createdAt:STAMP,updatedAt:STAMP,options:[] };
const value = (revision:number,minutes:number|null):TaskFieldValueDto => ({workspaceId:alpha.id,projectId:PROJECT_ID,taskId:task.id,fieldId:field.id,definitionVersionId:field.definitionVersionId,revision,value:{type:'duration',value:minutes},updatedAt:STAMP});
const path=`/api/v1/workspaces/${alpha.id}`;
function setup(){const client=createQueryClient({retry:false});const store=projectUndoFor(client);store.activate(undoScope(anna.id,alpha.id,PROJECT_ID),true);return{client,store};}
describe('undo command ACK capture',()=>{
  it('captures only a known exact task and independent heads, preserving immutable previous snapshot',()=>{
    const{client}=setup();client.setQueryData(queryKeys.task(anna.id,alpha.id,task.id),task);
    expect(captureTask(client,anna.id,alpha.id,task.id,{expectedRevision:task.revision+1})).toBeUndefined();
    expect(captureTask(client,anna.id,alpha.id,task.id,{expectedRevision:task.revision,expectedParticipantsRevision:task.participantsRevision+1})).toBeUndefined();
    const before=captureTask(client,anna.id,alpha.id,task.id,{expectedRevision:task.revision});expect(before).toEqual(task);expect(before).not.toBe(task);
  });
  it('sends a normal inverse with the acknowledged revision, never a newer cache revision',async()=>{
    const{client,store}=setup(),after={...task,title:'Changed',revision:task.revision+1};
    const{calls}=installFakeApi({[`PATCH ${path}/tasks/${task.id}`]:request=>{expect(request.body).toEqual({expectedRevision:after.revision,title:task.title});return ok({...task,revision:after.revision+1});}});
    recordTaskUndo(client,anna.id,alpha.id,'update',task,after,{expectedRevision:task.revision,title:'Changed'},'receipt');
    client.setQueryData(queryKeys.task(anna.id,alpha.id,task.id),{...after,revision:99});await store.undo();expect(calls.filter(call=>call.method==='PATCH')).toHaveLength(1);expect(store.getSnapshot().count).toBe(0);
  });
  it('positions and hierarchy changes form explicit unsupported boundaries rather than partial inverses',async()=>{
    for(const patch of[{position:2},{parentTaskId:null}]){
      const{client,store}=setup();recordTaskUndo(client,anna.id,alpha.id,'update',task,{...task,...patch,revision:task.revision+1},{expectedRevision:task.revision,...patch},'receipt');
      expect(store.getSnapshot().notice).toBeNull();await store.undo();expect(store.getSnapshot()).toMatchObject({count:1,notice:'unsupported'});
    }
  });
  it('a conflict does not overwrite a colleague or remove the undo entry',async()=>{
    const{client,store}=setup();installFakeApi({[`PATCH ${path}/tasks/${task.id}`]:()=>failure(409,'REVISION_CONFLICT','changed')});
    recordTaskUndo(client,anna.id,alpha.id,'update',task,{...task,title:'Changed',revision:task.revision+1},{expectedRevision:task.revision,title:'Changed'},'receipt');await store.undo();expect(store.getSnapshot()).toMatchObject({count:1,notice:'blocked'});
  });
  it('first fill clears to typed null using ACK revision, preserving the semantic distinction in notification',async()=>{
    const{client,store}=setup(),after=value(1,0);const{calls}=installFakeApi({[`PUT ${path}/tasks/${task.id}/field-values/${field.id}`]:request=>{expect(request.body).toEqual({expectedRevision:1,expectedDefinitionRevision:1,value:{type:'duration',value:null}});return ok(value(2,null));}});
    recordFieldUndo(client,anna.id,alpha.id,{before:null,field},after,{expectedRevision:0,expectedDefinitionRevision:1},'receipt',task.id);await store.undo();
    expect(calls.filter(call=>call.method!=='GET')).toHaveLength(1);expect(store.getSnapshot()).toMatchObject({count:0,notice:'cleared'});
  });
  it('does not turn a confirmed inverse into a retry when only its cache reconciliation fails',async()=>{
    const diagnostic=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try{const{client,store}=setup();vi.spyOn(client,'cancelQueries').mockRejectedValue(new Error('local cache failure'));
      installFakeApi({[`PUT ${path}/tasks/${task.id}/field-values/${field.id}`]:()=>ok(value(2,null))});
      recordFieldUndo(client,anna.id,alpha.id,{before:null,field},value(1,150),{expectedRevision:0,expectedDefinitionRevision:1},'receipt',task.id);await store.undo();
      expect(store.getSnapshot()).toMatchObject({count:0,notice:'cleared'});expect(diagnostic).toHaveBeenCalled();
    }finally{diagnostic.mockRestore();}
  });
  it('restores explicit zero and null independently in one atomic inverse, with ACK rather than inferred value heads',async()=>{
    const{client,store}=setup(),second={...task,id:'f2000000-0000-4000-8000-000000000099'},a=value(3,90),b={...value(7,90),taskId:second.id};
    const input:BulkUpdateTasksInput={projectId:PROJECT_ID,includeFieldValueAck:true,tasks:[{taskId:task.id,expectedRevision:task.revision,expectedFieldValueRevision:2},{taskId:second.id,expectedRevision:second.revision,expectedFieldValueRevision:0}],changes:{customField:{fieldId:field.id,expectedDefinitionRevision:1,value:{type:'duration',value:90}}}};
    const{calls}=installFakeApi({[`POST ${path}/tasks/bulk-update`]:request=>{const body=request.body as BulkUpdateTasksInput;expect(body.tasks.map(row=>row.expectedFieldValueRevision)).toEqual([3,7]);expect(body.changes.restore?.map(row=>row.changes.customField?.value)).toEqual([{type:'duration',value:0},{type:'duration',value:null}]);return ok([{...task,customFieldAck:{...a,revision:4,value:{type:'duration',value:0}}},{...second,customFieldAck:{...b,revision:8,value:{type:'duration',value:null}}}]);}});
    recordBulkUndo(client,anna.id,alpha.id,{before:[task,second],field,customValues:[value(2,0),null]},[{...task,customFieldAck:a},{...second,customFieldAck:b}],input,'receipt');await store.undo();expect(calls.filter(call=>call.method==='POST')).toHaveLength(1);expect(store.getSnapshot()).toMatchObject({count:0,notice:'cleared'});
  });
  it('rejects malformed opted-in ACK values, missing heads and wrong task/tenant identity as unconfirmed responses',async()=>{
    const input:BulkUpdateTasksInput={projectId:PROJECT_ID,includeFieldValueAck:true,tasks:[{taskId:task.id,expectedRevision:task.revision,expectedFieldValueRevision:2}],changes:{customField:{fieldId:field.id,expectedDefinitionRevision:1,value:{type:'duration',value:90}}}};
    for(const ack of [undefined,value(1,90),value(3,0),{...value(3,90),taskId:field.id},{...value(3,90),workspaceId:field.id}]){
      installFakeApi({[`POST ${path}/tasks/bulk-update`]:()=>ok([{...task,customFieldAck:ack}])});await expect(sendMutation(bulkUpdateTasksRequest(alpha.id,input),{idempotencyKey:crypto.randomUUID()})).rejects.toMatchObject({kind:'invalid_response'});
    }
  });
  it('merges full ACKs into existing matching scopes, never regresses a newer value or creates unrelated queries',()=>{
    const{client}=setup(),single=queryKeys.taskFieldValues(anna.id,alpha.id,task.id),batch=queryKeys.projectFieldValueChunk(anna.id,alpha.id,PROJECT_ID,[task.id]);client.setQueryData(single,[value(4,120)]);client.setQueryData(batch,[]);
    storeFieldAcks(client,anna.id,alpha.id,[value(3,90)]);expect(client.getQueryData(single)).toEqual([value(4,120)]);expect(client.getQueryData(batch)).toEqual([value(3,90)]);
  });
  it.each(['current', 'actor-changed', 'wrong-workspace'] as const)('publishes only an identity-validated restore revision for %s', async variant => {
    const { client, store } = setup();
    client.setQueryData(queryKeys.me, { actor: { id: variant === 'actor-changed' ? 'different-actor' : anna.id } });
    store.activate(undoScope(anna.id, alpha.id, PROJECT_ID), true);
    const archived = { ...task, archivedAt: STAMP, revision: task.revision + 1 };
    const restored = { ...task, revision: archived.revision + 1, workspaceId: variant === 'wrong-workspace' ? 'a0000000-0000-4000-8000-000000000099' : alpha.id };
    installFakeApi({ [`POST ${path}/tasks/${task.id}/restore`]: () => ok(restored) });
    recordTaskUndo(client, anna.id, alpha.id, 'archive', task, archived, { expectedRevision: task.revision }, 'archive-receipt');
    await store.undo();
    expect(client.getQueryData(queryKeys.taskRestoreAck(anna.id, alpha.id, task.id))).toBe(variant === 'current' ? restored.revision : undefined);
  });

});
