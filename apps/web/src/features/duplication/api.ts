import { duplicateTaskPreviewInputSchema, duplicateSectionPreviewInputSchema, duplicateTaskInputSchema, duplicateSectionInputSchema, duplicationPreviewResponseSchema, duplicationResultResponseSchema, type DuplicateTaskPreviewInput, type DuplicateSectionPreviewInput, type DuplicateTaskInput, type DuplicateSectionInput } from '@workloom/contracts';
import { ApiError, apiRequest, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
export type DuplicationPreviewRequest = {kind:'task';sourceId:string;projectId:string;input:DuplicateTaskPreviewInput}|{kind:'section';sourceId:string;projectId:string;input:DuplicateSectionPreviewInput};
export type DuplicationWriteRequest = {kind:'task';sourceId:string;projectId:string;input:DuplicateTaskInput}|{kind:'section';sourceId:string;projectId:string;input:DuplicateSectionInput};
const path=(workspaceId:string,request:{kind:'task'|'section';sourceId:string})=>`${workspacePath(workspaceId)}/${request.kind==='task'?'tasks':'sections'}/${encodeURIComponent(request.sourceId)}`;
export async function previewDuplication(workspaceId:string,request:DuplicationPreviewRequest,signal?:AbortSignal){
 const parsed=request.kind==='task'?duplicateTaskPreviewInputSchema.safeParse(request.input):duplicateSectionPreviewInputSchema.safeParse(request.input);
 if(!parsed.success)throw new ApiError({kind:'invalid_input',status:null});
 const response=await apiRequest(`${path(workspaceId,request)}/duplicate-preview`,{method:'POST',body:parsed.data,signal});
 const output=duplicationPreviewResponseSchema.safeParse(response.payload);
 if(!output.success||output.data.data.kind!==request.kind||output.data.data.sourceId!==request.sourceId||output.data.data.projectId!==request.projectId)throw new ApiError({kind:'invalid_response',status:response.status});
 return output.data.data;
}
export function duplicateRequest(workspaceId:string,request:DuplicationWriteRequest){
 return request.kind==='task'
  ?prepareMutation({method:'POST',path:`${path(workspaceId,request)}/duplicate`,input:request.input,inputSchema:duplicateTaskInputSchema,responseSchema:duplicationResultResponseSchema.refine(response=>response.data.kind===request.kind&&response.data.projectId===request.projectId)})
  :prepareMutation({method:'POST',path:`${path(workspaceId,request)}/duplicate`,input:request.input,inputSchema:duplicateSectionInputSchema,responseSchema:duplicationResultResponseSchema.refine(response=>response.data.kind===request.kind&&response.data.projectId===request.projectId)});
}
