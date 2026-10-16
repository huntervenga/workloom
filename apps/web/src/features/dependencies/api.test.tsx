import { describe, expect, it } from 'vitest';
import { alpha, installFakeApi, json, ok } from '../../test/fakeApi';
import { fetchDependencyGraph, fetchTaskBlocking, fetchDependencyPage } from './api';
import { blocking, graph, PROJECT_B, PROJECT_ID, rootPath, taskAt } from './test/fixtures';

const graphPath = `${rootPath}/projects/${PROJECT_ID}/graph`;
describe('dependency read boundaries', () => {
  it('serializes normalized explicit roots and depth once, without extra whole-project requests', async () => {
    const a = taskAt(1), b = taskAt(2, PROJECT_B);
    const { calls } = installFakeApi({ [ `GET ${graphPath}` ]: () => ok(graph([a, b], [a.id])) });
    const result = await fetchDependencyGraph(alpha.id, PROJECT_ID, { rootTaskIds: [a.id], neighborDepth: 1 });
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({ rootTaskIds: a.id, neighborDepth: '1' });
    expect(result.nodes[1]?.context.project.name).toBe('Другой проект');
  });

  it.each(['project', 'status'] as const)('refuses a graph whose %s context belongs to a different task', async mismatch => {
    const task = taskAt(1), result = graph([task]);
    const row = result.nodes[0];
    if (!row) throw new Error('Expected graph row');
    if (mismatch === 'project') row.context.project.id = PROJECT_B;
    else row.context.status.id = PROJECT_B;
    installFakeApi({ [ `GET ${graphPath}` ]: () => ok(result) });
    await expect(fetchDependencyGraph(alpha.id, PROJECT_ID, { rootTaskIds: [task.id], neighborDepth: 1 })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('keeps authoritative blocker totals independent from cursor pages and forwards the cursor unchanged', async () => {
    const task = taskAt(2), predecessor = taskAt(1);
    const response = blocking(task, predecessor, 'enforce'); response.summary.unresolvedCount = 25;
    const { calls } = installFakeApi({ [`GET ${rootPath}/tasks/${task.id}/blocking`]: () => json(200, { data: response, meta: { requestId: 'req_page', nextCursor: 'signed+opaque/cursor' } }) });
    const page = await fetchTaskBlocking(alpha.id, task.id, { limit: 10 });
    expect(page.data.blockers).toHaveLength(1);
    expect(page.data.summary).toMatchObject({ unresolvedCount: 25, canStart: false, canComplete: false });
    await fetchTaskBlocking(alpha.id, task.id, { limit: 10, cursor: page.meta.nextCursor ?? undefined });
    expect(calls[1]?.searchParams.get('cursor')).toBe('signed+opaque/cursor');
  });

  it('rejects oversized explicit roots locally rather than silently querying a subset', async () => {
    const { calls } = installFakeApi({});
    await expect(fetchDependencyGraph(alpha.id, PROJECT_ID, { rootTaskIds: Array.from({ length: 101 }, (_, index) => taskAt(index + 1).id), neighborDepth: 0 })).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('keeps list cursor metadata and the explicit removed-state filter', async () => {
    const task = taskAt(1);
    const { calls } = installFakeApi({ [`GET ${rootPath}/dependencies`]: () => json(200, { data: [], meta: { requestId: 'req_page', nextCursor: 'edge_next' } }) });
    const result = await fetchDependencyPage(alpha.id, { taskId: task.id, direction: 'both', state: 'all', limit: 10 });
    expect(result.meta.nextCursor).toBe('edge_next');
    expect(Object.fromEntries(calls[0]?.searchParams ?? [])).toEqual({ taskId: task.id, direction: 'both', state: 'all', limit: '10' });
  });
});
