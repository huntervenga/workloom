import {
  dependencyGraphSchema, taskBlockingSchema, taskDependencySchema, graphLayoutSchema,
  type TaskDto, type TaskDependencyDto, type DependencyGraphDto, type GraphLayoutDto, type TaskBlockingDto,
} from '@workloom/contracts';
import { alpha } from '../../../test/fakeApi';
import { task, PROJECT_ID, MEMBER_ID, STAMP, rootPath } from '../../planning/test/fixtures';
export { PROJECT_ID, MEMBER_ID, STAMP, rootPath };
export const PROJECT_B = 'e0000000-0000-4000-8000-000000000002';
export const EDGE_ID = 'd1000000-0000-4000-8000-000000000001';
export function taskAt(index: number, projectId = PROJECT_ID): TaskDto {
  return { ...task, id: `f2000000-0000-4000-8000-${String(index).padStart(12, '0')}`, workPackageId: `f1000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: `Задача ${index}`, projectId };
}
export function context(task: TaskDto) { return { project: { id: task.projectId, name: task.projectId === PROJECT_B ? 'Другой проект' : 'Недельный пилот', archivedAt: null }, status: { id: task.statusId, name: 'Запланировано', group: 'todo' as const } }; }
export function summary(taskId: string, count = 0, mode: 'warn' | 'enforce' = 'warn', projectId = PROJECT_ID) { return { taskId, policy: { projectId, mode, revision: 0 }, isBlocked: count > 0, unresolvedCount: count, canStart: mode === 'warn' || count === 0, canComplete: mode === 'warn' || count === 0, violatesCurrentStatus: false }; }
export function edge(predecessor = taskAt(1).id, successor = taskAt(2).id, state: TaskDependencyDto['state'] = 'active'): TaskDependencyDto {
  return taskDependencySchema.parse({ id: EDGE_ID, workspaceId: alpha.id, predecessorTaskId: predecessor, successorTaskId: successor, type: 'finish_to_start', state, revision: 1, createdAt: STAMP, updatedAt: STAMP });
}
export function graph(tasks: TaskDto[], roots = tasks.filter(task => task.projectId === PROJECT_ID).map(task => task.id), edges: TaskDependencyDto[] = [], seq = '1'): DependencyGraphDto {
  return dependencyGraphSchema.parse({ projectId: PROJECT_ID, rootTaskIds: roots, neighborDepth: 1, asOfChangeSeq: seq, nodes: tasks.map(task => ({ task, context: context(task), blocking: summary(task.id, edges.filter(edge => edge.successorTaskId === task.id).length, 'warn', task.projectId), hasOutsideDependencies: false, outsideUnresolvedPredecessorCount: 0 })), edges });
}
export function layout(positions: GraphLayoutDto['positions'] = [], revision = 0): GraphLayoutDto {
  return graphLayoutSchema.parse({ workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, viewKey: 'default', revision, positions, updatedAt: revision ? STAMP : null });
}
export function blocking(task: TaskDto, predecessor?: TaskDto, mode: 'warn' | 'enforce' = 'warn'): TaskBlockingDto {
  return taskBlockingSchema.parse({ summary: summary(task.id, predecessor ? 1 : 0, mode, task.projectId), blockers: predecessor ? [{ dependency: edge(predecessor.id, task.id), predecessor, predecessorContext: context(predecessor) }] : [], asOfChangeSeq: '1' });
}
