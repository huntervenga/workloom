import { taskSearchResponseSchema } from '@workloom/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import { workspacePath } from '../workspace/queries';
import { useDebouncedValue } from './TaskFilters';

/** Bounded typeahead, with actor and workspace in the query key and stale text hidden during debounce. */
export function useTaskSearch(actorId: string, workspaceId: string, text: string) {
  const term = text.trim();
  const query = useDebouncedValue(term, 180);
  const ready = query === term && query.length >= 2 && query.length <= 200;
  const search = useQuery({
    queryKey: ['actor', actorId, 'workspace', workspaceId, 'tasks', 'search', query],
    enabled: ready,
    queryFn: async ({ signal }) => (await apiGet(
      `${workspacePath(workspaceId)}/task-search?${new URLSearchParams({ q: query })}`,
      taskSearchResponseSchema,
      signal,
    )).data,
  });
  return {
    results: ready && search.isSuccess ? search.data : undefined,
    pending: term.length >= 2 && (!ready || search.isPending),
    failed: ready && search.isError,
  };
}
