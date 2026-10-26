import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CreateProjectInput,
  CreateSectionInput,
  ProjectDto,
  UpdateProjectInput,
  UpdateSectionInput,
} from '@workloom/contracts';
import { useCallback } from 'react';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { useIdempotentMutation, type IdempotentVariables } from '../../lib/useIdempotentMutation';
import {
  createProjectRequest,
  createSectionRequest,
  fetchProject,
  fetchProjects,
  fetchSections,
  fetchStatuses,
  updateProjectRequest,
  updateSectionRequest,
  type ProjectList,
} from './api';

export function useProjectsQuery(actorId: string, workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.projectList(actorId, workspaceId),
    queryFn: ({ signal }) => fetchProjects(workspaceId, signal),
  });
}

/** Disabled for malformed IDs, which the page treats as unavailable without a request. */
export function useProjectQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.project(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchProject(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function useSectionsQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.sections(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchSections(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

export function useStatusesQuery(actorId: string, workspaceId: string, projectId: string) {
  return useQuery({
    queryKey: queryKeys.statuses(actorId, workspaceId, projectId),
    queryFn: ({ signal }) => fetchStatuses(workspaceId, projectId, signal),
    enabled: isUuid(projectId),
  });
}

/** Fetches the project now, bypassing the cache, e.g. to recover from a revision conflict. */
export function useReloadProject(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (projectId: string) => {
      void invalidateProjectList(queryClient, actorId, workspaceId);
      return queryClient.fetchQuery({
        queryKey: queryKeys.project(actorId, workspaceId, projectId),
        queryFn: ({ signal }) => fetchProject(workspaceId, projectId, signal),
        staleTime: 0,
      });
    },
    [actorId, workspaceId, queryClient],
  );
}

/** Fetches the project's sections now, bypassing the cache, e.g. after a section conflict. */
export function useReloadSections(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (projectId: string) =>
      queryClient.fetchQuery({
        queryKey: queryKeys.sections(actorId, workspaceId, projectId),
        queryFn: ({ signal }) => fetchSections(workspaceId, projectId, signal),
        staleTime: 0,
      }),
    [actorId, workspaceId, queryClient],
  );
}

export function invalidateProjectList(queryClient: QueryClient, actorId: string, workspaceId: string) {
  return queryClient.invalidateQueries({ queryKey: queryKeys.projectList(actorId, workspaceId) });
}

/** The project itself and the list; its sections and statuses are left alone. */
export function invalidateProject(queryClient: QueryClient, actorId: string, workspaceId: string, projectId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.project(actorId, workspaceId, projectId), exact: true }),
    invalidateProjectList(queryClient, actorId, workspaceId),
  ]);
}

export function invalidateSections(queryClient: QueryClient, actorId: string, workspaceId: string, projectId: string) {
  void queryClient.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'generic-reports'] });
  return queryClient.invalidateQueries({ queryKey: queryKeys.sections(actorId, workspaceId, projectId), exact: true });
}

export function invalidateStatuses(queryClient: QueryClient, actorId: string, workspaceId: string, projectId: string) {
  void queryClient.invalidateQueries({ queryKey: [...queryKeys.workspace(actorId, workspaceId), 'generic-reports'] });
  return queryClient.invalidateQueries({ queryKey: queryKeys.statuses(actorId, workspaceId, projectId), exact: true });
}

function isNewer(cached: { revision: number } | undefined, next: { revision: number }): boolean {
  return cached === undefined || next.revision >= cached.revision;
}

/**
 * Applies a confirmed project to entries that are already cached, never to an
 * older revision, then refetches the list. A project missing from the list is
 * left to that refetch: a replayed answer may describe a project archived since.
 * Entries of a workspace the user has left are not recreated.
 */
export function storeProject(queryClient: QueryClient, actorId: string, workspaceId: string, project: ProjectDto) {
  const detailKey = queryKeys.project(actorId, workspaceId, project.id);
  const cached = queryClient.getQueryData<ProjectDto>(detailKey);
  if (cached && isNewer(cached, project)) queryClient.setQueryData(detailKey, project);

  queryClient.setQueryData<ProjectList>(queryKeys.projectList(actorId, workspaceId), (list) => {
    if (!list) return list;
    const index = list.projects.findIndex((item) => item.id === project.id);
    if (index === -1) return list;
    if (!isNewer(list.projects[index], project)) return list;
    return { ...list, projects: list.projects.map((item, i) => (i === index ? project : item)) };
  });
  return invalidateProjectList(queryClient, actorId, workspaceId);
}

export interface CreateProjectVariables extends IdempotentVariables {
  input: CreateProjectInput;
}

export function useCreateProjectMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ input }: CreateProjectVariables) => createProjectRequest(workspaceId, input),
    onSuccess: (project) => void storeProject(queryClient, actorId, workspaceId, project),
  });
}

export interface UpdateProjectVariables extends IdempotentVariables {
  projectId: string;
  input: UpdateProjectInput;
}

export function useUpdateProjectMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ projectId, input }: UpdateProjectVariables) => updateProjectRequest(workspaceId, projectId, input),
    onSuccess: (project) => void storeProject(queryClient, actorId, workspaceId, project),
  });
}

export interface CreateSectionVariables extends IdempotentVariables {
  projectId: string;
  input: CreateSectionInput;
}

export function useCreateSectionMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ projectId, input }: CreateSectionVariables) => createSectionRequest(workspaceId, projectId, input),
    onSuccess: (section) => void invalidateSections(queryClient, actorId, workspaceId, section.projectId),
  });
}

export interface UpdateSectionVariables extends IdempotentVariables {
  sectionId: string;
  input: UpdateSectionInput;
}

/** Also refreshes the project's task lists, which may be filtered by the section. */
export function useUpdateSectionMutation(actorId: string, workspaceId: string) {
  const queryClient = useQueryClient();
  return useIdempotentMutation({
    prepare: ({ sectionId, input }: UpdateSectionVariables) => updateSectionRequest(workspaceId, sectionId, input),
    onSuccess: (section) => {
      void invalidateSections(queryClient, actorId, workspaceId, section.projectId);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectTaskLists(actorId, workspaceId, section.projectId),
      });
    },
  });
}
