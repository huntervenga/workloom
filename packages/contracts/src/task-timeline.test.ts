import { describe, expect, expectTypeOf, it } from 'vitest';
import { profilePhotoUrlSchema } from './profile-photo.js';
import {
  taskActivityChangeSchema,
  taskActivitySchema,
  taskCommentSchema,
  taskTimelineItemSchema,
  taskTimelineQuerySchema,
  type TaskActivityDto,
  type TaskCommentDto,
  type TaskTimelineItemDto,
} from './task-comments.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';
const COMMENT = '55555555-5555-4555-8555-555555555555';
const ACTIVITY = '66666666-6666-4666-8666-666666666666';
const FIELD = '77777777-7777-4777-8777-777777777777';
const PROJECT = '88888888-8888-4888-8888-888888888888';
const VERSION = '99999999-9999-4999-8999-999999999999';
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-10-18T12:00:00Z';
const SAFE_AVATAR = 'https://lh3.googleusercontent.com/a/AbC-12_x=s96-c?sz=96';

const comment = {
  id: COMMENT, workspaceId: WORKSPACE, taskId: TASK,
  authorUserId: USER, authorMembershipId: MEMBERSHIP,
  authorDisplayNameSnapshot: 'Ada', createdAt: AT, body: 'Looks good.',
};
const commentItem = {
  type: 'comment', id: COMMENT, workspaceId: WORKSPACE, taskId: TASK,
  changeSeq: '1', eventOrdinal: 1, occurredAt: AT, comment,
};
const activityItem = {
  type: 'activity', id: ACTIVITY, workspaceId: WORKSPACE, taskId: TASK,
  changeSeq: '2', eventOrdinal: 1, occurredAt: AT,
  kind: 'updated', actorUserId: USER, actorMembershipId: MEMBERSHIP, actorDisplayName: 'Ada',
  detail: 'exact', changes: [],
};
const legacyActivity = {
  id: ACTIVITY, workspaceId: WORKSPACE, taskId: TASK, kind: 'updated',
  actorUserId: USER, actorMembershipId: MEMBERSHIP, actorDisplayName: 'Ada',
  occurredAt: AT, changeSeq: '2', eventOrdinal: 1,
};
const definition = {
  id: FIELD, workspaceId: WORKSPACE, projectId: PROJECT, name: 'Budget', type: 'number',
  revision: 1, definitionVersionId: VERSION, historyEnabled: true, locked: false,
  archivedAt: null, options: [], createdAt: AT, updatedAt: AT,
};
const customHistory = {
  field: 'custom', fieldId: FIELD, fieldName: 'Budget', fieldType: 'number', availability: 'history',
  before: { type: 'number', value: 3 }, after: { type: 'number', value: 5 }, definition,
};

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

describe('timeline API types', () => {
  it('exposes the discriminated item and avatar types', () => {
    expectTypeOf<TaskTimelineItemDto['type']>().toEqualTypeOf<'comment' | 'activity'>();
    expectTypeOf<TaskCommentDto['authorAvatarUrl']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<TaskActivityDto['actorAvatarUrl']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<Extract<TaskTimelineItemDto, { type: 'activity' }>['actorAvatarUrl']>().toEqualTypeOf<string | null | undefined>();
  });

  it('parses both item kinds and rejects unknown kinds', () => {
    const parsed: TaskTimelineItemDto = taskTimelineItemSchema.parse(commentItem);
    expect(parsed.type === 'comment' && parsed.comment.body).toBe('Looks good.');
    expect(accepts(taskTimelineItemSchema, activityItem)).toBe(true);
    expect(accepts(taskTimelineItemSchema, { ...activityItem, type: 'system' })).toBe(false);
    expect(accepts(taskTimelineItemSchema, { ...commentItem, kind: 'updated' })).toBe(false);
  });
});

