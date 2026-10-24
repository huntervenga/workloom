import { applyProjectSettingsInputSchema, applyProjectSettingsResponseSchema, duplicateProjectInputSchema, duplicateProjectResponseSchema, type ApplyProjectSettingsInput, type DuplicateProjectInput } from '@workloom/contracts';
import { prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export function duplicateProjectRequest(workspaceId: string, projectId: string, input: DuplicateProjectInput) {
  return prepareMutation({ method: 'POST', path: `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/duplicate`, input, inputSchema: duplicateProjectInputSchema, responseSchema: duplicateProjectResponseSchema });
}

export function applyProjectSettingsRequest(workspaceId: string, projectId: string, input: ApplyProjectSettingsInput) {
  return prepareMutation({ method: 'POST', path: `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/apply-settings`, input, inputSchema: applyProjectSettingsInputSchema, responseSchema: applyProjectSettingsResponseSchema });
}
