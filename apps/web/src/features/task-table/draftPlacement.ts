import type { MembershipDto, SectionDto } from '@workloom/contracts';
import type { TableTaskGroup } from './taskGrouping';
import { visibleTaskRows, type TaskGroupKind, type TaskTreeNode } from './taskTree';

/** Plain, cloned group presentation data: no roots, task DTOs or counts. */
export type DraftGroupMetadata =
  | { kind: TaskGroupKind; key: string; section: SectionDto | null; sectionId: string | null }
  | { kind: 'assignee'; key: string; membershipId: string | null; member: MembershipDto | null; section: null; sectionId: null };

/** Context captured once when manual Enter opens a virtual new row; never re-derived from later ACKs. */
export interface DraftPlacementSnapshot {
  blockKey: string;
  groupKey: string;
  group: DraftGroupMetadata;
  /** Backend insertion anchor: always the original task, even once it is hidden or moved. */
  anchorTaskId: string;
  parentTaskId: string | null;
  sectionId: string | null;
  depth: number;
  /** Original siblings (Section: same real parent; Assignee: flat visual neighbours), nearest first. */
  previousSiblingIds: readonly string[];
  nextSiblingIds: readonly string[];
  /** Assignee group membership (null = unassigned); undefined for Section groups, which assign nobody. */
  defaultResponsibleMembershipId: string | null | undefined;
}

export type DraftPosition =
  | { placement: 'before' | 'after'; taskId: string }
  | { placement: 'start'; taskId: null };

export interface ResolvedDraftPlacement {
  blockKey: string;
  groupKey: string;
  group: DraftGroupMetadata;
  groupExists: boolean;
  anchorTaskId: string;
  parentTaskId: string | null;
  sectionId: string | null;
  depth: number;
  defaultResponsibleMembershipId: string | null | undefined;
  /** Where to render the virtual block relative to a currently visible row of the original group. */
  position: DraftPosition;
}

const NO_COLLAPSED: ReadonlySet<string> = new Set();

export const draftBlockKey = (groupKey: string, anchorTaskId: string): string => `draft:${groupKey}:${anchorTaskId}`;

function cloneMetadata(group: TableTaskGroup | DraftGroupMetadata): DraftGroupMetadata {
  if (group.kind === 'assignee') {
    return { kind: 'assignee', key: group.key, membershipId: group.membershipId, member: group.member && { ...group.member }, section: null, sectionId: null };
  }
  return { kind: group.kind, key: group.key, section: group.section && { ...group.section }, sectionId: group.sectionId };
}

export function captureDraftPlacement(group: TableTaskGroup, anchorTaskId: string, blockKey?: string): DraftPlacementSnapshot | null {
  // Full tree order, collapsed descendants included: siblings are structural, not visual.
  const all = visibleTaskRows(group.roots, NO_COLLAPSED);
  const anchor = all.find(node => node.task.id === anchorTaskId);
  if (!anchor) return null;
  const assignee = group.kind === 'assignee';
  const siblings = assignee ? all : all.filter(node => node.task.parentTaskId === anchor.task.parentTaskId);
  const index = siblings.indexOf(anchor);
  return {
    blockKey: blockKey ?? draftBlockKey(group.key, anchorTaskId),
    groupKey: group.key,
    group: cloneMetadata(group),
    anchorTaskId,
    parentTaskId: anchor.task.parentTaskId,
    sectionId: anchor.task.sectionId,
    depth: anchor.depth,
    previousSiblingIds: siblings.slice(0, index).reverse().map(node => node.task.id),
    nextSiblingIds: siblings.slice(index + 1).map(node => node.task.id),
    defaultResponsibleMembershipId: assignee ? group.membershipId : undefined,
  };
}

export function resolveDraftPlacement(snapshot: DraftPlacementSnapshot, groups: readonly TableTaskGroup[], collapsedIds: ReadonlySet<string> = NO_COLLAPSED): ResolvedDraftPlacement {
  const group = groups.find(candidate => candidate.key === snapshot.groupKey);
  const base = {
    blockKey: snapshot.blockKey,
    groupKey: snapshot.groupKey,
    group: cloneMetadata(group ?? snapshot.group),
    groupExists: group !== undefined,
    anchorTaskId: snapshot.anchorTaskId,
    parentTaskId: snapshot.parentTaskId,
    sectionId: snapshot.sectionId,
    depth: snapshot.depth,
    defaultResponsibleMembershipId: snapshot.defaultResponsibleMembershipId,
  };
  if (!group) return { ...base, position: { placement: 'start', taskId: null } };

  const assignee = group.kind === 'assignee';
  const visible = new Map(visibleTaskRows(group.roots, collapsedIds).map(node => [node.task.id, node]));
  // Only the original group counts; a Section candidate must still sit under the captured parent.
  const candidate = (id: string): TaskTreeNode | undefined => {
    const node = visible.get(id);
    return node && (assignee || node.task.parentTaskId === snapshot.parentTaskId) ? node : undefined;
  };
  // Assignee rows are flat by design; Section rows end after their full visible subtree.
  const afterRow = (node: TaskTreeNode): DraftPosition => {
    const rows = assignee ? [node] : visibleTaskRows([node], collapsedIds);
    return { placement: 'after', taskId: (rows[rows.length - 1] ?? node).task.id };
  };

  const anchor = candidate(snapshot.anchorTaskId);
  if (anchor) return { ...base, position: afterRow(anchor) };
  for (const id of snapshot.nextSiblingIds) {
    if (candidate(id)) return { ...base, position: { placement: 'before', taskId: id } };
  }
  for (const id of snapshot.previousSiblingIds) {
    const node = candidate(id);
    if (node) return { ...base, position: afterRow(node) };
  }
  return { ...base, position: { placement: 'start', taskId: null } };
}
