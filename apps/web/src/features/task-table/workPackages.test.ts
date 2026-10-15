import { describe, expect, it } from 'vitest';
import { makeTag, makeTask, participant } from './taskTableFixtures';
import { dedupeTasks, summarizeWorkPackages } from './workPackages';

describe('summarizeWorkPackages', () => {
  it('counts a parent and its detail subtasks once, whatever the number of participants', () => {
    const parent = makeTask({
      id: 'parent',
      workPackageId: 'wp-site',
      estimateMinutes: 600,
      participants: [participant('m-1'), participant('m-2'), participant('m-3')],
    });
    const detailA = makeTask({ id: 'a', parentTaskId: 'parent', workPackageId: 'wp-site', estimateMinutes: 600 });
    const detailB = makeTask({
      id: 'b',
      parentTaskId: 'parent',
      workPackageId: 'wp-site',
      estimateMinutes: 600,
      participants: [participant('m-4'), participant('m-5')],
    });
    const addedScope = makeTask({ id: 'c', parentTaskId: 'parent', workPackageId: 'wp-extra', estimateMinutes: 90 });

    const summary = summarizeWorkPackages([parent, detailA, detailB, addedScope]);

    expect(summary.total).toEqual({ status: 'ok', minutes: 690 });
    expect(summary.taskCount).toBe(4);
    expect(summary.packages.get('wp-site')?.taskIds).toEqual(['parent', 'a', 'b']);
  });

  it('treats 0 as an estimate and null as missing', () => {
    const summary = summarizeWorkPackages([
      makeTask({ id: 'zero', estimateMinutes: 0 }),
      makeTask({ id: 'none', estimateMinutes: null }),
      makeTask({ id: 'none-child', parentTaskId: 'none', workPackageId: 'wp-none', estimateMinutes: null }),
      makeTask({ id: 'set', estimateMinutes: 30 }),
    ]);

    expect(summary.total).toEqual({ status: 'ok', minutes: 30 });
    expect(summary.estimatedPackageCount).toBe(2);
    expect(summary.unestimatedPackageCount).toBe(1);
    expect(summary.unestimatedTaskCount).toBe(2);
  });

  it('summarizes a child-only page by package, without the parent loaded', () => {
    const summary = summarizeWorkPackages([
      makeTask({ id: 'a', parentTaskId: 'not-loaded', workPackageId: 'wp-shared', estimateMinutes: 240 }),
      makeTask({ id: 'b', parentTaskId: 'not-loaded', workPackageId: 'wp-shared', estimateMinutes: 240 }),
    ]);

    expect(summary.total).toEqual({ status: 'ok', minutes: 240 });
  });

  it('uses the newest package revision when loaded copies differ', () => {
    const summary = summarizeWorkPackages([
      makeTask({ id: 'parent', workPackageId: 'wp-1', workPackageRevision: 2, estimateMinutes: 120 }),
      makeTask({ id: 'child', parentTaskId: 'parent', workPackageId: 'wp-1', workPackageRevision: 3, estimateMinutes: 180 }),
    ]);

    expect(summary.total).toEqual({ status: 'ok', minutes: 180 });
    expect(summary.packages.get('wp-1')).toMatchObject({ revision: 3, estimate: { status: 'estimated', minutes: 180 } });
  });

  it('withholds the total when one package revision carries two estimates', () => {
    const summary = summarizeWorkPackages([
      makeTask({ id: 'parent', workPackageId: 'wp-1', workPackageRevision: 4, estimateMinutes: 120 }),
      makeTask({ id: 'child', parentTaskId: 'parent', workPackageId: 'wp-1', workPackageRevision: 4, estimateMinutes: null }),
      makeTask({ id: 'other', estimateMinutes: 60 }),
    ]);

    expect(summary.total).toEqual({ status: 'needs_refresh', conflictingPackageIds: ['wp-1'] });
  });

  it('counts a task listed twice once, keeping its newer copy', () => {
    const summary = summarizeWorkPackages([
      makeTask({ id: 'a', revision: 1, workPackageRevision: 1, estimateMinutes: 60 }),
      makeTask({ id: 'a', revision: 2, workPackageRevision: 2, estimateMinutes: 90 }),
    ]);

    expect(summary.taskCount).toBe(1);
    expect(summary.total).toEqual({ status: 'ok', minutes: 90 });
  });

  it('withholds the total when copies of one task name different packages', () => {
    const summary = summarizeWorkPackages([
      makeTask({ id: 'a', revision: 2, workPackageId: 'wp-1', estimateMinutes: 60 }),
      makeTask({ id: 'a', revision: 1, workPackageId: 'wp-2', estimateMinutes: 90 }),
    ]);

    expect(summary.total).toEqual({ status: 'needs_refresh', conflictingPackageIds: ['wp-1', 'wp-2'] });
  });
});

describe('dedupeTasks', () => {
  it('keeps a participant-only update when task and package revisions tie', () => {
    const [task] = dedupeTasks([
      makeTask({ id: 'a', participants: [participant('m-1')], participantsRevision: 1 }),
      makeTask({ id: 'a', participants: [participant('m-1'), participant('m-2')], participantsRevision: 2 }),
    ]);

    expect(task?.participantsRevision).toBe(2);
    expect(task?.participants.map((row) => row.membershipId)).toEqual(['m-1', 'm-2']);
  });

  it('takes each independently versioned part from the copy newest for it', () => {
    const tasks = [
      makeTask({ id: 'a', revision: 3, title: 'Новое название', workPackageRevision: 1, estimateMinutes: 60 }),
      makeTask({
        id: 'a',
        revision: 2,
        workPackageRevision: 2,
        estimateMinutes: 90,
        participants: [participant('m-2')],
        participantsRevision: 2,
      }),
    ];

    expect(dedupeTasks(tasks)).toEqual([
      expect.objectContaining({
        revision: 3,
        title: 'Новое название',
        workPackageRevision: 2,
        estimateMinutes: 90,
        participantsRevision: 2,
        participants: [participant('m-2')],
      }),
    ]);
    expect(summarizeWorkPackages(tasks).total).toEqual({ status: 'ok', minutes: 90 });
  });

  it('keeps the newest tag metadata for selected tags without restoring removed ones', () => {
    const [task] = dedupeTasks([
      makeTask({ id: 'a', revision: 2, tags: [makeTag({ id: 'tag-1', name: 'Дизайн' })] }),
      makeTask({
        id: 'a',
        revision: 1,
        tags: [
          makeTag({ id: 'tag-1', name: 'Интерфейс', revision: 2, archivedAt: '2026-10-02T09:00:00Z' }),
          makeTag({ id: 'tag-2', name: 'Снятый' }),
        ],
      }),
    ]);

    expect(task?.tags).toEqual([
      makeTag({ id: 'tag-1', name: 'Интерфейс', revision: 2, archivedAt: '2026-10-02T09:00:00Z' }),
    ]);
  });
});
