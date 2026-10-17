import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@workloom/contracts';
import { captureDraftPlacement, resolveDraftPlacement, type DraftPlacementSnapshot } from './draftPlacement';
import { buildTableGroups, type AssigneeTaskGroup, type TableTaskGroup } from './taskGrouping';
import { makeMember, makeSection, makeTask } from './taskTableFixtures';

const one = makeSection({ id: 's1', name: 'One', position: 0 });
const two = makeSection({ id: 's2', name: 'Two', position: 1 });
const anna = makeMember({ id: 'a', userId: 'anna', displayName: 'Anna' });
const boris = makeMember({ id: 'b', userId: 'boris', displayName: 'Boris' });

const A = makeTask({ id: 'A', sectionId: 's1', position: 0 });
const B = makeTask({ id: 'B', sectionId: 's1', position: 1 });
const B1 = makeTask({ id: 'B1', sectionId: 's1', parentTaskId: 'B', position: 0 });
const B2 = makeTask({ id: 'B2', sectionId: 's1', parentTaskId: 'B', position: 1 });
const B2a = makeTask({ id: 'B2a', sectionId: 's1', parentTaskId: 'B2', position: 0 });
const C = makeTask({ id: 'C', sectionId: 's1', position: 2 });
const tree = [A, B, B1, B2, B2a, C];

const bySection = (tasks: readonly TaskDto[]) => buildTableGroups(tasks, [one, two], [anna, boris], 'section', 'en');
const byAssignee = (tasks: readonly TaskDto[]) => buildTableGroups(tasks, [one, two], [anna, boris], 'assignee', 'en');
const group = (groups: readonly TableTaskGroup[], key: string): TableTaskGroup => {
  const found = groups.find(candidate => candidate.key === key);
  if (!found) throw new Error(`missing group ${key}`);
  return found;
};
const capture = (groups: readonly TableTaskGroup[], key: string, anchorTaskId: string): DraftPlacementSnapshot => {
  const snapshot = captureDraftPlacement(group(groups, key), anchorTaskId);
  if (!snapshot) throw new Error(`missing anchor ${anchorTaskId}`);
  return snapshot;
};

