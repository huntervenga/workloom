import type { TagDto, TaskDto, TaskStatusGroup } from '@workloom/contracts';

import type { TaskWriteScope } from './ports.js';

/** One command may describe at most the bulk selection limit. */
const MAX_PAIRS = 100;
/** Public cap per added/removed list; anything beyond is counted in `omitted`, never dropped silently. */
const MAX_SET_REFS = 100;

/** `before: null` is a creation: the initial references are captured as changes from nothing. */
export interface TaskActivityPair {
  readonly before: TaskDto | null;
  readonly after: TaskDto;
}

interface LabelSnapshot {
  readonly name: string;
  readonly group?: TaskStatusGroup;
}

/** Names read once at write time, so a later rename never relabels recorded activity. */
export interface TaskActivityLabels {
  readonly statuses: ReadonlyMap<string, LabelSnapshot>;
  readonly sections: ReadonlyMap<string, LabelSnapshot>;
  readonly memberships: ReadonlyMap<string, LabelSnapshot>;
}

/** Structurally a `TaskActivityLabelRef`: a missing name stays `null`, never a guess. */
interface LabelRef {
  readonly id: string;
  readonly name: string | null;
  readonly availability: 'snapshot' | 'uncaptured';
  readonly group?: TaskStatusGroup;
}

interface RefChange {
  readonly from: LabelRef | null;
  readonly to: LabelRef | null;
}

interface SetChange {
  readonly added: readonly LabelRef[];
  readonly removed: readonly LabelRef[];
  readonly omitted: number;
}

interface ActivityMetadata {
  v: 1;
  status?: RefChange;
  section?: RefChange;
  responsible?: RefChange;
  participants?: SetChange;
  tags?: SetChange;
}

type RefPick = (task: TaskDto) => string | null;
const statusOf: RefPick = (task) => task.statusId;
const sectionOf: RefPick = (task) => task.sectionId;
const responsibleOf: RefPick = (task) => task.responsibleMembershipId;

function changed(pair: TaskActivityPair, pick: RefPick): readonly [string | null, string | null] | null {
  const from = pair.before === null ? null : pick(pair.before);
  const to = pick(pair.after);
  return from === to ? null : [from, to];
}

function activeParticipantIds(task: TaskDto | null): string[] {
  if (task === null) return [];
  return [...new Set(task.participants.filter((row) => row.active).map((row) => row.membershipId))];
}

function setDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const is = new Set(after);
  return { added: after.filter((id) => !was.has(id)), removed: before.filter((id) => !is.has(id)) };
}

function addChanged(target: Set<string>, pair: TaskActivityPair, pick: RefPick): void {
  for (const id of changed(pair, pick) ?? []) if (id !== null) target.add(id);
}

/**
 * Reads the labels of every changed status, section and membership across all pairs, once and
 * deduplicated: existing repository lookups only, no writes. Members missing from the active list
 * (revoked or removed) stay unknown. Tag names come from the task projections themselves.
 */
export async function loadTaskActivityLabels(
  scope: Pick<TaskWriteScope, 'repository' | 'context'>,
  pairs: readonly TaskActivityPair[],
): Promise<TaskActivityLabels> {
  if (pairs.length > MAX_PAIRS) throw new RangeError(`At most ${MAX_PAIRS} task changes can be described at once.`);
  const statusIds = new Set<string>();
  const sectionIds = new Set<string>();
  const membershipIds = new Set<string>();
  for (const pair of pairs) {
    addChanged(statusIds, pair, statusOf);
    addChanged(sectionIds, pair, sectionOf);
    addChanged(membershipIds, pair, responsibleOf);
    const { added, removed } = setDiff(activeParticipantIds(pair.before), activeParticipantIds(pair.after));
    for (const id of [...added, ...removed]) membershipIds.add(id);
  }

  const { repository } = scope;
  const workspaceId = scope.context.workspaceId;
  const statuses = new Map<string, LabelSnapshot>();
  for (const id of statusIds) {
    const row = await repository.findStatus(workspaceId, id);
    if (row !== null && row.id === id && row.workspaceId === workspaceId) statuses.set(id, { name: row.name, group: row.group });
  }
  const sections = new Map<string, LabelSnapshot>();
  for (const id of sectionIds) {
    const row = await repository.findSection(workspaceId, id);
    if (row !== null && row.id === id && row.workspaceId === workspaceId) sections.set(id, { name: row.name });
  }
  const memberships = new Map<string, LabelSnapshot>();
  if (membershipIds.size > 0) {
    for (const member of await repository.access.listActiveMemberships(workspaceId)) {
      if (member.workspaceId === workspaceId && membershipIds.has(member.id)) memberships.set(member.id, { name: member.displayName });
    }
  }
  return { statuses, sections, memberships };
}

