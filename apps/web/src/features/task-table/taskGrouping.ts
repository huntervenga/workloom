import type { MembershipDto, SectionDto, TaskDto } from '@workloom/contracts';
import { buildTaskGroups, type TaskGroup, type TaskTreeNode } from './taskTree';
import { dedupeTasks } from './workPackages';

export type TaskGroupingMode = 'section' | 'assignee';
export interface AssigneeTaskGroup {
  kind: 'assignee';
  key: string;
  membershipId: string | null;
  member: MembershipDto | null;
  section: null;
  sectionId: null;
  roots: readonly TaskTreeNode[];
  taskCount: number;
}
export type TableTaskGroup = TaskGroup | AssigneeTaskGroup;
export const assigneeGroupKey = (membershipId: string | null): string => membershipId === null ? 'unassigned' : `assignee:${membershipId}`;

/** Read-only grouping of the authorized loaded scope. Section retains the canonical tree. */
export function buildTableGroups(tasks: readonly TaskDto[], sections: readonly SectionDto[], members: readonly MembershipDto[], mode: TaskGroupingMode, locale: string): TableTaskGroup[] {
  if (mode === 'section') return buildTaskGroups(tasks, sections, locale);
  const memberById = new Map(members.map(member => [member.id, member]));
  const buckets = new Map<string | null, TaskTreeNode[]>();
  const unique = dedupeTasks(tasks).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const task of unique) {
    const nodes = buckets.get(task.responsibleMembershipId) ?? [];
    // Parent context is displayed separately: an assignee group never invents a tree.
    nodes.push({ task, depth: 0, children: [], detachedReason: null });
    buckets.set(task.responsibleMembershipId, nodes);
  }
  return [...buckets].map(([membershipId, roots]): AssigneeTaskGroup => ({
    kind: 'assignee', key: assigneeGroupKey(membershipId), membershipId,
    member: membershipId === null ? null : memberById.get(membershipId) ?? null,
    section: null, sectionId: null, roots, taskCount: roots.length,
  })).sort((a, b) => {
    if (a.membershipId === null) return 1;
    if (b.membershipId === null) return -1;
    if (a.member && b.member) return a.member.displayName.localeCompare(b.member.displayName, locale) || a.membershipId.localeCompare(b.membershipId);
    if (a.member) return -1;
    if (b.member) return 1;
    return a.membershipId.localeCompare(b.membershipId);
  });
}
