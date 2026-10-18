import {
  attachTaskProjectInputSchema, changeTaskProjectPlacementStateInputSchema,
  projectRowsResponseSchema, taskProjectPlacementResponseSchema, taskProjectPlacementsResponseSchema,
  updateTaskProjectPlacementInputSchema,
  type AttachTaskProjectInput, type ChangeTaskProjectPlacementStateInput,
  type ProjectRowDto, type UpdateTaskProjectPlacementInput,
} from '@workloom/contracts';
import { ApiError, apiGet, prepareMutation } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export interface ProjectRowsPage { rows: ProjectRowDto[]; nextCursor: string | null }
export async function fetchProjectRows(workspaceId: string, projectId: string, cursor: string | null, includeArchived: boolean, signal?: AbortSignal): Promise<ProjectRowsPage> {
  const params = new URLSearchParams({ limit: '100', includeArchived: String(includeArchived) });
  if (cursor) params.set('cursor', cursor);
  const response = await apiGet(`${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}/rows?${params}`, projectRowsResponseSchema, signal);
  return { rows: response.data, nextCursor: response.meta.nextCursor ?? null };
}
export async function fetchTaskPlacements(workspaceId: string, taskId: string, signal?: AbortSignal) {
  const { data } = await apiGet(`${workspacePath(workspaceId)}/tasks/${encodeURIComponent(taskId)}/placements`, taskProjectPlacementsResponseSchema, signal);
  if (data.some(item => item.taskId !== taskId.toLowerCase() || item.workspaceId !== workspaceId.toLowerCase())) throw new ApiError({ kind: 'invalid_response', status: 200 });
  return data;
}
export type PlacementCommand =
  | { kind: 'attach'; taskId: string; input: AttachTaskProjectInput }
  | { kind: 'update'; placementId: string; input: UpdateTaskProjectPlacementInput }
  | { kind: 'detach' | 'restore'; placementId: string; input: ChangeTaskProjectPlacementStateInput };
export function placementRequest(workspaceId: string, command: PlacementCommand) {
  const base = workspacePath(workspaceId);
  if (command.kind === 'attach') return prepareMutation({ method: 'POST', path: `${base}/tasks/${encodeURIComponent(command.taskId)}/placements`, input: command.input, inputSchema: attachTaskProjectInputSchema, responseSchema: taskProjectPlacementResponseSchema });
  const path = `${base}/task-project-placements/${encodeURIComponent(command.placementId)}`;
  if (command.kind === 'update') return prepareMutation({ method: 'PATCH', path, input: command.input, inputSchema: updateTaskProjectPlacementInputSchema, responseSchema: taskProjectPlacementResponseSchema });
  return prepareMutation({ method: 'POST', path: `${path}/${command.kind}`, input: command.input, inputSchema: changeTaskProjectPlacementStateInputSchema, responseSchema: taskProjectPlacementResponseSchema });
}
