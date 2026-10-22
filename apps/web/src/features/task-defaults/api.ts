import { setTaskDefaultsInputSchema, taskDefaultsResponseSchema, type SetTaskDefaultsInput } from '@workloom/contracts';
import { apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export const taskDefaultsPath = (workspaceId: string, projectId: string) => `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/task-defaults`;
export async function fetchTaskDefaults(workspaceId: string, projectId: string, signal?: AbortSignal) {
  return (await apiGet(taskDefaultsPath(workspaceId, projectId), taskDefaultsResponseSchema, signal)).data;
}
export function setTaskDefaultsRequest(workspaceId: string, projectId: string, input: SetTaskDefaultsInput) {
  return prepareMutation({ method: 'PUT', path: taskDefaultsPath(workspaceId, projectId), input, inputSchema: setTaskDefaultsInputSchema, responseSchema: taskDefaultsResponseSchema });
}
