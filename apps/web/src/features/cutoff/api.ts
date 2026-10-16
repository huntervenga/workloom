import { configureCutoffInputSchema, retryCutoffInputSchema, cutoffReadinessResponseSchema, cutoffCommandResponseSchema, type ConfigureCutoffInput, type RetryCutoffInput } from '@workloom/contracts';
import { apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
const path=(workspaceId:string,periodId:string)=>`${workspacePath(workspaceId)}/periods/${encodeURIComponent(periodId)}`;
const same=(left:string,right:string)=>left===right.toLowerCase();
export async function fetchCutoffReadiness(workspaceId:string,periodId:string,signal?:AbortSignal){
 const response=await apiGet(`${path(workspaceId,periodId)}/cutoff-readiness`,cutoffReadinessResponseSchema.refine(({data})=>same(data.periodId,periodId)&&(!data.automation.grant||same(data.automation.grant.workspaceId,workspaceId)&&same(data.automation.grant.periodId,periodId))),signal);
 return response.data;
}
const responseFor=(workspaceId:string,periodId:string)=>cutoffCommandResponseSchema.refine(({data})=>same(data.periodId,periodId)&&same(data.grant.workspaceId,workspaceId)&&same(data.grant.periodId,periodId));
export function configureCutoffRequest(workspaceId:string,periodId:string,input:ConfigureCutoffInput){return prepareMutation({method:'PUT',path:`${path(workspaceId,periodId)}/cutoff-automation`,input,inputSchema:configureCutoffInputSchema,responseSchema:responseFor(workspaceId,periodId)});}
export function retryCutoffRequest(workspaceId:string,periodId:string,input:RetryCutoffInput){return prepareMutation({method:'POST',path:`${path(workspaceId,periodId)}/cutoff-retry`,input,inputSchema:retryCutoffInputSchema,responseSchema:responseFor(workspaceId,periodId)});}
