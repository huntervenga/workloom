import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { TaskDto } from '@workloom/contracts';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { fetchTaskPage } from '../tasks/api';
import { fetchProjects } from '../projects/api';

export function useTagProjectsQuery(actorId: string, workspaceId: string) {
  return useQuery({
    queryKey: [...queryKeys.projectList(actorId, workspaceId), 'with-archived'],
    queryFn: ({ signal }) => fetchProjects(workspaceId, signal, true),
  });
}

interface Cursor { projectIndex: number; cursor: string | null }
interface Page { tasks: TaskDto[]; next: Cursor | null }
export interface TagTaskFilters { search: string; openOnly: boolean; includeArchived: boolean }

/** Reuses authorized, server-filtered project reads. Each batch is bounded; no silent task cap. */
export function useTagTasksQuery(actorId: string, workspaceId: string, tagId: string, projectIds: readonly string[], filters: TagTaskFilters, enabled: boolean) {
  return useInfiniteQuery({
    // Tag edits, task edits and collaboration refresh already invalidate this workspace prefix.
    queryKey: [...queryKeys.tasks(actorId, workspaceId), 'by-tag', tagId, projectIds, filters],
    initialPageParam: { projectIndex: 0, cursor: null } as Cursor,
    queryFn: async ({ signal, pageParam }): Promise<Page> => {
      let next: Cursor | null = pageParam;
      const tasks: TaskDto[] = [];
      for (let reads = 0; reads < 5 && next !== null && tasks.length < 100; reads++) {
        const projectId = projectIds[next.projectIndex];
        if (!projectId) { next = null; break; }
        const page = await fetchTaskPage(workspaceId, {
          projectId, tagId, search: filters.search, includeArchived: filters.includeArchived,
          ...(filters.openOnly ? { completion: 'open' as const } : {}),
        }, { signal, limit: 100, cursor: next.cursor });
        tasks.push(...page.tasks);
        next = page.nextCursor !== null ? { ...next, cursor: page.nextCursor }
          : next.projectIndex + 1 < projectIds.length ? { projectIndex: next.projectIndex + 1, cursor: null } : null;
      }
      return { tasks, next };
    },
    getNextPageParam: (page: Page) => page.next,
    enabled: enabled && isUuid(tagId),
  });
}
