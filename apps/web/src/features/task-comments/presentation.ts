import type { TaskActivityChangeDto, TaskTimelineItemDto } from '@workloom/contracts';
import type { TranslationKey, TranslationParameters } from '../../i18n';

export type ActivityItem = Extract<TaskTimelineItemDto, { type: 'activity' }>;
type Change<F extends TaskActivityChangeDto['field']> = Extract<TaskActivityChangeDto, { field: F }>;
export type LabelRef = NonNullable<Change<'status'>['from']>;
export type TaskRef = NonNullable<Change<'parent'>['from']>;

/** Fixed copy, or user data rendered strictly as plain text (never markup or links). */
export type Phrase = { key: TranslationKey; params?: TranslationParameters };
export type Shown = Phrase | { text: string; note?: TranslationKey } | { date: string } | { number: number };
export interface ChangeLine {
  label: Phrase;
  from?: Shown[];
  to?: Shown[];
  value?: Shown[];
  note?: Phrase;
  added?: Shown[];
  removed?: Shown[];
  omitted?: number;
  openTaskId?: string;
}

/**
 * The server already orders one window by (changeSeq, eventOrdinal) DESC across comments and
 * activity, comparing sequences as big integers. Pages are only deduplicated by ID, keeping the
 * received order, and reversed for oldest → newest display; nothing is re-sorted or merged here.
 */
export function chronological<T extends { id: string }>(pages: readonly { rows: readonly T[] }[] | undefined): T[] {
  const seen = new Set<string>();
  const received = (pages ?? []).flatMap(page => page.rows.filter(row => { if (seen.has(row.id)) return false; seen.add(row.id); return true; }));
  return received.reverse();
}

const none: Phrase = { key: 'activity.value.none' };

export function labelShown(ref: LabelRef | null): Shown {
  if (ref === null) return none;
  if (ref.availability === 'redacted') return { key: 'activity.value.redacted' };
  if (ref.availability === 'uncaptured') return { key: 'activity.value.uncaptured' };
  if (ref.name === null) return { key: 'activity.value.unnamed' };
  // A current name was looked up later; it is never presented as the name at the time.
  return ref.availability === 'current' ? { text: ref.name, note: 'activity.value.currentName' } : { text: ref.name };
}

export function taskRefShown(ref: TaskRef | null): Shown {
  if (ref === null) return none;
  if (ref.availability === 'redacted') return { key: 'activity.value.redacted' };
  if (ref.title === null) return { key: 'activity.value.untitled' };
  return { text: ref.title, note: 'activity.value.currentName' };
}

/** `null` is "nothing recorded"; `0` is a real zero and shown as such. */
export function minutesShown(minutes: number | null, empty: TranslationKey = 'activity.value.none'): Shown {
  if (minutes === null) return { key: empty };
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours === 0) return { key: 'activity.value.minutes', params: { minutes: rest } };
  return rest === 0 ? { key: 'activity.value.hours', params: { hours } } : { key: 'activity.value.hoursMinutes', params: { hours, minutes: rest } };
}

const dateShown = (date: string | null): Shown => date === null ? none : { date };
const textShown = (text: string | null): Shown => text === null ? none : text === '' ? { key: 'activity.value.empty' } : { text };

const priorityKeys: Readonly<Record<string, TranslationKey>> = {
  low: 'activity.priority.low', medium: 'activity.priority.medium', high: 'activity.priority.high', urgent: 'activity.priority.urgent',
};
const priorityShown = (priority: string | null): Shown => priority === null ? none : priorityKeys[priority] ? { key: priorityKeys[priority] } : { text: priority };

