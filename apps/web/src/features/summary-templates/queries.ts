import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { reportKeys } from '../generic-reports/queries';
import { fetchSummaryTemplates, summaryTemplateRequest, type SummaryTemplateAction } from './api';
export const summaryTemplateKeys={catalog:(actor:string,workspace:string,project:string)=>[...reportKeys.root(actor,workspace),'summary-templates',project]as const};
/** Page-owned commands survive closing a section editor with an unknown outcome. */
export function useSummaryTemplateWorkspace(actor:string,workspace:string,project:string,enabled:boolean){
 const client=useQueryClient(),[active,setActive]=useState(false),key=summaryTemplateKeys.catalog(actor,workspace,project);
 const catalog=useQuery({queryKey:key,queryFn:({signal})=>fetchSummaryTemplates(workspace,project,signal),enabled:enabled&&active,retry:false});
 const command=useIdempotentMutation({prepare:({action}:IdempotentVariables&{action:SummaryTemplateAction})=>summaryTemplateRequest(workspace,project,action),onSuccess:async data=>{client.setQueryData(key,data);await client.invalidateQueries({queryKey:reportKeys.root(actor,workspace)});}});
 const activate=useCallback(()=>setActive(true),[]);
 return{catalog,command,activate};
}
export type SummaryTemplateWorkspace=ReturnType<typeof useSummaryTemplateWorkspace>;