function labelRef(id: string, labels: ReadonlyMap<string, LabelSnapshot>): LabelRef {
  const label = labels.get(id);
  if (label === undefined) return { id, name: null, availability: 'uncaptured' };
  return label.group === undefined
    ? { id, name: label.name, availability: 'snapshot' }
    : { id, name: label.name, availability: 'snapshot', group: label.group };
}

function refChange(pair: TaskActivityPair, pick: RefPick, labels: ReadonlyMap<string, LabelSnapshot>): RefChange | undefined {
  const ids = changed(pair, pick);
  if (ids === null) return undefined;
  const [from, to] = ids;
  return { from: from === null ? null : labelRef(from, labels), to: to === null ? null : labelRef(to, labels) };
}

function setChange(added: readonly LabelRef[], removed: readonly LabelRef[]): SetChange | undefined {
  if (added.length === 0 && removed.length === 0) return undefined;
  const omitted = Math.max(0, added.length - MAX_SET_REFS) + Math.max(0, removed.length - MAX_SET_REFS);
  return { added: added.slice(0, MAX_SET_REFS), removed: removed.slice(0, MAX_SET_REFS), omitted };
}

function tagRefs(tags: readonly TagDto[]): Map<string, LabelRef> {
  return new Map(tags.map((tag) => [tag.id, { id: tag.id, name: tag.name, availability: 'snapshot' } as const]));
}

/**
 * Pure: returns a copy of `diff` with an added `activity` summary of the changed references.
 * Every existing diff property is kept as is; titles, descriptions, custom values and other
 * tasks' titles are never copied into the summary. Inputs are not mutated.
 */
export function taskActivityDiff(
  pair: TaskActivityPair,
  diff: Readonly<Record<string, unknown>>,
  labels: TaskActivityLabels,
): Record<string, unknown> {
  const activity: ActivityMetadata = { v: 1 };
  const status = refChange(pair, statusOf, labels.statuses);
  if (status !== undefined) activity.status = status;
  const section = refChange(pair, sectionOf, labels.sections);
  if (section !== undefined) activity.section = section;
  const responsible = refChange(pair, responsibleOf, labels.memberships);
  if (responsible !== undefined) activity.responsible = responsible;

  const members = setDiff(activeParticipantIds(pair.before), activeParticipantIds(pair.after));
  const participants = setChange(
    members.added.map((id) => labelRef(id, labels.memberships)),
    members.removed.map((id) => labelRef(id, labels.memberships)),
  );
  if (participants !== undefined) activity.participants = participants;

  const tagsBefore = tagRefs(pair.before?.tags ?? []);
  const tagsAfter = tagRefs(pair.after.tags);
  const tagIds = setDiff([...tagsBefore.keys()], [...tagsAfter.keys()]);
  const tags = setChange(
    tagIds.added.flatMap((id) => tagsAfter.get(id) ?? []),
    tagIds.removed.flatMap((id) => tagsBefore.get(id) ?? []),
  );
  if (tags !== undefined) activity.tags = tags;

  return { ...diff, activity };
}
