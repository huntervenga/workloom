import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { queryKeys } from '../../lib/queryKeys';
import { ApiError } from '../../lib/api';
import { invalidateTasks } from '../tasks/queries';
import { invalidateSections } from '../projects/queries';
import { reportKeys } from '../generic-reports/queries';
import { duplicateRequest, previewDuplication, type DuplicationPreviewRequest, type DuplicationWriteRequest } from './api';
export function useDuplicationPreview(actorId:string,workspaceId:string,request:DuplicationPreviewRequest|null,enabled:boolean){
 return useQuery({queryKey:[...queryKeys.workspace(actorId,workspaceId),'duplication-preview',request],queryFn:({signal})=>{if(!request)throw new ApiError({kind:'invalid_input',status:null});return previewDuplication(workspaceId,request,signal);},enabled:enabled&&request!==null,staleTime:0,retry:false,refetchOnWindowFocus:true});
}
export function useDuplicateCommand(actorId:string,workspaceId:string){
 const client=useQueryClient();
 return useIdempotentMutation({prepare:({request}:IdempotentVariables&{request:DuplicationWriteRequest})=>duplicateRequest(workspaceId,request),onSuccess:async(result,_variables,ack)=>{
  if(ack.actorId!==null&&ack.actorId!==actorId)return;
  await Promise.all([invalidateTasks(client,actorId,workspaceId,result.projectId),invalidateSections(client,actorId,workspaceId,result.projectId),client.invalidateQueries({queryKey:queryKeys.projectFieldValues(actorId,workspaceId,result.projectId)}),client.invalidateQueries({queryKey:reportKeys.root(actorId,workspaceId)}),client.invalidateQueries({queryKey:[...queryKeys.workspace(actorId,workspaceId),'workspace-reports']})]);
 }});
}
