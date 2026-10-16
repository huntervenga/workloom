import { localization } from '../../i18n';
import type { SectionDto, TaskDto } from '@workloom/contracts';
import { dedupeTasks } from './workPackages';

export interface TaskTreeNode {
  task: TaskDto;
  depth: number;
  /** Loaded children in display order; unloaded children are unknown and not counted. */
  children: readonly TaskTreeNode[];
  /**
   * Why a task with `parentTaskId` is shown at the top level: its parent is not in the loaded
   * set (filter or page), or the loaded parent links form a cycle.
   */
  detachedReason: 'parent_not_loaded' | 'cycle' | null;
}

export type TaskGroupKind = 'section' | 'missing_section' | 'no_section';

export interface TaskGroup {
  key: string;
  kind: TaskGroupKind;
  /** Set for `section` groups. */
  section: SectionDto | null;
  /** `sectionId` of root tasks whose section was not passed in (`missing_section` groups). */
  sectionId: string | null;
  roots: readonly TaskTreeNode[];
  /** Every task placed in this group, children included. */
  taskCount: number;
}

function compareTasks(a: TaskDto, b: TaskDto): number {
  return a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function compareSections(a: SectionDto, b: SectionDto, locale: string): number {
  return a.position - b.position || a.name.localeCompare(b.name, locale) || a.id.localeCompare(b.id);
}

function countNodes(nodes: readonly TaskTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

/**
 * Groups loaded tasks into sections (by `position`, then «Без раздела») and nests children under
 * their real `parentTaskId`. A child stays under its parent even when its own section differs.
 * Every loaded task appears exactly once; cycles and missing parents never drop or loop.
 */
export function buildTaskGroups(tasks: readonly TaskDto[], sections: readonly SectionDto[], locale = localization.getLocale()): TaskGroup[] {
  const unique = dedupeTasks(tasks).sort(compareTasks);
  const byId = new Map(unique.map((task) => [task.id, task]));
  const childrenOf = new Map<string, TaskDto[]>();
  const rootTasks: { task: TaskDto; reason: TaskTreeNode['detachedReason'] }[] = [];

  for (const task of unique) {
    const parentId = task.parentTaskId;
    if (parentId === null) {
      rootTasks.push({ task, reason: null });
    } else if (!byId.has(parentId)) {
      rootTasks.push({ task, reason: 'parent_not_loaded' });
    } else {
      const siblings = childrenOf.get(parentId);
      if (siblings) siblings.push(task);
      else childrenOf.set(parentId, [task]);
    }
  }

  const visited = new Set<string>();
  const build = (task: TaskDto, depth: number, reason: TaskTreeNode['detachedReason']): TaskTreeNode => {
    visited.add(task.id);
    const children: TaskTreeNode[] = [];
    for (const child of childrenOf.get(task.id) ?? []) {
      if (!visited.has(child.id)) children.push(build(child, depth + 1, null));
    }
    return { task, depth, children, detachedReason: reason };
  };

  const roots = rootTasks.map(({ task, reason }) => build(task, 0, reason));

  // Whatever is still unvisited hangs off a parent cycle. Walk up to a task on the cycle and
  // show it as a root, so its descendants stay nested beneath it.
  for (const task of unique) {
    if (visited.has(task.id)) continue;
    let current = task;
    const path = new Set<string>();
    while (!path.has(current.id)) {
      path.add(current.id);
      const parent = current.parentTaskId === null ? undefined : byId.get(current.parentTaskId);
      if (parent === undefined || visited.has(parent.id)) break;
      current = parent;
    }
    roots.push(build(current, 0, 'cycle'));
  }

  const rootsBySection = new Map<string | null, TaskTreeNode[]>();
  for (const root of roots) {
    const key = root.task.sectionId;
    const list = rootsBySection.get(key);
    if (list) list.push(root);
    else rootsBySection.set(key, [root]);
  }

  const groups: TaskGroup[] = [];
  const knownSectionIds = new Set<string>();
  for (const section of [...sections].sort((a, b) => compareSections(a, b, locale))) {
    if (knownSectionIds.has(section.id)) continue;
    knownSectionIds.add(section.id);
    const sectionRoots = rootsBySection.get(section.id) ?? [];
    // Archived sections appear only while loaded tasks still sit in them.
    if (section.archivedAt !== null && sectionRoots.length === 0) continue;
    groups.push({
      key: `section:${section.id}`,
      kind: 'section',
      section,
      sectionId: section.id,
      roots: sectionRoots,
      taskCount: countNodes(sectionRoots),
    });
  }

  const missingSectionIds = [...rootsBySection.keys()]
    .filter((id): id is string => id !== null && !knownSectionIds.has(id))
    .sort();
  for (const sectionId of missingSectionIds) {
    const sectionRoots = rootsBySection.get(sectionId) ?? [];
    groups.push({
      key: `missing:${sectionId}`,
      kind: 'missing_section',
      section: null,
      sectionId,
      roots: sectionRoots,
      taskCount: countNodes(sectionRoots),
    });
  }

  const unsectioned = rootsBySection.get(null) ?? [];
  const hasOpenSection = sections.some((section) => section.archivedAt === null);
  if (unsectioned.length > 0 || !hasOpenSection) {
    groups.push({
      key: 'no-section',
      kind: 'no_section',
      section: null,
      sectionId: null,
      roots: unsectioned,
      taskCount: countNodes(unsectioned),
    });
  }

  return groups;
}

/** Rows to render for a group: depth-first, skipping descendants of collapsed tasks. */
export function visibleTaskRows(roots: readonly TaskTreeNode[], collapsedIds: ReadonlySet<string>): TaskTreeNode[] {
  const rows: TaskTreeNode[] = [];
  const visit = (node: TaskTreeNode): void => {
    rows.push(node);
    if (collapsedIds.has(node.task.id)) return;
    for (const child of node.children) visit(child);
  };
  for (const root of roots) visit(root);
  return rows;
}