describe('timeline comment matching', () => {
  it('rejects a comment from another task or workspace', () => {
    expect(accepts(taskTimelineItemSchema, { ...commentItem, comment: { ...comment, taskId: OTHER } })).toBe(false);
    expect(accepts(taskTimelineItemSchema, { ...commentItem, comment: { ...comment, workspaceId: OTHER } })).toBe(false);
    expect(accepts(taskTimelineItemSchema, { ...commentItem, taskId: OTHER })).toBe(false);
  });
});

describe('avatar URLs use the canonical profile photo policy', () => {
  const contexts = {
    comment: (url: unknown) => taskCommentSchema.safeParse({ ...comment, authorAvatarUrl: url }).success,
    legacyActivity: (url: unknown) => taskActivitySchema.safeParse({ ...legacyActivity, actorAvatarUrl: url }).success,
    timelineActivity: (url: unknown) => taskTimelineItemSchema.safeParse({ ...activityItem, actorAvatarUrl: url }).success,
    timelineComment: (url: unknown) => taskTimelineItemSchema.safeParse({ ...commentItem, comment: { ...comment, authorAvatarUrl: url } }).success,
  };
  const unsafe = [
    'http://cdn.acme.com/a.png',
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://10.0.0.8/a.png',
    'https://[::1]/a.png',
    'https://printer.local/a.png',
    'https://wiki.corp/a.png',
    'https://cdn.acme.com:8443/a.png',
    'https://user:secret@cdn.acme.com/a.png',
    'https://cdn.acme.com/a.png?token=abc123',
    'https://cdn.acme.com/a.png?sz=96&sig=abc',
    'https://cdn.acme.com/a.png?sz=4096',
    'https://cdn.acme.com/a.png#frag',
    'https://CDN.acme.com/a.png',
    ' https://cdn.acme.com/a.png',
    `https://cdn.acme.com/${'a'.repeat(2100)}`,
  ];

  it('preserves an absent key and null without inventing a default', () => {
    const absent = taskCommentSchema.parse(comment);
    expect('authorAvatarUrl' in absent).toBe(false);
    expect(taskCommentSchema.parse({ ...comment, authorAvatarUrl: null }).authorAvatarUrl).toBeNull();
    const absentActivity = taskTimelineItemSchema.parse(activityItem);
    expect('actorAvatarUrl' in absentActivity).toBe(false);
    expect('actorAvatarUrl' in taskActivitySchema.parse(legacyActivity)).toBe(false);
  });

  it.each(Object.entries(contexts))('%s accepts a safe URL and rejects unsafe ones', (_name, check) => {
    expect(check(SAFE_AVATAR)).toBe(true);
    expect(check(null)).toBe(true);
    for (const url of unsafe) expect(check(url), url).toBe(false);
  });

  it('agrees with profilePhotoUrlSchema for every URL', () => {
    for (const url of [SAFE_AVATAR, ...unsafe]) {
      expect(contexts.comment(url), url).toBe(profilePhotoUrlSchema.safeParse(url).success);
    }
  });
});

describe('custom field changes', () => {
  it('distinguishes typed null from absent values', () => {
    expect(accepts(taskActivityChangeSchema, { ...customHistory, before: null })).toBe(true);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, after: { type: 'number', value: null } })).toBe(true);
    const { before: _before, ...withoutBefore } = customHistory;
    const { after: _after, ...withoutAfter } = customHistory;
    expect(accepts(taskActivityChangeSchema, withoutBefore)).toBe(false);
    expect(accepts(taskActivityChangeSchema, withoutAfter)).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, after: null })).toBe(false);
  });

  it('exposes values only with recorded history', () => {
    const bare = { field: 'custom', fieldId: FIELD, fieldName: 'Budget', fieldType: 'number' };
    for (const availability of ['opted_out', 'uncaptured'] as const) {
      expect(accepts(taskActivityChangeSchema, { ...bare, availability })).toBe(true);
      expect(accepts(taskActivityChangeSchema, { ...bare, availability, after: { type: 'number', value: 5 } })).toBe(false);
      expect(accepts(taskActivityChangeSchema, { ...bare, availability, before: null })).toBe(false);
      expect(accepts(taskActivityChangeSchema, { ...bare, availability, definition })).toBe(false);
    }
    const { definition: _definition, ...withoutDefinition } = customHistory;
    expect(accepts(taskActivityChangeSchema, withoutDefinition)).toBe(false);
  });

  it('gives redacted changes no field identity', () => {
    const redacted = { field: 'custom', fieldId: null, fieldName: null, fieldType: null, availability: 'redacted' };
    expect(accepts(taskActivityChangeSchema, redacted)).toBe(true);
    expect(accepts(taskActivityChangeSchema, { ...redacted, fieldId: FIELD })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...redacted, fieldName: 'Budget' })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...redacted, fieldType: 'number' })).toBe(false);
  });

  it('requires the definition snapshot and values to describe the same field and type', () => {
    expect(accepts(taskActivityChangeSchema, customHistory)).toBe(true);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, definition: { ...definition, id: OTHER } })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, fieldType: 'text' })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, after: { type: 'text', value: '5' } })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, before: { type: 'boolean', value: true } })).toBe(false);
  });
});

