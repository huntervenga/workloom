import { duplicateProjectInputSchema, duplicateProjectResponseSchema, type DuplicateProjectInput } from '@workloom/contracts';
import { prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export function duplicateProjectRequest(workspaceId: string, projectId: string, input: DuplicateProjectInput) {
  return prepareMutation({ method: 'POST', path: `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/duplicate`, input, inputSchema: duplicateProjectInputSchema, responseSchema: duplicateProjectResponseSchema });
}
