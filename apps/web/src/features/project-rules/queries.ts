import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetProjectRulesInput } from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { fetchProjectRules, setProjectRulesRequest } from './api';

export const projectRulesKey = (actorId: string, workspaceId: string, projectId: string) => [...queryKeys.workspace(actorId, workspaceId), 'project-rules', projectId] as const;

export function useProjectRules(actorId: string, workspaceId: string, projectId: string, enabled = true) {
  return useQuery({ queryKey: projectRulesKey(actorId, workspaceId, projectId), queryFn: ({ signal }) => fetchProjectRules(workspaceId, projectId, signal), enabled: enabled && isUuid(projectId), retry: false, staleTime: 30_000 });
}

/** `onSaved` lives on the hook so it survives the form being re-keyed by the new revision. */
export function useSaveProjectRules(actorId: string, workspaceId: string, projectId: string, onSaved?: () => void) {
  const client = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: IdempotentVariables & { input: SetProjectRulesInput }) => setProjectRulesRequest(workspaceId, projectId, input),
    onSuccess: saved => { client.setQueryData(projectRulesKey(actorId, workspaceId, projectId), saved); onSaved?.(); },
  });
}
