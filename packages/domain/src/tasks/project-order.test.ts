import { describe, expect, it } from 'vitest';
import type { TaskDto, TaskProjectPlacementDto } from '@workloom/contracts';
import { linkedPlacementsInOrder, mergeProjectOrder, placeInProjectOrder, type ProjectOrderItem } from './project-order.js';

const project = 'project-here', other = 'project-home', now = '2026-11-11T10:00:00.000Z';
const own = (id: string, position: number, extra: Partial<TaskDto> = {}) => ({ id, projectId: project, sectionId: 'backlog', parentTaskId: null, archivedAt: null, position, ...extra }) as TaskDto;
const linked = (id: string, position: number, extra: Partial<TaskProjectPlacementDto> = {}): TaskProjectPlacementDto => ({
  id, workspaceId: 'ws', taskId: `task-${id}`, projectId: project, homeProjectId: other, sectionId: 'backlog', position, revision: 1, archivedAt: null, createdAt: now, updatedAt: now, ...extra,
});
const names = (items: readonly ProjectOrderItem[] | null) => items?.map(item => item.kind === 'task' ? item.task.id : item.kind === 'placement' ? item.row.id : '*');

describe('project shared order', () => {
  it('keeps only active linked placements of the project, by number then id', () => {
    const rows = [linked('b', 2), linked('a', 2), linked('home', 0, { homeProjectId: project }), linked('gone', 1, { archivedAt: now }), linked('elsewhere', 0, { projectId: other })];
    expect(linkedPlacementsInOrder(rows, project).map(row => row.id)).toEqual(['a', 'b']);
  });

  it('puts a linked row before the first own task with a larger number, after one with the same number', () => {
    expect(names(mergeProjectOrder([own('A', 0), own('B', 1), own('C', 2)], [linked('L', 1), linked('M', 9)]))).toEqual(['A', 'B', 'L', 'C', 'M']);
  });

  it('keeps linked rows next to their neighbours when an own task moves', () => {
    // Before: A0 B1 L(1) C2 — the table shows A, B, L, C. C moves to the top: its slot is not compared.
    expect(names(mergeProjectOrder([null, own('A', 0), own('B', 1)], [linked('L', 1)]))).toEqual(['*', 'A', 'B', 'L']);
    // C moves between A and B.
    expect(names(mergeProjectOrder([own('A', 0), null, own('B', 1)], [linked('L', 1)]))).toEqual(['A', '*', 'B', 'L']);
  });

  it('places a linked row next to an own task or another linked row, and at the end of a section', () => {
    const items = mergeProjectOrder([own('A', 0), own('B', 1), own('X', 2, { sectionId: 'doing' })], [linked('L', 1), linked('M', 1)]);
    const moving = linked('M', 1);
    expect(names(placeInProjectOrder(items, moving, { taskId: 'A' }, 'before', 'backlog'))).toEqual(['M', 'A', 'B', 'L', 'X']);
    expect(names(placeInProjectOrder(items, moving, { placementId: 'L' }, 'before', 'backlog'))).toEqual(['A', 'B', 'M', 'L', 'X']);
    expect(names(placeInProjectOrder(items, { ...moving, sectionId: 'doing' }, null, 'after', 'doing'))).toEqual(['A', 'B', 'L', 'X', 'M']);
    // An empty section: the very end.
    expect(names(placeInProjectOrder(items, { ...moving, sectionId: 'empty' }, null, 'after', 'empty'))).toEqual(['A', 'B', 'L', 'X', 'M']);
    expect(placeInProjectOrder(items, moving, { taskId: 'missing' }, 'after', 'backlog')).toBeNull();
  });

  it('ends a section after its last root row, never after a subtask of another section', () => {
    const items = mergeProjectOrder([own('A', 0), own('B', 1, { sectionId: 'doing' }), own('a1', 2, { parentTaskId: 'A' })], []);
    expect(names(placeInProjectOrder(items, linked('L', 5), null, 'after', 'backlog'))).toEqual(['A', 'L', 'B', 'a1']);
  });
});
