import type { TaskDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { buildTaskGroups, visibleTaskRows } from './taskTree';
import { makeSection, makeTask } from './taskTableFixtures';
import { withPendingMove } from './pendingMove';

const first = makeSection({ id: 'section-first', name: 'First', position: 0 });
const second = makeSection({ id: 'section-second', name: 'Second', position: 1 });
const a = makeTask({ id: 'a', sectionId: first.id, position: 0 });
const b = makeTask({ id: 'b', sectionId: first.id, position: 1 });
const c = makeTask({ id: 'c', sectionId: first.id, position: 2 });
const d = makeTask({ id: 'd', sectionId: second.id, position: 3 });
const tasks = [a, b, c, d];
const order = (list: readonly TaskDto[]) => buildTaskGroups(list, [first, second]).map(group => visibleTaskRows(group.roots, new Set()).map(node => node.task.id));

describe('a dropped row before the list confirms it', () => {
  it('sits next to its anchor at once, before or after it', () => {
    expect(order(withPendingMove(tasks, { taskId: 'c', anchorTaskId: 'a', placement: 'before' }))).toEqual([['c', 'a', 'b'], ['d']]);
    expect(order(withPendingMove(tasks, { taskId: 'a', anchorTaskId: 'b', placement: 'after' }))).toEqual([['b', 'a', 'c'], ['d']]);
    expect(order(withPendingMove(tasks, { taskId: 'a', anchorTaskId: 'c', placement: 'after' }))).toEqual([['b', 'c', 'a'], ['d']]);
  });

  it('takes the section of an anchor in another section, as the server does for a root task', () => {
    expect(order(withPendingMove(tasks, { taskId: 'b', anchorTaskId: 'd', placement: 'before' }))).toEqual([['a', 'c'], ['b', 'd']]);
  });

  it('stays in its section when the moved task has the confirmed rank of the server and its neighbours do not yet', () => {
    // After the answer only the moved task carries its new rank; the others keep their old positions until the list is read again.
    const confirmed = [a, b, c, { ...d, sectionId: first.id, position: 1 }];
    expect(order(withPendingMove(confirmed, { taskId: 'd', anchorTaskId: 'a', placement: 'after' }))).toEqual([['a', 'd', 'b', 'c'], []]);
  });

  it('joins the assignee lane it was dropped in', () => {
    const anna = makeTask({ id: 'anna-task', responsibleMembershipId: 'member-anna', position: 5 });
    const shown = withPendingMove([...tasks, anna], { taskId: 'a', anchorTaskId: anna.id, placement: 'after', responsibleMembershipId: 'member-anna' });
    expect(shown.find(task => task.id === 'a')).toMatchObject({ responsibleMembershipId: 'member-anna', sectionId: first.id, position: 6 });
  });

  it('leaves the list alone without an anchor, for an unknown task or across parents', () => {
    expect(withPendingMove(tasks, { taskId: 'a', anchorTaskId: null, placement: 'after' })).toBe(tasks);
    expect(withPendingMove(tasks, { taskId: 'missing', anchorTaskId: 'a', placement: 'after' })).toBe(tasks);
    const child = makeTask({ id: 'child', parentTaskId: 'a', sectionId: first.id, position: 0 });
    expect(withPendingMove([...tasks, child], { taskId: 'child', anchorTaskId: 'b', placement: 'after' })).toEqual([...tasks, child]);
    expect(withPendingMove(tasks, null)).toBe(tasks);
  });
});
