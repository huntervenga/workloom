import { describe, expect, it } from 'vitest';
import { createTaskTimelineCursorCodec } from './cursor.js';
import { mapTimelineRow, timelineStatement, type TimelineRow } from './timeline.js';
const id = (n: number) => `ce000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ws = id(1), task = id(4), project = id(5), field = id(6), version = id(7);
const row = (src: string, action: string, payload: Record<string, unknown>): TimelineRow => ({ src, item_id: id(10), change_seq: '12', event_ordinal: 2, recorded_at: new Date('2026-10-16T00:00:00Z'), action, actor_user_id: id(2), actor_membership_id: id(3), actor_display_name: 'Actor', actor_avatar_url: 'javascript:alert(1)', payload });
const definition = { id: field, workspaceId: ws, projectId: project, name: 'Budget (then)', type: 'number', revision: 1, definitionVersionId: version, historyEnabled: true, locked: false, archivedAt: null, options: [], createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z' };
const fieldPayload = { fieldId: field, fieldName: 'Budget (now)', fieldType: 'number', projectId: project, historyCaptured: null, history: true, historyFieldId: field, historyProjectId: project, before: null, after: { type: 'number', value: 0 }, definition };
const change = (item: ReturnType<typeof mapTimelineRow>) => item.type === 'activity' ? item.changes[0] : undefined;

describe('timeline mapper (strict, fail closed)', () => {
  it('bounds the single statement to 101 rows', () => {
    expect(() => timelineStatement(ws, task, null, 102)).toThrow(TypeError);
    expect(() => timelineStatement(ws, task, null, 0)).toThrow(TypeError);
  });
  it('shows legacy builtin ids as uncaptured, snapshot names as snapshot, and drops unknown/raw keys', () => {
    const legacy = mapTimelineRow(row('task', 'updated', { statusId: { from: id(20), to: id(21) }, reason: 'SECRET', diff: { raw: 'SECRET' } }), ws, task);
    expect(change(legacy)).toEqual({ field: 'status', from: { id: id(20), name: null, availability: 'uncaptured' }, to: { id: id(21), name: null, availability: 'uncaptured' } });
    expect(JSON.stringify(legacy)).not.toContain('SECRET');
    expect(legacy).toMatchObject({ detail: 'partial', actorAvatarUrl: null });
    const snap = mapTimelineRow(row('task', 'updated', { statusId: { from: id(20), to: id(21) }, activity: { v: 1, status: { from: { id: id(20), name: 'Doing', group: 'in_progress' }, to: { id: id(21), name: 'Done', group: 'done' } } } }), ws, task);
    expect(change(snap)).toMatchObject({ to: { name: 'Done', availability: 'snapshot', group: 'done' } });
    expect(snap).toMatchObject({ detail: 'exact' });
    expect(mapTimelineRow(row('task', 'updated', { title: { from: 1, to: {} } }), ws, task)).toMatchObject({ detail: 'uncaptured', changes: [] });
  });
  it('keeps existing typed history visible regardless of the current opt-out and redacts mismatches', () => {
    expect(change(mapTimelineRow(row('field', 'updated', fieldPayload), ws, task))).toMatchObject({ availability: 'history', fieldName: 'Budget (then)', before: null, after: { type: 'number', value: 0 } });
    expect(change(mapTimelineRow(row('field', 'updated', { ...fieldPayload, historyProjectId: id(99) }), ws, task))).toEqual({ field: 'custom', fieldId: null, fieldName: null, fieldType: null, availability: 'redacted' });
    expect(change(mapTimelineRow(row('field', 'updated', { ...fieldPayload, fieldId: null }), ws, task))).toMatchObject({ availability: 'redacted', fieldId: null });
    const noHistory = { ...fieldPayload, history: false, before: null, after: null, definition: null };
    expect(change(mapTimelineRow(row('field', 'updated', { ...noHistory, historyCaptured: false }), ws, task))).toEqual({ field: 'custom', fieldId: field, fieldName: 'Budget (now)', fieldType: 'number', availability: 'opted_out' });
    expect(change(mapTimelineRow(row('field', 'updated', noHistory), ws, task))).toMatchObject({ availability: 'uncaptured' });
  });
  it('uses the work log membership (not the actor), keeps a genuine zero and maps void to removed', () => {
    const base = { membershipId: id(30), membershipName: 'Owner', diffMembershipId: id(30), diffTaskId: task, taskId: task, diffPeriodId: id(31), periodId: id(31), period: { id: id(31), name: 'W42', localStart: '2026-10-12', localEndExclusive: '2026-10-19', timezone: 'UTC' } };
    const logged = mapTimelineRow(row('work', 'created', { ...base, beforeKind: 'null', afterKind: 'object', afterMinutes: 0, afterState: 'active' }), ws, task);
    expect(change(logged)).toMatchObject({ op: 'logged', from: null, to: 0, membership: { id: id(30), availability: 'current' }, precision: 'period' });
    expect(change(logged)).not.toMatchObject({ membership: { id: id(3) } });
    expect(change(mapTimelineRow(row('work', 'revised', { ...base, beforeKind: 'object', beforeMinutes: 30, beforeState: 'active', afterKind: 'object', afterMinutes: 30, afterState: 'void' }), ws, task))).toMatchObject({ op: 'removed', toState: 'void' });
    expect(change(mapTimelineRow(row('work', 'created', { ...base, diffMembershipId: id(3), beforeKind: 'null', afterKind: 'object', afterMinutes: 5, afterState: 'active' }), ws, task))).toMatchObject({ membership: { id: null, availability: 'redacted' } });
  });
  it('redacts an unreadable dependency end', () => {
    expect(change(mapTimelineRow(row('dependency', 'removed', { direction: 'blocks', other: false, otherId: null, otherTitle: null }), ws, task))).toEqual({ field: 'dependency', op: 'removed', direction: 'blocks', other: { id: null, title: null, availability: 'redacted' } });
  });
});
describe('timeline cursor kind', () => {
  const codec = createTaskTimelineCursorCodec({ secret: 'synthetic-timeline-cursor-secret-of-32-bytes!' });
  const binding = { version: 1, workspaceId: ws, taskId: task, actorUserId: id(2), membershipId: id(3), permissionEpoch: '1', limit: 50 } as const;
  it('round-trips the new kind and leaves old kinds unchanged', () => {
    const token = codec.encode({ ...binding, kind: 'task-timeline', changeSeq: '9223372036854775807', eventOrdinal: 1 });
    expect(codec.decode(token)).toEqual({ ...binding, kind: 'task-timeline', changeSeq: '9223372036854775807', eventOrdinal: 1 });
    expect(codec.decode(codec.encode({ ...binding, kind: 'task-activity', changeSeq: '1', eventOrdinal: 1 }))).toMatchObject({ kind: 'task-activity' });
    expect(() => codec.encode({ ...binding, kind: 'task-timeline', createdAt: '2026-10-16T00:00:00.000Z', id: id(9) } as never)).toThrow(TypeError);
  });
});


describe('explicit owner-exception timeline whitelist',()=>{
  const reason='Correct accidental entry';
  it('shows the specific exception reason without opted-out values',()=>{
    const payload={...fieldPayload,history:false,historyCaptured:false,ownerException:{policyRevision:3,reason}};
    const mapped=change(mapTimelineRow(row('field','owner_exception',payload),ws,task));
    expect(mapped).toMatchObject({availability:'opted_out',ownerException:{policyRevision:3,reason}});
    expect(mapped).not.toHaveProperty('before');expect(mapped).not.toHaveProperty('after');expect(mapped).not.toHaveProperty('definition');
  });
  it('ignores reason-like data on ordinary changes and redacts foreign field identities',()=>{
    const payload={...fieldPayload,history:false,historyCaptured:false,ownerException:{policyRevision:3,reason}};
    expect(change(mapTimelineRow(row('field','updated',payload),ws,task))).not.toHaveProperty('ownerException');
    const redacted=change(mapTimelineRow(row('field','owner_exception',{...payload,fieldId:null}),ws,task));
    expect(redacted).toMatchObject({availability:'redacted',fieldId:null});expect(redacted).not.toHaveProperty('ownerException');
  });
});