describe('Section draft placement', () => {
  it('captures the real anchor context and places after the last visible descendant', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B');
    expect(snapshot).toMatchObject({
      groupKey: 'section:s1', anchorTaskId: 'B', parentTaskId: null, sectionId: 's1', depth: 0,
      previousSiblingIds: ['A'], nextSiblingIds: ['C'], defaultResponsibleMembershipId: undefined,
    });
    expect(snapshot.group).toEqual({ kind: 'section', key: 'section:s1', section: one, sectionId: 's1' });
    expect(resolveDraftPlacement(snapshot, bySection(tree)).position).toEqual({ placement: 'after', taskId: 'B2a' });
  });

  it('skips collapsed descendants that are not rendered', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B');
    expect(resolveDraftPlacement(snapshot, bySection(tree), new Set(['B'])).position).toEqual({ placement: 'after', taskId: 'B' });
    expect(resolveDraftPlacement(snapshot, bySection(tree), new Set(['B2'])).position).toEqual({ placement: 'after', taskId: 'B2' });
  });

  it('goes before the next original sibling when the anchor is hidden, ignoring new rows and detached children', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B');
    const arrival = makeTask({ id: 'N', sectionId: 's1', position: 1.5 });
    const resolved = resolveDraftPlacement(snapshot, bySection([A, B1, B2, B2a, arrival, C]));
    expect(resolved.position).toEqual({ placement: 'before', taskId: 'C' });
    expect(resolved.anchorTaskId).toBe('B');
  });

  it('falls back after the previous original sibling and its visible subtree', () => {
    const A1 = makeTask({ id: 'A1', sectionId: 's1', parentTaskId: 'A', position: 0 });
    const snapshot = capture(bySection([A, A1, ...tree.slice(1)]), 'section:s1', 'B');
    expect(snapshot.previousSiblingIds).toEqual(['A']);
    expect(resolveDraftPlacement(snapshot, bySection([A, A1])).position).toEqual({ placement: 'after', taskId: 'A1' });
    expect(resolveDraftPlacement(snapshot, bySection([A, A1]), new Set(['A'])).position).toEqual({ placement: 'after', taskId: 'A' });
  });

  it('keeps nearest-first sibling order', () => {
    const D = makeTask({ id: 'D', sectionId: 's1', position: 3 });
    const snapshot = capture(bySection([...tree, D]), 'section:s1', 'C');
    expect(snapshot.previousSiblingIds).toEqual(['B', 'A']);
    expect(snapshot.nextSiblingIds).toEqual(['D']);
    expect(resolveDraftPlacement(snapshot, bySection([A, D])).position).toEqual({ placement: 'before', taskId: 'D' });
    expect(resolveDraftPlacement(snapshot, bySection([A])).position).toEqual({ placement: 'after', taskId: 'A' });
  });

  it('starts an emptied original group with its metadata instead of the section bottom', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B');
    const other = makeTask({ id: 'other', sectionId: 's2' });
    const resolved = resolveDraftPlacement(snapshot, bySection([other]));
    expect(resolved).toMatchObject({ groupKey: 'section:s1', groupExists: true, position: { placement: 'start', taskId: null } });
    expect(resolved.group).toEqual(snapshot.group);
  });

  it('keeps the original group and context when the anchor moves to another section', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B');
    const moved = { ...B, sectionId: 's2', revision: 2 };
    const resolved = resolveDraftPlacement(snapshot, bySection([A, moved, B1, B2, B2a, C]));
    expect(resolved).toMatchObject({
      groupKey: 'section:s1', anchorTaskId: 'B', parentTaskId: null, sectionId: 's1', depth: 0,
      position: { placement: 'before', taskId: 'C' },
    });
  });

  it('preserves nested parent, depth and real section and falls back to the next child', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B1');
    expect(snapshot).toMatchObject({ parentTaskId: 'B', depth: 1, sectionId: 's1', previousSiblingIds: [], nextSiblingIds: ['B2'] });
    expect(resolveDraftPlacement(snapshot, bySection(tree)).position).toEqual({ placement: 'after', taskId: 'B1' });
    expect(resolveDraftPlacement(snapshot, bySection([A, B, B2, B2a, C])).position).toEqual({ placement: 'before', taskId: 'B2' });
    // A reparented sibling no longer counts as an original same-parent candidate.
    expect(resolveDraftPlacement(snapshot, bySection([A, B, { ...B2, parentTaskId: null }, B2a, C])).position).toEqual({ placement: 'start', taskId: null });
  });

  it('takes the section from the real child even when it differs from the containing group', () => {
    const crossSection = makeTask({ id: 'X', sectionId: 's2', parentTaskId: 'B', position: 2 });
    const snapshot = capture(bySection([...tree, crossSection]), 'section:s1', 'X');
    expect(snapshot).toMatchObject({ groupKey: 'section:s1', sectionId: 's2', parentTaskId: 'B', previousSiblingIds: ['B2', 'B1'] });
    expect(resolveDraftPlacement(snapshot, bySection([A, B, B1, B2, B2a, C])).position).toEqual({ placement: 'after', taskId: 'B2a' });
  });
});

