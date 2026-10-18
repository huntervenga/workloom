import {useQuery,useQueryClient} from '@tanstack/react-query';
import {useSyncExternalStore,useCallback} from 'react';
import type {SetTaskFieldPolicyInput,WorkspaceDto} from '@workloom/contracts';
import {queryKeys} from '../../lib/queryKeys';
import {useIdempotentMutation,type IdempotentVariables} from '../../lib/useIdempotentMutation';
import {fetchFieldPolicy,fetchFieldPolicyState,setFieldPolicyRequest} from './policy-api';
export const fieldPolicyKeys={
  all:(actorId:string,workspaceId:string)=>[...queryKeys.fields(actorId,workspaceId),'policies'] as const,
  policy:(actorId:string,workspaceId:string,fieldId:string)=>[...queryKeys.fields(actorId,workspaceId),'policies',fieldId.toLowerCase()] as const,
  state:(actorId:string,workspaceId:string,taskId:string,fieldId:string)=>[...queryKeys.fields(actorId,workspaceId),'policies',fieldId.toLowerCase(),'state',taskId.toLowerCase()] as const,
};
export function useFieldPolicyQuery(actorId:string,workspaceId:string,fieldId:string,enabled=true) {
  return useQuery({queryKey:fieldPolicyKeys.policy(actorId,workspaceId,fieldId),queryFn:({signal})=>fetchFieldPolicy(workspaceId,fieldId,signal),enabled});
}
export function useFieldPolicyStateQuery(actorId:string,workspaceId:string,taskId:string,fieldId:string) {
  return useQuery({queryKey:fieldPolicyKeys.state(actorId,workspaceId,taskId,fieldId),queryFn:({signal})=>fetchFieldPolicyState(workspaceId,taskId,fieldId,signal)});
}
/** Read existing authoritative workspace ownership; never starts a second workspace root request. */
export function useCurrentFieldPolicyOwner(actorId:string,workspaceId:string) {
  const client=useQueryClient(),key=queryKeys.workspace(actorId,workspaceId);
  const subscribe=useCallback((notify:()=>void)=>client.getQueryCache().subscribe(notify),[client]);
  return useSyncExternalStore(subscribe,()=>{
    const state=client.getQueryState<WorkspaceDto>(key);
    return state?.status==='success'&&state.fetchStatus==='idle'&&!state.isInvalidated&&state.data?.role==='owner';
  },()=>false);
}
export interface SetFieldPolicyVariables extends IdempotentVariables {fieldId:string;input:SetTaskFieldPolicyInput}
export function useSetFieldPolicyMutation(actorId:string,workspaceId:string) {
  const client=useQueryClient();
  return useIdempotentMutation({prepare:({fieldId,input}:SetFieldPolicyVariables)=>setFieldPolicyRequest(workspaceId,fieldId,input),
    onSuccess:(policy)=>{void client.invalidateQueries({queryKey:fieldPolicyKeys.policy(actorId,workspaceId,policy.fieldId)});}});
}
