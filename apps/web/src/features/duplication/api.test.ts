import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, installFakeApi, ok } from '../../test/fakeApi';
import { ApiError, sendMutation } from '../../lib/api';
import { PROJECT_ID, field } from '../fields/test/fixtures';
import { duplicateRequest, previewDuplication, type DuplicationPreviewRequest } from './api';
afterEach(()=>vi.unstubAllGlobals());
const sourceId='71000000-0000-4000-8000-000000000001',createdId='71000000-0000-4000-8000-000000000002';
const copy={description:true,assignee:true,dates:true,tags:true,priority:true,participants:true,subtasks:true,customFieldIds:[]};
const request:DuplicationPreviewRequest={kind:'task',sourceId,projectId:PROJECT_ID,input:{projectId:PROJECT_ID,title:'  Copy  ',copy}};
const preview={kind:'task',sourceId,projectId:PROJECT_ID,sourceVersion:'a'.repeat(64),name:'Copy',taskCount:1,customValueCount:0,copyableFields:[field('Fact','duration')],settings:null};
describe('duplication API adapter',()=>{
 it('performs a contract-validated read-only preview without an idempotency key or copied value contents',async()=>{
  const path=`/api/v1/workspaces/${alpha.id}/tasks/${sourceId}/duplicate-preview`,{calls}=installFakeApi({[`POST ${path}`]:()=>ok(preview)});
  expect(await previewDuplication(alpha.id,request)).toEqual(preview);expect(calls).toHaveLength(1);expect(calls[0]?.body).toEqual({...request.input,title:'Copy'});expect(calls[0]?.headers.get('Idempotency-Key')).toBeNull();
 });
 for(const mismatch of [{kind:'section'}, {sourceId:createdId}, {projectId:'e0000000-0000-4000-8000-000000000002'}])it(`rejects a preview for another target (${Object.keys(mismatch)[0]})`,async()=>{
  installFakeApi({[`POST /api/v1/workspaces/${alpha.id}/tasks/${sourceId}/duplicate-preview`]:()=>ok({...preview,...mismatch})});await expect(previewDuplication(alpha.id,request)).rejects.toMatchObject({kind:'invalid_response'});
 });
 it('sends a guarded copy with the exact source version and stable explicit idempotency key',async()=>{
  const{calls}=installFakeApi({[`POST /api/v1/workspaces/${alpha.id}/tasks/${sourceId}/duplicate`]:()=>ok({kind:'task',projectId:PROJECT_ID,rootTaskId:createdId,section:null,taskIds:[createdId]})});
  const command=duplicateRequest(alpha.id,{...request,input:{...request.input,expectedSourceVersion:preview.sourceVersion}}),key='72000000-0000-4000-8000-000000000001';
  await sendMutation(command,{idempotencyKey:key});expect(calls[0]?.headers.get('Idempotency-Key')).toBe(key);expect(calls[0]?.body).toEqual({...request.input,title:'Copy',expectedSourceVersion:preview.sourceVersion});
 });
 it('rejects invalid options before making a request',async()=>{
  const{calls}=installFakeApi({});await expect(previewDuplication(alpha.id,{...request,input:{...request.input,title:''}})).rejects.toBeInstanceOf(ApiError);expect(calls).toEqual([]);
 });
});
