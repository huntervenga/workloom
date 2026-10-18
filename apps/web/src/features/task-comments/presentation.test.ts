import type { TaskActivityChangeDto, TaskTimelineItemDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { chronological, customShown, describeChange, headline, labelShown, minutesShown, statusMilestone, type ActivityItem, type LabelRef } from './presentation';

const WS = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const MEMBER = '00000000-0000-4000-8000-000000000004';
const OTHER = '00000000-0000-4000-8000-000000000005';
const FIELD = '00000000-0000-4000-8000-000000000006';

const activity = (id: string, changes: TaskActivityChangeDto[], extra: Partial<ActivityItem> = {}): ActivityItem => ({
  type: 'activity', id, workspaceId: WS, taskId: TASK, changeSeq: '9007199254740993', eventOrdinal: 0, occurredAt: '2026-10-01T10:00:00.000Z',
  kind: 'updated', actorUserId: USER, actorMembershipId: MEMBER, actorDisplayName: 'Ana', actorAvatarUrl: null, detail: 'exact', changes, ...extra,
} as ActivityItem);
const comment = (id: string, changeSeq: string, eventOrdinal: number, occurredAt: string): TaskTimelineItemDto => ({
  type: 'comment', id, workspaceId: WS, taskId: TASK, changeSeq, eventOrdinal, occurredAt,
  comment: { id, workspaceId: WS, taskId: TASK, authorUserId: USER, authorMembershipId: MEMBER, authorDisplayNameSnapshot: 'Ana', createdAt: occurredAt, body: 'hi' },
} as TaskTimelineItemDto);
const ref = (name: string | null, availability: LabelRef['availability'], group?: LabelRef['group']): LabelRef =>
  ({ id: availability === 'redacted' ? null : OTHER, name: availability === 'redacted' ? null : name, availability, ...(group ? { group } : {}) } as LabelRef);

describe('chronological', () => {
  it('only dedupes by ID and reverses the server order, never re-sorting mixed rows', () => {
    // Same transaction (changeSeq) with two ordinals, a comment between activities, and a page overlap.
    // Timestamps deliberately disagree with the server order: the client must not sort by them.
    const newest = activity('a3', [], { changeSeq: '9007199254740993', eventOrdinal: 2, occurredAt: '2026-10-01T09:00:00.000Z' });
    const sameTx = comment('c2', '9007199254740993', 1, '2026-10-01T11:00:00.000Z');
    const older = activity('a1', [], { changeSeq: '9007199254740992', eventOrdinal: 0 });
    const oldest = comment('c0', '9007199254740991', 0, '2026-10-01T12:00:00.000Z');
    const rows = chronological([{ rows: [newest, sameTx, older] }, { rows: [older, oldest] }]);
    expect(rows.map(row => row.id)).toEqual(['c0', 'a1', 'c2', 'a3']);
    expect(rows[2]?.changeSeq).toBe('9007199254740993');
  });
  it('is empty before any page arrives', () => expect(chronological(undefined)).toEqual([]));
});

describe('status milestones', () => {
  const status = (from: LabelRef | null, to: LabelRef | null) => ({ field: 'status', from, to }) as Extract<TaskActivityChangeDto, { field: 'status' }>;
  it('detects completion and reopening from groups', () => {
    expect(statusMilestone(status(ref('Open', 'snapshot', 'todo'), ref('Done', 'snapshot', 'done')))).toBe('completed');
    expect(statusMilestone(status(ref('Done', 'snapshot', 'done'), ref('Open', 'snapshot', 'todo')))).toBe('reopened');
    expect(headline(activity('a', [status(ref('Done', 'snapshot', 'done'), ref('Open', 'snapshot', 'todo'))]))).toBe('activity.kind.reopened');
  });
  it('claims nothing when one side is uncaptured or both are done', () => {
    expect(statusMilestone(status(ref(null, 'uncaptured'), ref('Done', 'snapshot', 'done')))).toBeNull();
    expect(statusMilestone(status(ref('Done', 'snapshot', 'done'), ref(null, 'uncaptured')))).toBeNull();
    expect(statusMilestone(status(ref('Done', 'snapshot', 'done'), ref('Shipped', 'snapshot', 'done')))).toBeNull();
  });
});

describe('values', () => {
  it('labels snapshot, current, uncaptured and redacted names truthfully', () => {
    expect(labelShown(ref('Old name', 'snapshot'))).toEqual({ text: 'Old name' });
    expect(labelShown(ref('Now', 'current'))).toEqual({ text: 'Now', note: 'activity.value.currentName' });
    expect(labelShown(ref(null, 'uncaptured'))).toEqual({ key: 'activity.value.uncaptured' });
    expect(labelShown(ref(null, 'redacted'))).toEqual({ key: 'activity.value.redacted' });
    expect(labelShown(null)).toEqual({ key: 'activity.value.none' });
  });
  it('keeps a zero apart from nothing recorded', () => {
    expect(minutesShown(0, 'activity.value.noEstimate')).toEqual({ key: 'activity.value.minutes', params: { minutes: 0 } });
    expect(minutesShown(null, 'activity.value.noEstimate')).toEqual({ key: 'activity.value.noEstimate' });
    expect(minutesShown(150)).toEqual({ key: 'activity.value.hoursMinutes', params: { hours: 2, minutes: 30 } });
  });
  it('reads custom values through the historical definition, separating absent, null and 0', () => {
    const definition = { options: [{ id: 'opt-1', name: 'Name back then' }] };
    expect(customShown(undefined, definition, 'activity.value.noPrevious')).toEqual([{ key: 'activity.value.noPrevious' }]);
    expect(customShown(null, definition, 'activity.value.noPrevious')).toEqual([{ key: 'activity.value.noPrevious' }]);
    expect(customShown({ type: 'number', value: null }, definition, 'activity.value.noPrevious')).toEqual([{ key: 'activity.value.empty' }]);
    expect(customShown(0, definition, 'activity.value.noPrevious')).toEqual([{ number: 0 }]);
    expect(customShown({ optionIds: ['opt-1', 'gone'] }, definition, 'activity.value.cleared')).toEqual([{ text: 'Name back then' }, { text: 'gone' }]);
    expect(customShown({ nested: { deep: true } }, definition, 'activity.value.cleared')).toEqual([{ key: 'activity.value.unrecognized' }]);
  });
});

describe('describeChange', () => {
  it('shows no values when custom history is turned off, uncaptured or redacted', () => {
    for (const availability of ['opted_out', 'uncaptured', 'redacted'] as const) {
      const [line] = describeChange({ field: 'custom', fieldId: FIELD, fieldName: 'Budget', fieldType: null, availability } as TaskActivityChangeDto);
      expect(line).toEqual({ label: { key: 'activity.field.custom', params: { name: 'Budget' } }, note: { key: `activity.custom.${availability}` } });
    }
  });
  it('renders typed custom before/after including an absent old value', () => {
    const [line] = describeChange({ field: 'custom', fieldId: FIELD, fieldName: 'Points', fieldType: null, availability: 'history', after: 0 } as unknown as TaskActivityChangeDto);
    expect(line?.from).toEqual([{ key: 'activity.value.noPrevious' }]);
    expect(line?.to).toEqual([{ number: 0 }]);
  });
  it('says only that the description changed', () => {
    expect(describeChange({ field: 'description' } as TaskActivityChangeDto)).toEqual([{ label: { key: 'activity.field.description' }, note: { key: 'activity.change.descriptionChanged' } }]);
  });
  it('does not invent dates that were not captured', () => {
    const [line] = describeChange({ field: 'dueDate', from: null, to: null, availability: 'uncaptured' } as TaskActivityChangeDto);
    expect(line).toEqual({ label: { key: 'activity.field.dueDate' }, note: { key: 'activity.change.datesUncaptured' } });
  });
  it('describes dependency direction and links only a current other task', () => {
    const [current] = describeChange({ field: 'dependency', op: 'removed', direction: 'blocked_by', other: { id: OTHER, title: 'Design', availability: 'current' } } as TaskActivityChangeDto);
    expect(current).toEqual({ label: { key: 'activity.dependency.removedBlockedBy' }, value: [{ text: 'Design', note: 'activity.value.currentName' }], openTaskId: OTHER });
    const [hidden] = describeChange({ field: 'dependency', op: 'added', direction: 'blocks', other: { id: null, title: null, availability: 'redacted' } } as TaskActivityChangeDto);
    expect(hidden).toEqual({ label: { key: 'activity.dependency.addedBlocks' }, value: [{ key: 'activity.value.redacted' }] });
  });
  it('describes manual work with member, inclusive period, 0 vs no entry, and state', () => {
    const lines = describeChange({
      field: 'work', op: 'edited', from: null, to: 0, fromState: 'active', toState: 'void', membership: ref('Ben', 'snapshot'),
      period: { id: OTHER, name: 'October', localStart: '2026-10-01', localEndExclusive: '2026-11-01', timezone: 'Europe/Paris' }, precision: 'period',
    } as TaskActivityChangeDto);
    expect(lines).toEqual([
      { label: { key: 'activity.work.edited' }, value: [{ text: 'Ben' }] },
      { label: { key: 'activity.work.period' }, value: [{ text: 'October' }, { date: '2026-10-01' }, { date: '2026-10-31' }], note: { key: 'activity.work.precision', params: { timezone: 'Europe/Paris' } } },
      { label: { key: 'activity.work.amount' }, from: [{ key: 'activity.value.noEntry' }], to: [{ key: 'activity.value.minutes', params: { minutes: 0 } }] },
      { label: { key: 'activity.work.stateLabel' }, from: [{ key: 'activity.work.state.active' }], to: [{ key: 'activity.work.state.void' }] },
    ]);
  });
  it('announces an unknown field instead of dropping it', () => {
    expect(describeChange({ field: 'future' } as unknown as TaskActivityChangeDto)).toEqual([{ label: { key: 'activity.field.other' }, note: { key: 'activity.change.otherChanged' } }]);
  });
});