export type Milestone = 'completed' | 'reopened';
/** Only claimed when both groups are known: an uncaptured side never implies completion or reopening. */
export function statusMilestone(change: Change<'status'>): Milestone | null {
  const from = change.from?.group, to = change.to?.group;
  if (to === 'done' && (change.from === null || from !== undefined && from !== 'done')) return 'completed';
  if (from === 'done' && to !== undefined && to !== 'done') return 'reopened';
  return null;
}
export function activityMilestone(item: ActivityItem): Milestone | null {
  for (const change of item.changes) if (change.field === 'status') { const milestone = statusMilestone(change); if (milestone) return milestone; }
  return null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function optionNames(definition: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const source = isRecord(definition) ? definition.options ?? (isRecord(definition.config) ? definition.config.options : undefined) : undefined;
  if (Array.isArray(source)) for (const option of source) {
    if (!isRecord(option) || typeof option.id !== 'string') continue;
    const name = typeof option.name === 'string' ? option.name : typeof option.label === 'string' ? option.label : null;
    if (name !== null) names.set(option.id, name);
  }
  return names;
}
const valueProps = ['optionIds', 'optionId', 'values', 'value', 'text', 'number', 'date', 'checked', 'minutes', 'name', 'label'] as const;
function fieldValue(value: unknown, options: Map<string, string>, depth: number): Shown[] {
  if (value === null) return [{ key: 'activity.value.empty' }];
  if (typeof value === 'string') { const option = options.get(value); return [option !== undefined ? { text: option } : value === '' ? { key: 'activity.value.empty' } : { text: value }]; }
  if (typeof value === 'number') return [{ number: value }];
  if (typeof value === 'boolean') return [{ key: value ? 'activity.value.yes' : 'activity.value.no' }];
  if (depth < 3 && Array.isArray(value)) return value.length === 0 ? [{ key: 'activity.value.empty' }] : value.flatMap(entry => fieldValue(entry, options, depth + 1));
  if (depth < 3 && isRecord(value)) for (const prop of valueProps) if (prop in value) return fieldValue(value[prop], options, depth + 1);
  // Never dump a structured value as raw JSON.
  return [{ key: 'activity.value.unrecognized' }];
}
/**
 * A historical custom value read through the definition captured with the change, so option
 * names are the ones of that time. An absent historical row (`null`) differs from a typed value with `value: null` (empty).
 */
export function customShown(value: unknown, definition: unknown, absent: TranslationKey): Shown[] {
  return value === undefined || value === null ? [{ key: absent }] : fieldValue(value, optionNames(definition), 0);
}

const field = (key: TranslationKey): Phrase => ({ key });
const labelFields = { status: 'activity.field.status', section: 'activity.field.section', responsible: 'activity.field.responsible' } satisfies Record<string, TranslationKey>;
const dependencyKeys = {
  added: { blocks: 'activity.dependency.addedBlocks', blocked_by: 'activity.dependency.addedBlockedBy' },
  removed: { blocks: 'activity.dependency.removedBlocks', blocked_by: 'activity.dependency.removedBlockedBy' },
} satisfies Record<string, Record<string, TranslationKey>>;
const workKeys = { logged: 'activity.work.logged', edited: 'activity.work.edited', removed: 'activity.work.removed' } satisfies Record<string, TranslationKey>;
const workStates = { active: 'activity.work.state.active', void: 'activity.work.state.void' } satisfies Record<string, TranslationKey>;
const workState = (state: 'active' | 'void' | null): Shown => state === null ? none : { key: workStates[state] };
const calendarDate = /^\d{4}-\d{2}-\d{2}$/;
function lastIncludedDay(endExclusive: string): string | null {
  if (!calendarDate.test(endExclusive)) return null;
  const day = new Date(`${endExclusive}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** Every change becomes at least one line; unknown fields are announced, never silently dropped. */
export function describeChange(change: TaskActivityChangeDto): ChangeLine[] {
  switch (change.field) {
    case 'title': return [{ label: field('activity.field.title'), from: [textShown(change.from)], to: [textShown(change.to)] }];
    case 'description': return [{ label: field('activity.field.description'), note: { key: 'activity.change.descriptionChanged' } }];
    case 'position': return [{ label: field('activity.field.position'), note: { key: 'activity.change.positionChanged' } }];
    case 'status': case 'section': case 'responsible': {
      const milestone = change.field === 'status' ? statusMilestone(change) : null;
      return [{ label: field(labelFields[change.field]), from: [labelShown(change.from)], to: [labelShown(change.to)], ...(milestone ? { note: { key: `activity.milestone.${milestone}` as const } } : {}) }];
    }
    case 'parent': return [{ label: field('activity.field.parent'), from: [taskRefShown(change.from)], to: [taskRefShown(change.to)] }];
    case 'startDate': case 'dueDate': {
      const label = field(change.field === 'startDate' ? 'activity.field.startDate' : 'activity.field.dueDate');
      return change.availability === 'uncaptured' ? [{ label, note: { key: 'activity.change.datesUncaptured' } }] : [{ label, from: [dateShown(change.from)], to: [dateShown(change.to)] }];
    }
    case 'priority': return [{ label: field('activity.field.priority'), from: [priorityShown(change.from)], to: [priorityShown(change.to)] }];
    case 'estimate': return [{ label: field('activity.field.estimate'), from: [minutesShown(change.from, 'activity.value.noEstimate')], to: [minutesShown(change.to, 'activity.value.noEstimate')] }];
    case 'tags': case 'participants': return [{
      label: field(change.field === 'tags' ? 'activity.field.tags' : 'activity.field.participants'),
      added: change.added.map(labelShown), removed: change.removed.map(labelShown), omitted: change.omitted,
    }];
    case 'custom': {
      const label: Phrase = change.fieldName === null ? { key: 'activity.field.customUnknown' } : { key: 'activity.field.custom', params: { name: change.fieldName } };
      const exception:ChangeLine[]=change.ownerException?[{label:{key:'fieldRules.ownerException'},value:[{text:change.ownerException.reason}]}]:[];
      if (change.availability !== 'history') return [...exception,{ label, note: { key: `activity.custom.${change.availability}` as const } }];
      return [...exception,{ label, from: customShown(change.before, change.definition, 'activity.value.noPrevious'), to: customShown(change.after, change.definition, 'activity.value.cleared') }];
    }
    case 'dependency': {
      const open = change.other.availability === 'current' && change.other.id !== null ? { openTaskId: change.other.id } : {};
      return [{ label: field(dependencyKeys[change.op][change.direction]), value: [taskRefShown(change.other)], ...open }];
    }
    case 'work': {
      const { period } = change;
      const last = lastIncludedDay(period.localEndExclusive);
      const range: Shown[] = calendarDate.test(period.localStart) && last !== null ? [{ date: period.localStart }, { date: last }] : [];
      return [
        { label: field(workKeys[change.op]), value: [labelShown(change.membership)] },
        { label: field('activity.work.period'), value: [{ text: period.name }, ...range], note: { key: 'activity.work.precision', params: { timezone: period.timezone } } },
        { label: field('activity.work.amount'), from: [minutesShown(change.from, 'activity.value.noEntry')], to: [minutesShown(change.to, 'activity.value.noEntry')] },
        ...(change.fromState !== change.toState ? [{ label: field('activity.work.stateLabel'), from: [workState(change.fromState)], to: [workState(change.toState)] }] : []),
      ];
    }
    default: return [{ label: field('activity.field.other'), note: { key: 'activity.change.otherChanged' } }];
  }
}

const kindKeys: Readonly<Record<string, TranslationKey>> = {
  created: 'activity.kind.created', updated: 'activity.kind.updated', archived: 'activity.kind.archived', restored: 'activity.kind.restored',
  schedule_updated: 'activity.kind.schedule_updated', field_value: 'activity.kind.field_value', dependency: 'activity.kind.dependency', work: 'activity.kind.work',
};
export function headline(item: ActivityItem): TranslationKey {
  const milestone = activityMilestone(item);
  return milestone ? `activity.kind.${milestone}` : kindKeys[item.kind] ?? 'activity.kind.updated';
}
const detailKeys = { exact: null, partial: 'activity.detail.partial', uncaptured: 'activity.detail.uncaptured' } satisfies Record<ActivityItem['detail'], TranslationKey | null>;
export const detailNote = (item: ActivityItem): TranslationKey | null => detailKeys[item.detail];
