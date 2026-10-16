import { describe, expect, it } from 'vitest';
import { buildTaskGroups, visibleTaskRows } from './taskTree';
import { buildTableGroups } from './taskGrouping';
import { compareDueTasks, orderBoardTaskHeads } from './taskOrdering';
import { makeMember, makeSection, makeTask } from './taskTableFixtures';

const first = makeSection({ id: 'first', name: 'First', position: 0 });
const second = makeSection({ id: 'second', name: 'Second', position: 1 });
const owner = makeMember({ id: 'owner', userId: 'user', displayName: 'Owner' });
const parent = makeTask({ id: 'parent', title: 'Later parent', dueDate: '2027-02-01', position: 0, sectionId: first.id, responsibleMembershipId: owner.id });
const child = makeTask({ id: 'child', title: 'Earlier child', dueDate: '2027-01-01', position: 0, parentTaskId: parent.id, sectionId: second.id, responsibleMembershipId: owner.id });
const peer = makeTask({ id: 'peer', dueDate: '2027-01-15', position: 1, sectionId: first.id, responsibleMembershipId: owner.id });

describe('presentation due ordering', () => {
  it('uses own dates/null-last/ID ties without position or locale dependent ties', () => {
    const rows = [makeTask({ id: 'z', dueDate: null, position: -10 }), makeTask({ id: 'b', dueDate: '2027-01-01', position: -5 }), makeTask({ id: 'a', dueDate: '2027-01-01', position: 10 }), makeTask({ id: 'c', dueDate: '0001-01-01' }), makeTask({ id: 'd', dueDate: '9999-12-31' }), makeTask({ id: 'y', dueDate: null })];
    expect([...rows].sort(compareDueTasks).map(row => row.id)).toEqual(['c', 'a', 'b', 'd', 'y', 'z']);
    expect(rows[0]?.id).toBe('z');
  });

  it('sorts roots/siblings without promoting an earlier child, moving sections, or changing cycle ownership', () => {
    const laterChild = { ...child, id: 'later-child', dueDate: null, position: -10 };
    const cycleA = makeTask({ id: 'cycle-a', parentTaskId: 'cycle-b', sectionId: second.id, dueDate: '2027-02-01', position: 0 });
    const cycleB = makeTask({ id: 'cycle-b', parentTaskId: 'cycle-a', sectionId: first.id, dueDate: '2027-01-01', position: 1 });
    const rows = [parent, child, peer, laterChild, cycleA, cycleB];
    const manual = buildTaskGroups(rows, [first, second], 'en');
    const due = buildTaskGroups(rows, [first, second], 'en', 'due_asc');
    expect(due.map(group => group.key)).toEqual(manual.map(group => group.key));
    const root = due[0]?.roots.find(node => node.task.id === parent.id);
    expect(due[0]?.roots[0]?.task.id).toBe(peer.id);
    expect(root?.children.map(node => node.task.id)).toEqual([child.id, laterChild.id]);
    const shape = (groups: typeof due) => groups.flatMap(group => visibleTaskRows(group.roots, new Set()).map(node => [node.task.id, group.key, node.depth, node.detachedReason])).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(shape(due)).toEqual(shape(manual));
  });

  it('orders flat Assignee rows by own date and resorts new duplicate Board heads without duplication', () => {
    const groups = buildTableGroups([parent, child, peer], [first, second], [owner], 'assignee', 'en', 'due_asc');
    expect(groups[0]?.roots.map(node => node.task.id)).toEqual([child.id, peer.id, parent.id]);
    const updated = { ...parent, dueDate: '2026-01-01', revision: 2 };
    expect(orderBoardTaskHeads([peer, parent, updated], 'due_asc').map(task => task.id)).toEqual([parent.id, peer.id]);
    expect(orderBoardTaskHeads([peer, parent, updated], 'manual').map(task => task.id)).toEqual([peer.id, parent.id]);
    expect(buildTaskGroups([peer, parent], [first], 'en', 'manual')[0]?.roots.map(node => node.task.id)).toEqual([parent.id, peer.id]);
  });
});
