import {
  createProjectInputSchema,
  createSectionInputSchema,
  projectListResponseSchema,
  projectResponseSchema,
  sectionListResponseSchema,
  sectionResponseSchema,
  taskStatusListResponseSchema,
  updateProjectInputSchema,
  updateSectionInputSchema,
  type CreateProjectInput,
  type CreateSectionInput,
  type ProjectDto,
  type SectionDto,
  type TaskStatusDto,
  type UpdateProjectInput,
  type UpdateSectionInput,
} from '@workloom/contracts';
import { apiGet, prepareMutation, sendMutation, type MutationOptions } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

function projectPath(workspaceId: string, projectId: string): string {
  return `${workspacePath(workspaceId)}/projects/${encodeURIComponent(projectId)}`;
}

export interface ProjectList {
  projects: ProjectDto[];
  /**
   * The P1a contract returns every project at once, so this is null. It stays
   * exposed so the UI never presents a partial list as the whole one.
   */
  nextCursor: string | null;
}

export async function fetchProjects(workspaceId: string, signal?: AbortSignal, includeArchived = false): Promise<ProjectList> {
  const { data, meta } = await apiGet(`${workspacePath(workspaceId)}/projects${includeArchived ? '?includeArchived=true' : ''}`, projectListResponseSchema, signal);
  return { projects: data, nextCursor: meta.nextCursor ?? null };
}

export async function fetchProject(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<ProjectDto> {
  return (await apiGet(projectPath(workspaceId, projectId), projectResponseSchema, signal)).data;
}

export async function fetchSections(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<SectionDto[]> {
  return (await apiGet(`${projectPath(workspaceId, projectId)}/sections`, sectionListResponseSchema, signal)).data;
}

export async function fetchStatuses(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<TaskStatusDto[]> {
  return (await apiGet(`${projectPath(workspaceId, projectId)}/statuses`, taskStatusListResponseSchema, signal)).data;
}

export function createProjectRequest(workspaceId: string, input: CreateProjectInput) {
  return prepareMutation({
    method: 'POST',
    path: `${workspacePath(workspaceId)}/projects`,
    input,
    inputSchema: createProjectInputSchema,
    responseSchema: projectResponseSchema,
  });
}

export function updateProjectRequest(workspaceId: string, projectId: string, input: UpdateProjectInput) {
  return prepareMutation({
    method: 'PATCH',
    path: projectPath(workspaceId, projectId),
    input,
    inputSchema: updateProjectInputSchema,
    responseSchema: projectResponseSchema,
  });
}

export function createSectionRequest(workspaceId: string, projectId: string, input: CreateSectionInput) {
  return prepareMutation({
    method: 'POST',
    path: `${projectPath(workspaceId, projectId)}/sections`,
    input,
    inputSchema: createSectionInputSchema,
    responseSchema: sectionResponseSchema,
  });
}

export function updateSectionRequest(workspaceId: string, sectionId: string, input: UpdateSectionInput) {
  return prepareMutation({
    method: 'PATCH',
    path: `${workspacePath(workspaceId)}/sections/${encodeURIComponent(sectionId)}`,
    input,
    inputSchema: updateSectionInputSchema,
    responseSchema: sectionResponseSchema,
  });
}

export async function createProject(
  workspaceId: string,
  input: CreateProjectInput,
  options: MutationOptions,
): Promise<ProjectDto> {
  return (await sendMutation(createProjectRequest(workspaceId, input), options)).data;
}

export async function updateProject(
  workspaceId: string,
  projectId: string,
  input: UpdateProjectInput,
  options: MutationOptions,
): Promise<ProjectDto> {
  return (await sendMutation(updateProjectRequest(workspaceId, projectId, input), options)).data;
}

export async function createSection(
  workspaceId: string,
  projectId: string,
  input: CreateSectionInput,
  options: MutationOptions,
): Promise<SectionDto> {
  return (await sendMutation(createSectionRequest(workspaceId, projectId, input), options)).data;
}

export async function updateSection(
  workspaceId: string,
  sectionId: string,
  input: UpdateSectionInput,
  options: MutationOptions,
): Promise<SectionDto> {
  return (await sendMutation(updateSectionRequest(workspaceId, sectionId, input), options)).data;
}
