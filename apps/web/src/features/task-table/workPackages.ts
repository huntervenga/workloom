import type { TagDto, TaskDto } from '@workloom/contracts';

function groupBy<K>(tasks: readonly TaskDto[], key: (task: TaskDto) => K): Map<K, TaskDto[]> {
  const groups = new Map<K, TaskDto[]>();
  for (const task of tasks) {
    const group = groups.get(key(task));
    if (group) group.push(task);
    else groups.set(key(task), [task]);
  }
  return groups;
}

/** The first copy with the highest `revision`. */
function newest(copies: readonly TaskDto[], revision: (task: TaskDto) => number): TaskDto | undefined {
  let best: TaskDto | undefined;
  for (const copy of copies) if (best === undefined || revision(copy) > revision(best)) best = copy;
  return best;
}

/** `tag` at the highest revision any copy embeds; tags are versioned on their own. */
function newestTag(copies: readonly TaskDto[], tag: TagDto): TagDto {
  let best = tag;
  for (const copy of copies) {
    for (const other of copy.tags) if (other.id === tag.id && other.revision > best.revision) best = other;
  }
  return best;
}

/**
 * Merges copies of one task. Its parts are versioned independently, so each comes from the copy
 * newest for that part: task fields and the tag selection by `revision`, the package estimate with
 * its `workPackageRevision`, the participant set with its `participantsRevision`. Selected tags
 * keep the newest metadata any copy holds; tags the newest task revision dropped stay dropped.
 */
function mergeCopies(copies: readonly TaskDto[]): TaskDto | undefined {
  const fields = newest(copies, (task) => task.revision);
  if (fields === undefined || copies.length === 1) return fields;
  const samePackage = copies.filter((copy) => copy.workPackageId === fields.workPackageId);
  const estimate = newest(samePackage, (task) => task.workPackageRevision) ?? fields;
  const people = newest(copies, (task) => task.participantsRevision) ?? fields;
  return {
    ...fields,
    meetingId: fields.meetingId===undefined?copies.find(copy=>copy.meetingId!==undefined)?.meetingId:fields.meetingId,
    workPackageRevision: estimate.workPackageRevision,
    estimateMinutes: estimate.estimateMinutes,
    participants: people.participants,
    participantsRevision: people.participantsRevision,
    tags: fields.tags.map((tag) => newestTag(copies, tag)),
  };
}

interface ReconciledTasks {
  tasks: TaskDto[];
  /** Packages that copies of one task disagree on; no total over them can be trusted. */
  inconsistentPackageIds: ReadonlySet<string>;
}

function reconcileTasks(tasks: readonly TaskDto[]): ReconciledTasks {
  const merged: TaskDto[] = [];
  const inconsistentPackageIds = new Set<string>();
  for (const copies of groupBy(tasks, (task) => task.id).values()) {
    const packageIds = new Set(copies.map((copy) => copy.workPackageId));
    if (packageIds.size > 1) for (const id of packageIds) inconsistentPackageIds.add(id);
    const task = mergeCopies(copies);
    if (task) merged.push(task);
  }
  return { tasks: merged, inconsistentPackageIds };
}

/**
 * One copy of each task ID, in first-seen order. When a list holds the same task twice (e.g. a
 * refetch overlapping a page), the copies are merged part by part, each part at its newest revision.
 */
export function dedupeTasks(tasks: readonly TaskDto[]): TaskDto[] {
  return reconcileTasks(tasks).tasks;
}

export type WorkPackageEstimate =
  | { status: 'estimated'; minutes: number }
  | { status: 'unestimated' }
  /**
   * Loaded copies report different estimates at the same package revision, or copies of one task
   * name different packages; data must be refetched.
   */
  | { status: 'conflict'; values: readonly (number | null)[] };

export interface WorkPackageEntry {
  workPackageId: string;
  /** Highest `workPackageRevision` among loaded tasks; older copies are ignored. */
  revision: number;
  estimate: WorkPackageEstimate;
  /** Loaded tasks sharing the package, each once, in input order. */
  taskIds: readonly string[];
}

export type WorkPackageTotal =
  | { status: 'ok'; minutes: number }
  | { status: 'needs_refresh'; conflictingPackageIds: readonly string[] };

export interface WorkPackageSummary {
  packages: ReadonlyMap<string, WorkPackageEntry>;
  /** Distinct loaded tasks. */
  taskCount: number;
  estimatedPackageCount: number;
  unestimatedPackageCount: number;
  /** Loaded tasks whose package has no estimate (`null`, not `0`). */
  unestimatedTaskCount: number;
  /**
   * Sum over loaded packages, each `workPackageId` once. It covers only the tasks passed in, never
   * the whole project, and is withheld while any package has conflicting copies.
   */
  total: WorkPackageTotal;
}

/**
 * Budget summary for the loaded tasks. `estimateMinutes` is the whole team's work package budget,
 * so detail subtasks sharing a package add nothing extra and participant counts never multiply it.
 */
export function summarizeWorkPackages(tasks: readonly TaskDto[]): WorkPackageSummary {
  const { tasks: unique, inconsistentPackageIds } = reconcileTasks(tasks);
  const tasksByPackage = groupBy(unique, (task) => task.workPackageId);
  // Every loaded copy reports its package, so two copies of one task can disagree at one revision.
  const copiesByPackage = groupBy(tasks, (task) => task.workPackageId);

  const packages = new Map<string, WorkPackageEntry>();
  const conflictingPackageIds: string[] = [];
  let totalMinutes = 0;
  let estimatedPackageCount = 0;
  let unestimatedPackageCount = 0;
  let unestimatedTaskCount = 0;

  for (const [workPackageId, packageTasks] of tasksByPackage) {
    const copies = copiesByPackage.get(workPackageId) ?? packageTasks;
    const revision = copies.reduce((max, task) => Math.max(max, task.workPackageRevision), 0);
    const values = [
      ...new Set(copies.filter((task) => task.workPackageRevision === revision).map((task) => task.estimateMinutes)),
    ];

    let estimate: WorkPackageEstimate;
    const [value = null] = values;
    if (values.length > 1 || inconsistentPackageIds.has(workPackageId)) {
      estimate = { status: 'conflict', values };
      conflictingPackageIds.push(workPackageId);
    } else if (value === null) {
      estimate = { status: 'unestimated' };
      unestimatedPackageCount += 1;
      unestimatedTaskCount += packageTasks.length;
    } else {
      estimate = { status: 'estimated', minutes: value };
      estimatedPackageCount += 1;
      totalMinutes += value;
    }

    packages.set(workPackageId, {
      workPackageId,
      revision,
      estimate,
      taskIds: packageTasks.map((task) => task.id),
    });
  }
  // A package only a superseded copy names is inconsistent too, though no loaded task shows it.
  for (const id of inconsistentPackageIds) if (!packages.has(id)) conflictingPackageIds.push(id);

  return {
    packages,
    taskCount: unique.length,
    estimatedPackageCount,
    unestimatedPackageCount,
    unestimatedTaskCount,
    total:
      conflictingPackageIds.length > 0
        ? { status: 'needs_refresh', conflictingPackageIds }
        : { status: 'ok', minutes: totalMinutes },
  };
}
