import { describe, expect, it } from 'vitest';
import { makeTask, participant, statuses } from '../task-table/taskTableFixtures';
import { buildBoardModel } from './boardModel';

const todo = statuses[0]; const progress = statuses[1];
if (!todo || !progress) throw new Error('Missing status fixture');
const done = { ...todo, id: 'done-a', name: 'Done A', group: 'done' as const, position: 4 };
const otherDone = { ...done, id: 'done-b', name: 'Done B' };

describe('loaded task board model', () => {
  it('merges independent revisions before assigning exactly one card to its current status', () => {
    const copies = [
      makeTask({ id: 'same', revision: 3, title: 'Latest title', statusId: done.id, workPackageRevision: 1, estimateMinutes: 60 }),
      makeTask({ id: 'same', revision: 2, title: 'Old title', statusId: todo.id, workPackageRevision: 5, estimateMinutes: 0, participantsRevision: 6, participants: [participant('person-b')] }),
    ];
    const original = JSON.stringify(copies);
    const model = buildBoardModel(copies, [todo, done]);
    expect(model.loadedCount).toBe(1);
    expect(model.lanes.find(lane => lane.statusId === todo.id)?.cards).toEqual([]);
    const cards = model.lanes.flatMap(lane => lane.cards);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.task).toMatchObject({ id: 'same', title: 'Latest title', revision: 3, statusId: done.id, workPackageRevision: 5, estimateMinutes: 0, participantsRevision: 6, participants: [participant('person-b')] });
    expect(JSON.stringify(copies)).toBe(original);
  });

  it('sorts exact catalog statuses by position/id and preserves empty and multiple done lanes', () => {
    const cancelled = { ...todo, id: 'cancelled', name: 'Cancelled', group: 'cancelled' as const, position: 6 };
    const model = buildBoardModel([makeTask({ id: 'one', statusId: otherDone.id })], [cancelled, otherDone, done, progress, todo]);
    expect(model.lanes.map(lane => lane.statusId)).toEqual([todo.id, progress.id, done.id, otherDone.id, cancelled.id]);
    expect(model.lanes.map(lane => lane.cards.length)).toEqual([0, 0, 0, 1, 0]);
    expect(model.lanes.filter(lane => lane.status?.group === 'done')).toHaveLength(2);
  });

  it('keeps each missing status identity separate and never loses or slices loaded tasks', () => {
    const tasks = Array.from({ length: 151 }, (_, index) => makeTask({ id: `task-${index}`, statusId: index % 2 === 0 ? 'missing-z' : 'missing-a' }));
    const first = tasks[0]; if (!first) throw new Error('Missing first task');
    const model = buildBoardModel([...tasks, first], [todo]);
    expect(model.loadedCount).toBe(151);
    expect(model.lanes.map(lane => lane.statusId)).toEqual([todo.id, 'missing-a', 'missing-z']);
    expect(model.lanes.map(lane => lane.cards.length)).toEqual([0, 75, 76]);
    expect(new Set(model.lanes.flatMap(lane => lane.cards.map(card => card.task.id))).size).toBe(151);
    expect(model.lanes.slice(1).every(lane => lane.status === null)).toBe(true);
  });

  it('uses only an immediate loaded parent even for cycles, self references and missing parents', () => {
    const tasks = [makeTask({ id: 'a', parentTaskId: 'b' }), makeTask({ id: 'b', parentTaskId: 'a' }), makeTask({ id: 'self', parentTaskId: 'self' }), makeTask({ id: 'child', parentTaskId: 'unloaded' })];
    const model = buildBoardModel(tasks, [todo]);
    expect(model.loadedCount).toBe(4);
    const cards = model.lanes.flatMap(lane => lane.cards);
    expect(cards.map(card => card.task.id)).toEqual(['a', 'b', 'self', 'child']);
    expect(cards[0]?.parent).toMatchObject({ kind: 'loaded', task: { id: 'b' } });
    expect(cards[1]?.parent).toMatchObject({ kind: 'loaded', task: { id: 'a' } });
    expect(cards[2]?.parent).toMatchObject({ kind: 'loaded', task: { id: 'self' } });
    expect(cards[3]?.parent).toEqual({ kind: 'not_loaded', id: 'unloaded' });
  });

  it('keeps tasks reachable when the entire status catalog is unavailable', () => {
    const model = buildBoardModel([makeTask({ id: 'one' })], []);
    expect(model.loadedCount).toBe(1);
    expect(model.lanes).toHaveLength(1);
    expect(model.lanes[0]?.status).toBeNull();
    expect(model.lanes[0]?.cards[0]?.task.id).toBe('one');
  });
});
