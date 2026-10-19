import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { TaskFieldValueDto } from '@workloom/contracts';
import { queryKeys } from '../../lib/queryKeys';
function coversValue(key: QueryKey, prefixLength: number, value: TaskFieldValueDto): boolean {
  return key[prefixLength] === 'task' ? key[prefixLength + 1] === value.taskId
    : key[prefixLength] === 'project' && key[prefixLength + 1] === value.projectId && Array.isArray(key[prefixLength + 2]) && (key[prefixLength + 2] as unknown[]).includes(value.taskId);
}
function mergeRows(rows: readonly TaskFieldValueDto[], values: readonly TaskFieldValueDto[]): TaskFieldValueDto[] {
  let next = [...rows];
  for (const value of values) {
    const index = next.findIndex(row => row.taskId === value.taskId && row.fieldId === value.fieldId);
    const current = index < 0 ? undefined : next[index];
    if (current && current.revision >= value.revision) continue;
    next = index < 0 ? [...next, value] : next.map((row, position) => position === index ? value : row);
  }
  return next;
}
/** Merge only persisted ACK projections into existing exact value scopes; never synthesize rows. */
export function storeFieldAcks(client: QueryClient, actor: string, workspace: string, values: readonly TaskFieldValueDto[]) {
  const prefix = queryKeys.fieldValues(actor, workspace);
  for (const [key, rows] of client.getQueriesData<TaskFieldValueDto[]>({ queryKey: prefix })) {
    if (!Array.isArray(rows)) continue;
    const eligible = values.filter(value => value.workspaceId === workspace && coversValue(key, prefix.length, value));
    if (eligible.length) client.setQueryData(key, mergeRows(rows, eligible));
  }
}
/**
 * Cancel older reads before merging their confirmed successor. Cancellation can revert a query
 * to its fetch-start snapshot, so preserve already-cached newer heads before cancellation too.
 */
export async function reconcileFieldAcks(client: QueryClient, actor: string, workspace: string, values: readonly TaskFieldValueDto[]): Promise<void> {
  const prefix = queryKeys.fieldValues(actor, workspace);
  const eligible = values.filter(value => value.workspaceId === workspace);
  if (!eligible.length) return;
  const filter = { queryKey: prefix, predicate: (query: { queryKey: QueryKey }) => eligible.some(value => coversValue(query.queryKey, prefix.length, value)) };
  const snapshots = client.getQueryCache().findAll(filter).flatMap(query => Array.isArray(query.state.data) ? [{ query, rows: query.state.data as TaskFieldValueDto[] }] : []);
  await client.cancelQueries(filter);
  for (const { query, rows } of snapshots) {
    // A departure may remove the old actor's scope while cancellation settles; never recreate it.
    if (client.getQueryCache().find({ queryKey: query.queryKey, exact: true }) !== query) continue;
    const current = client.getQueryData<TaskFieldValueDto[]>(query.queryKey);
    client.setQueryData(query.queryKey, mergeRows(Array.isArray(current) ? current : [], rows));
  }
  storeFieldAcks(client, actor, workspace, eligible);
}
