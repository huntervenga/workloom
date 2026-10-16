import { personalTablePreferenceResponseSchema, updatePersonalTablePreferenceInputSchema, type UpdatePersonalTablePreferenceInput } from '@workloom/contracts';
import { apiGet, prepareMutation } from '../../lib/api';
import { queryKeys } from '../../lib/queryKeys';
import { workspacePath } from '../workspace/queries';

export const preferenceKey = (actorId: string, workspaceId: string, projectId: string) => [...queryKeys.project(actorId, workspaceId, projectId), 'personal-table-preference'] as const;
const path = (workspaceId: string, projectId: string) => `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/table-preferences/me`;
function response(workspaceId: string, projectId: string, membershipId: string) {
  return personalTablePreferenceResponseSchema.refine(({ data }) => data.workspaceId === workspaceId.toLowerCase() && data.projectId === projectId.toLowerCase() && data.membershipId === membershipId.toLowerCase());
}
export async function fetchPersonalColumns(workspaceId: string, projectId: string, membershipId: string, signal?: AbortSignal) {
  return (await apiGet(path(workspaceId, projectId), response(workspaceId, projectId, membershipId), signal)).data;
}
export function setPersonalColumnsRequest(workspaceId: string, projectId: string, membershipId: string, input: UpdatePersonalTablePreferenceInput) {
  return prepareMutation({ method: 'PUT', path: path(workspaceId, projectId), input, inputSchema: updatePersonalTablePreferenceInputSchema, responseSchema: response(workspaceId, projectId, membershipId) });
}
