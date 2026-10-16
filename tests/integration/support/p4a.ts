// P4a frozen nine-route catalog over actual HTTP/PostgreSQL. No mock graph or client-side blocking.
import {
  dependencyGraphResponseSchema, graphLayoutResponseSchema, projectDependencyPolicyResponseSchema,
  taskBlockingResponseSchema, taskDependencyListResponseSchema, taskDependencyResponseSchema,
  type GraphPositionDto, type TaskDependencyDto,
} from '@workloom/contracts';

import { expectEnvelope } from './p1a.js';
import { P2aClient } from './p2a.js';
import type { PlanningHarness } from './p2a-fixture.js';

export class P4aClient extends P2aClient {
  edgeBody(predecessorTaskId: string, successorTaskId: string) {
    return { predecessorTaskId, successorTaskId, type: 'finish_to_start' as const, expectedAbsent: true as const };
  }
  async createEdge(predecessorTaskId: string, successorTaskId: string, key?: string) {
    return expectEnvelope(await this.post('/dependencies', this.edgeBody(predecessorTaskId, successorTaskId), key), 201, taskDependencyResponseSchema).data;
  }
  async setEdge(edge: TaskDependencyDto, state: 'active' | 'removed', key?: string) {
    return expectEnvelope(await this.patch(`/dependencies/${edge.id}`, { expectedRevision: edge.revision, state }, key), 200, taskDependencyResponseSchema).data;
  }
  async edges(query: { taskId: string; direction?: 'incoming' | 'outgoing' | 'both'; state?: 'active' | 'removed' | 'all' } | { projectId: string; state?: 'active' | 'removed' | 'all' }) {
    return this.all('/dependencies', taskDependencyListResponseSchema, query, 1);
  }
  async blocking(taskId: string, limit = 100, cursor?: string) {
    return expectEnvelope(await this.get(`/tasks/${taskId}/blocking?${new URLSearchParams({ limit: String(limit), ...(cursor ? { cursor } : {}) })}`), 200, taskBlockingResponseSchema);
  }
  async policy(projectId: string) {
    return expectEnvelope(await this.get(`/projects/${projectId}/dependency-policy`), 200, projectDependencyPolicyResponseSchema).data;
  }
  async setPolicy(projectId: string, mode: 'warn' | 'enforce', expectedRevision = 0, key?: string) {
    return expectEnvelope(await this.patch(`/projects/${projectId}/dependency-policy`, { mode, expectedRevision }, key), 200, projectDependencyPolicyResponseSchema).data;
  }
  graphPath(projectId: string, taskIds: readonly string[], depth = 1) {
    return `/projects/${projectId}/graph?${new URLSearchParams({ rootTaskIds: taskIds.join(','), neighborDepth: String(depth) })}`;
  }
  async graph(projectId: string, taskIds: readonly string[], depth = 1) {
    return expectEnvelope(await this.get(this.graphPath(projectId, taskIds, depth)), 200, dependencyGraphResponseSchema).data;
  }
  layoutPath(projectId: string) { return `/projects/${projectId}/graph-layout`; }
  async layout(projectId: string) {
    return expectEnvelope(await this.get(this.layoutPath(projectId)), 200, graphLayoutResponseSchema).data;
  }
  async saveLayout(projectId: string, positions: GraphPositionDto[], expectedRevision = 0, key?: string) {
    return expectEnvelope(await this.put(this.layoutPath(projectId), { expectedRevision, positions }, key), 200, graphLayoutResponseSchema).data;
  }
}
export function p4aClients(h: PlanningHarness) {
  const wrap = (c: P2aClient) => new P4aClient(c.api, c.workspaceId);
  return { owner: wrap(h.owner), replica: wrap(h.replica), member: wrap(h.member), viewer: wrap(h.viewer), outsider: wrap(h.outsider) };
}