describe('Assignee draft placement', () => {
  it('defaults responsibility from the containing group, never from a differing source child', () => {
    const parent = makeTask({ id: 'P', responsibleMembershipId: 'a' });
    const child = makeTask({ id: 'K', parentTaskId: 'P', responsibleMembershipId: 'b', sectionId: 's2' });
    const nested: AssigneeTaskGroup = {
      kind: 'assignee', key: 'assignee:a', membershipId: 'a', member: anna, section: null, sectionId: null, taskCount: 2,
      roots: [{ task: parent, depth: 0, detachedReason: null, children: [{ task: child, depth: 1, children: [], detachedReason: null }] }],
    };
    expect(captureDraftPlacement(nested, 'K')).toMatchObject({ defaultResponsibleMembershipId: 'a', parentTaskId: 'P', sectionId: 's2', depth: 1 });
  });

  it('keeps explicit unassigned null distinct from Section undefined', () => {
    const loose = makeTask({ id: 'loose', sectionId: 's1' });
    const unassigned = capture(byAssignee([loose]), 'unassigned', 'loose');
    expect(unassigned.defaultResponsibleMembershipId).toBeNull();
    expect(unassigned.group).toEqual({ kind: 'assignee', key: 'unassigned', membershipId: null, member: null, section: null, sectionId: null });
    expect(capture(bySection([loose]), 'section:s1', 'loose').defaultResponsibleMembershipId).toBeUndefined();
  });

  it('places after the flat anchor row and falls back across all flat visual neighbours despite other parents', () => {
    const X = makeTask({ id: 'X', responsibleMembershipId: 'a', position: 0 });
    const Y = makeTask({ id: 'Y', responsibleMembershipId: 'a', parentTaskId: 'other', position: 1 });
    const Z = makeTask({ id: 'Z', responsibleMembershipId: 'a', parentTaskId: 'third', position: 2 });
    const snapshot = capture(byAssignee([X, Y, Z]), 'assignee:a', 'Y');
    expect(snapshot).toMatchObject({ parentTaskId: 'other', previousSiblingIds: ['X'], nextSiblingIds: ['Z'], defaultResponsibleMembershipId: 'a' });
    expect(resolveDraftPlacement(snapshot, byAssignee([X, Y, Z])).position).toEqual({ placement: 'after', taskId: 'Y' });
    const reassigned = { ...Y, responsibleMembershipId: 'b', revision: 2 };
    expect(resolveDraftPlacement(snapshot, byAssignee([X, reassigned, Z])).position).toEqual({ placement: 'before', taskId: 'Z' });
    const resolved = resolveDraftPlacement(snapshot, byAssignee([X, reassigned, { ...Z, responsibleMembershipId: 'b' }]));
    expect(resolved).toMatchObject({ groupKey: 'assignee:a', defaultResponsibleMembershipId: 'a', parentTaskId: 'other', position: { placement: 'after', taskId: 'X' } });
  });

  it('retains captured metadata when the original group disappears', () => {
    const only = makeTask({ id: 'only', responsibleMembershipId: 'a' });
    const snapshot = capture(byAssignee([only]), 'assignee:a', 'only');
    const resolved = resolveDraftPlacement(snapshot, byAssignee([{ ...only, responsibleMembershipId: 'b' }]));
    expect(resolved).toMatchObject({ groupExists: false, groupKey: 'assignee:a', defaultResponsibleMembershipId: 'a', position: { placement: 'start', taskId: null } });
    expect(resolved.group).toEqual({ kind: 'assignee', key: 'assignee:a', membershipId: 'a', member: anna, section: null, sectionId: null });
  });
});

describe('Draft placement snapshot identity', () => {
  it('clones plain metadata so later group or result mutation never leaks into the snapshot', () => {
    const member = { ...anna };
    const live: AssigneeTaskGroup = { ...(group(byAssignee([makeTask({ id: 'm', responsibleMembershipId: 'a' })]), 'assignee:a') as AssigneeTaskGroup), member };
    const snapshot = captureDraftPlacement(live, 'm');
    Object.assign(member, { displayName: 'Renamed' });
    expect(snapshot?.group).toEqual({ kind: 'assignee', key: 'assignee:a', membershipId: 'a', member: anna, section: null, sectionId: null });
    expect(snapshot?.group).not.toHaveProperty('roots');
    expect(snapshot?.group).not.toHaveProperty('taskCount');

    const section = { ...one };
    const sectionBase = group(bySection(tree), 'section:s1');
    if (sectionBase.kind === 'assignee') throw new Error('Expected a section group.');
    const sectionGroup = { ...sectionBase, section };
    const sectionSnapshot = captureDraftPlacement(sectionGroup, 'B');
    Object.assign(section, { name: 'Renamed' });
    expect(sectionSnapshot?.group.section?.name).toBe('One');
    if (!sectionSnapshot) throw new Error('missing snapshot');
    const resolved = resolveDraftPlacement(sectionSnapshot, []);
    expect(resolved.group).not.toBe(sectionSnapshot.group);
    if (resolved.group.section) Object.assign(resolved.group.section, { name: 'Mutated' });
    expect(sectionSnapshot.group.section?.name).toBe('One');
  });

  it('returns null for an anchor that is absent from the given group', () => {
    const groups = bySection([...tree, makeTask({ id: 'elsewhere', sectionId: 's2' })]);
    expect(captureDraftPlacement(group(groups, 'section:s1'), 'missing')).toBeNull();
    expect(captureDraftPlacement(group(groups, 'section:s1'), 'elsewhere')).toBeNull();
  });

  it('keeps one stable block key whether the anchor is visible, hidden, or its group is empty or gone', () => {
    const snapshot = capture(bySection(tree), 'section:s1', 'B');
    expect(snapshot.blockKey).toBe('draft:section:s1:B');
    const keys = [bySection(tree), bySection([A, C]), bySection([]), []].map(groups => resolveDraftPlacement(snapshot, groups).blockKey);
    expect(new Set(keys)).toEqual(new Set(['draft:section:s1:B']));
    const custom = captureDraftPlacement(group(bySection(tree), 'section:s1'), 'B', 'pending-1');
    expect(custom && resolveDraftPlacement(custom, bySection([A, C])).blockKey).toBe('pending-1');
  });
});
