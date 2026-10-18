import { describe, expect, it } from 'vitest';
import { emptyTaskFilters } from '../tasks/TaskFilters';
import { byHomeProject, canonicalStatusTarget, linkedRows } from './rowModel';
import { homeDone, homeStatus, placement, row, targetId, targetStatus, task } from './testFixtures';

describe('linked project row identity and shared status', () => {
  it('uses target placement section/order without changing canonical task accounting, status or parent', () => {
    const before = structuredClone(row);
    const result = linkedRows([row], targetId, emptyTaskFilters);
    expect(result).toEqual([row]);
    expect(result[0]?.canonicalTask).toBe(task);
    expect(result[0]?.canonicalTask.projectId).not.toBe(targetId);
    expect(result[0]?.placement.position).toBe(40);
    expect(row).toEqual(before);
  });
  it('refuses target project status IDs and accepts only the canonical home catalog', () => {
    expect(canonicalStatusTarget(row, [targetStatus], targetStatus.id)).toBeUndefined();
    expect(canonicalStatusTarget(row, [homeStatus, homeDone], homeDone.id)).toBe(homeDone);
    expect(canonicalStatusTarget(row, [{ ...homeDone, workspaceId: targetId }], homeDone.id)).toBeUndefined();
  });
  it('uses shared canonical completion and excludes detached, home and meeting rows by default', () => {
    expect(linkedRows([{ ...row, canonicalStatus: homeDone }], targetId, { ...emptyTaskFilters, completion: 'open' })).toEqual([]);
    expect(linkedRows([{ ...row, placement: { ...placement, archivedAt: task.createdAt } }], targetId, emptyTaskFilters)).toEqual([]);
    expect(linkedRows([{ ...row, canonicalTask: { ...task, meetingId: targetId } }], targetId, emptyTaskFilters)).toEqual([]);
    expect(linkedRows([row], task.projectId, emptyTaskFilters)).toEqual([]);
  });
  it('applies shared participant and tag filters without counting removed participants', () => {
    const participant = { membershipId: targetId, role: 'assignee' as const, active: false, revision: 1 };
    expect(linkedRows([{ ...row, canonicalTask: { ...task, participants: [participant] } }], targetId, { ...emptyTaskFilters, participantMembershipId: targetId })).toEqual([]);
    expect(linkedRows([{ ...row, canonicalTask: { ...task, participants: [{ ...participant, active: true }] } }], targetId, { ...emptyTaskFilters, participantMembershipId: targetId })).toHaveLength(1);
    expect(linkedRows([row], targetId, { ...emptyTaskFilters, tagId: targetId })).toEqual([]);
  });
  it('groups lanes by actual home project even when a canonical task has another placement', () => {
    const anotherView = { ...row, placement: { ...placement, id: targetId, projectId: task.projectId } };
    expect(byHomeProject([row, anotherView])).toEqual([[row, anotherView]]);
    // No derived estimate or worklog totals are produced by the grouping adapter.
    expect(Object.keys(byHomeProject([row]))).toEqual(['0']);
  });
});
