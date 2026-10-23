import { projectRulesResponseSchema, setProjectRulesInputSchema, type SetProjectRulesInput } from '@workloom/contracts';
import { apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export const projectRulesPath = (workspaceId: string, projectId: string) => `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/rules`;
export async function fetchProjectRules(workspaceId: string, projectId: string, signal?: AbortSignal) {
  return (await apiGet(projectRulesPath(workspaceId, projectId), projectRulesResponseSchema, signal)).data;
}
export function setProjectRulesRequest(workspaceId: string, projectId: string, input: SetProjectRulesInput) {
  return prepareMutation({ method: 'PUT', path: projectRulesPath(workspaceId, projectId), input, inputSchema: setProjectRulesInputSchema, responseSchema: projectRulesResponseSchema });
}
