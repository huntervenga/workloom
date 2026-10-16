import { useCurrentSearchParams } from '../../lib/useCurrentSearchParams';
import { myTasksQuerySchema } from '@workloom/contracts';
import type { MyTasksFilters } from './api';

/** A repeated owned key is ambiguous; it receives the same safe default as invalid input. */
function single(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  return values.length === 1 ? values[0] : undefined;
}

/** Only the applied self-list lens is read here. Identity, paging and unrelated URL keys are excluded. */
export function readMyTasksFilters(params: URLSearchParams): MyTasksFilters {
  const relation = myTasksQuerySchema.shape.relation.safeParse(single(params, 'relation'));
  const completion = myTasksQuerySchema.shape.completion.safeParse(single(params, 'completion'));
  const archived = myTasksQuerySchema.shape.includeArchived.safeParse(single(params, 'includeArchived'));
  const search = myTasksQuerySchema.shape.search.safeParse(single(params, 'search'));
  return { relation: relation.success ? relation.data : 'all', completion: completion.success ? completion.data : 'open', includeArchived: archived.success ? archived.data : false,
    ...(search.success && search.data ? { search: search.data } : {}) };
}

/** Each control owns one parameter; retained handlers always patch the current router head. */
export function useMyTasksLens() {
  const [params, update] = useCurrentSearchParams();
  const filters = readMyTasksFilters(params);
  const changeRelation = (value: string) => update(current => { if (value === 'assigned' || value === 'participating') current.set('relation', value); else current.delete('relation'); return current; });
  const changeCompletion = (value: string) => update(current => { if (value === 'closed' || value === 'all') current.set('completion', value); else current.delete('completion'); return current; });
  const changeArchived = (value: boolean) => update(current => { if (value) current.set('includeArchived', 'true'); else current.delete('includeArchived'); return current; });
  const applySearch = (value: string) => {
    const result = myTasksQuerySchema.shape.search.safeParse(value);
    if (!result.success) return false;
    return update(current => { if (result.data) current.set('search', result.data); else current.delete('search'); return current; });
  };
  return { filters, changeRelation, changeCompletion, changeArchived, applySearch };
}