describe('no raw audit data', () => {
  it.each(['rawDiff', 'reason', 'source', 'payload'])('rejects %s on activity', (key) => {
    expect(accepts(taskTimelineItemSchema, { ...activityItem, [key]: 'x' })).toBe(false);
    expect(accepts(taskActivitySchema, { ...legacyActivity, [key]: 'x' })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { ...customHistory, [key]: 'x' })).toBe(false);
  });

  it('never carries description or position values', () => {
    expect(accepts(taskActivityChangeSchema, { field: 'description' })).toBe(true);
    expect(accepts(taskActivityChangeSchema, { field: 'description', from: 'old', to: 'new' })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { field: 'position', to: 3 })).toBe(false);
  });
});

describe('sequence and paging bounds', () => {
  it('accepts changeSeq only as a canonical positive bigint string', () => {
    const withSeq = (changeSeq: unknown) => accepts(taskTimelineItemSchema, { ...activityItem, changeSeq });
    expect(withSeq('1')).toBe(true);
    expect(withSeq('9223372036854775807')).toBe(true);
    for (const bad of ['0', '01', '-1', '1.5', ' 1', '12345678901234567890', 1, 1n]) {
      expect(withSeq(bad), String(bad)).toBe(false);
    }
  });

  it('caps a page at 100 items', () => {
    expect(taskTimelineQuerySchema.parse({}).limit).toBe(50);
    expect(taskTimelineQuerySchema.parse({ limit: '100' }).limit).toBe(100);
    expect(accepts(taskTimelineQuerySchema, { limit: 101 })).toBe(false);
    expect(accepts(taskTimelineQuerySchema, { limit: 0 })).toBe(false);
    expect(accepts(taskTimelineQuerySchema, { cursor: 'c'.repeat(2049) })).toBe(false);
    expect(accepts(taskTimelineQuerySchema, { limit: 10, offset: 5 })).toBe(false);
  });
});

describe('status group', () => {
  const doing = { id: OTHER, name: 'Doing', availability: 'snapshot', group: 'in_progress' };
  const shipped = { id: FIELD, name: 'Shipped', availability: 'current', group: 'done' };

  it('keeps completion readable after a rename', () => {
    const change = taskActivityChangeSchema.parse({ field: 'status', from: doing, to: shipped });
    expect(change.field === 'status' && change.from?.group).toBe('in_progress');
    expect(change.field === 'status' && change.to?.group).toBe('done');
  });

  it('allows a group only on known labels', () => {
    expect(accepts(taskActivityChangeSchema, { field: 'status', from: null, to: { id: null, name: null, availability: 'redacted', group: 'done' } })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { field: 'status', from: null, to: { id: OTHER, name: null, availability: 'uncaptured', group: 'done' } })).toBe(false);
    expect(accepts(taskActivityChangeSchema, { field: 'status', from: null, to: { ...shipped, group: 'shipped' } })).toBe(false);
  });
});
