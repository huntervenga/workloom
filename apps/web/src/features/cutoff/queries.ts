import { useQuery } from '@tanstack/react-query';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { fetchCutoffReadiness } from './api';
export const cutoffKeys={readiness:(actorId:string,workspaceId:string,periodId:string)=>[...queryKeys.workspace(actorId,workspaceId),'cutoff',periodId.toLowerCase()] as const};
export function useCutoffReadiness(actorId:string,workspaceId:string,periodId:string){return useQuery({queryKey:cutoffKeys.readiness(actorId,workspaceId,periodId),queryFn:({signal})=>fetchCutoffReadiness(workspaceId,periodId,signal),enabled:isUuid(periodId),staleTime:0});}
