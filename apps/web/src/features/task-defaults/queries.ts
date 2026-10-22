import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetTaskDefaultsInput } from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import { fetchTaskDefaults, setTaskDefaultsRequest } from './api';

export const taskDefaultsKey = (actorId: string, workspaceId: string, projectId: string) => [...queryKeys.workspace(actorId, workspaceId), 'task-defaults', projectId] as const;

export function useTaskDefaults(actorId: string, workspaceId: string, projectId: string, enabled = true) {
  return useQuery({ queryKey: taskDefaultsKey(actorId, workspaceId, projectId), queryFn: ({ signal }) => fetchTaskDefaults(workspaceId, projectId, signal), enabled: enabled && isUuid(projectId), retry: false });
}

/** `onSaved` lives on the hook, not the call: the form is re-keyed when the saved revision arrives, which would drop a per-call callback. */
export function useSaveTaskDefaults(actorId: string, workspaceId: string, projectId: string, onSaved?: () => void) {
  const client = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: IdempotentVariables & { input: SetTaskDefaultsInput }) => setTaskDefaultsRequest(workspaceId, projectId, input),
    onSuccess: saved => { client.setQueryData(taskDefaultsKey(actorId, workspaceId, projectId), saved); onSaved?.(); },
  });
}
