import type { ConfigureCutoffInput, RetryCutoffInput, CutoffReadinessDto, PlanningPeriodDto } from '@workloom/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { planningKeys } from '../planning/queries';
import { configureCutoffRequest, retryCutoffRequest } from './api';
import { cutoffKeys } from './queries';
export type CutoffVariables=IdempotentVariables&({kind:'configure';periodId:string;input:ConfigureCutoffInput}|{kind:'retry';periodId:string;input:RetryCutoffInput});
/** One page-owned ledger: changing period/view never replaces a pending or unknown command. */
export function useCutoffWorkspace(actorId:string,workspaceId:string,projectId:string){
 const client=useQueryClient();
 const observed=useRef(new Map<string,string>());
 const observeReadiness=useCallback((head:CutoffReadinessDto,readAt:number)=>{
  const key=planningKeys.period(actorId,workspaceId,head.periodId);
  const cached=client.getQueryData<PlanningPeriodDto>(key);
  if(!cached||cached.projectId!==projectId||cached.revision>head.periodRevision)return;
  const baselineId=head.baseline?.id??null;
  if(cached.revision===head.periodRevision&&cached.projectBaselineId===baselineId)return;
  const identity=`${head.periodRevision}:${baselineId??''}:${readAt}`;
  if(observed.current.get(head.periodId)===identity)return;
  observed.current.set(head.periodId,identity);
  // A worker may have changed these sources without a command from this page.
  // Refetch real DTOs and immutable baselines; never synthesize them from readiness.
  void client.invalidateQueries({queryKey:key,exact:true});
  void client.invalidateQueries({queryKey:planningKeys.periods(actorId,workspaceId,projectId),exact:true});
  void client.invalidateQueries({queryKey:planningKeys.baselines(actorId,workspaceId,head.periodId),exact:true});
 },[actorId,workspaceId,projectId,client]);
 const command=useIdempotentMutation({prepare:(variables:CutoffVariables)=>variables.kind==='configure'?configureCutoffRequest(workspaceId,variables.periodId,variables.input):retryCutoffRequest(workspaceId,variables.periodId,variables.input),onSuccess:(_receipt,variables)=>{
  // An exact replay may return an older approval. Only a current authorized GET supplies the head.
  void client.invalidateQueries({queryKey:cutoffKeys.readiness(actorId,workspaceId,variables.periodId),exact:true});
  void client.invalidateQueries({queryKey:planningKeys.period(actorId,workspaceId,variables.periodId)});
  void client.invalidateQueries({queryKey:planningKeys.periods(actorId,workspaceId,projectId),exact:true});
 }});
 return {actorId,workspaceId,observeReadiness,command,held:command.pendingCommand??command.uncertain,refresh:(periodId:string)=>client.invalidateQueries({queryKey:cutoffKeys.readiness(actorId,workspaceId,periodId),exact:true})};
}
export type CutoffWorkspace=ReturnType<typeof useCutoffWorkspace>;
