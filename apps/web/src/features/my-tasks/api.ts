import { myTasksQuerySchema, myTasksResponseSchema, type MyTaskDto, type MyTasksQuery } from '@workloom/contracts';
import { ApiError, apiGet } from '../../lib/api';
import { workspacePath } from '../workspace/queries';

export type MyTasksFilters = Omit<MyTasksQuery, 'limit' | 'cursor'>;
export interface MyTasksPage { readonly items: MyTaskDto[]; readonly nextCursor: string | null }
export function myTasksSearchParams(filters: MyTasksFilters, cursor: string | null): URLSearchParams {
  const parsed = myTasksQuerySchema.safeParse({ ...filters, limit: 50, ...(cursor ? { cursor } : {}) });
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined && value !== '') params.set(key, String(value));
  return params;
}
export async function fetchMyTasks(workspaceId: string, filters: MyTasksFilters, cursor: string | null, signal?: AbortSignal): Promise<MyTasksPage> {
  const response = await apiGet(`${workspacePath(workspaceId)}/my-tasks?${myTasksSearchParams(filters, cursor).toString()}`, myTasksResponseSchema, signal);
  return { items: response.data, nextCursor: response.meta.nextCursor ?? null };
}

/** Live keyset pages can overlap after edits. Count unique loaded identities, never a total. */
export function uniqueLoadedMyTasks(pages: readonly MyTasksPage[]): MyTaskDto[] {
  const rows = new Map<string, MyTaskDto>();
  for (const page of pages) for (const row of page.items) rows.set(row.task.id, row);
  return [...rows.values()];
}
