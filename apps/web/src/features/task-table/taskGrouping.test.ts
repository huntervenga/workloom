import { describe, expect, it } from 'vitest';
import { buildTableGroups } from './taskGrouping';
import { buildTaskGroups } from './taskTree';
import { makeMember, makeSection, makeTask, participant } from './taskTableFixtures';

const anna = makeMember({ id: 'a', userId: 'anna', displayName: 'Same name' });
const boris = makeMember({ id: 'b', userId: 'boris', displayName: 'Same name' });
const section = makeSection({ id: 'section', name: 'Section' });
const groups = (tasks: Parameters<typeof buildTableGroups>[0]) => buildTableGroups(tasks, [section], [boris, anna], 'assignee', 'en');

describe('loaded assignee grouping', () => {
  it('places every deduplicated task once under its own assignee, including organizers and cross-group children', () => {
    const parent = makeTask({ id: 'parent', responsibleMembershipId: anna.id, sectionId: section.id });
    const child = makeTask({ id: 'child', parentTaskId: parent.id, responsibleMembershipId: boris.id, sectionId: null });
    const meeting = makeTask({ id: 'meeting', meetingId: 'meeting-id', responsibleMembershipId: anna.id, participants: [participant(anna.id), participant(boris.id)] });
    const updated = { ...child, revision: child.revision + 1, title: 'Latest child' };
    const result = groups([child, parent, meeting, updated]);
    expect(result.map(group => [group.key, group.taskCount])).toEqual([['assignee:a', 2], ['assignee:b', 1]]);
    expect(result.flatMap(group => group.roots).map(node => node.task.id).sort()).toEqual(['child', 'meeting', 'parent']);
    expect(result[1]?.roots[0]?.task.title).toBe('Latest child');
    expect(result.flatMap(group => group.roots).every(node => node.depth === 0 && node.children.length === 0 && node.detachedReason === null)).toBe(true);
  });

  it('sorts known names with ID ties, separate unknown IDs next, and unassigned last without empty roster groups', () => {
    const result = groups(['z', null, 'b', 'a', 'x'].map((responsibleMembershipId, index) => makeTask({ id: `task-${index}`, responsibleMembershipId })));
    expect(result.map(group => group.key)).toEqual(['assignee:a', 'assignee:b', 'assignee:x', 'assignee:z', 'unassigned']);
    expect(groups([])).toEqual([]);
  });

  it('keeps cycles/self references as ordinary flat tasks and delegates Section unchanged', () => {
    const tasks = [makeTask({ id: 'one', parentTaskId: 'two' }), makeTask({ id: 'two', parentTaskId: 'one' }), makeTask({ id: 'self', parentTaskId: 'self' })];
    expect(groups(tasks).flatMap(group => group.roots)).toHaveLength(3);
    expect(buildTableGroups(tasks, [section], [anna], 'section', 'en')).toEqual(buildTaskGroups(tasks, [section], 'en'));
  });
});
