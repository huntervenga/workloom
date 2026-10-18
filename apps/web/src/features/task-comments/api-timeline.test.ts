import type { TaskTimelineItemDto } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, anna, beta, installFakeApi, json } from '../../test/fakeApi';
import { MEMBER_ID, rootPath, task } from '../planning/test/fixtures';
import { fetchTimeline, timelineRowsInContext } from './api';

/** Synthetic source-only rows shaped by @workloom/contracts; no database or server involved. */
const timelinePath = `${rootPath}/tasks/${task.id}/timeline`;
const otherTask = 'f2000000-0000-4000-8000-000000000002';
const activity: TaskTimelineItemDto = { type: 'activity', id: 'f9200000-0000-4000-8000-000000000001', workspaceId: alpha.id, taskId: task.id, changeSeq: '9007199254740993', eventOrdinal: 2, occurredAt: '2026-10-19T09:00:00.000Z', kind: 'updated', actorUserId: anna.id, actorMembershipId: MEMBER_ID, actorDisplayName: 'Current member name', actorAvatarUrl: null, detail: 'exact', changes: [{ field: 'title', from: 'Before', to: 'After' }] };
const comment: Extract<TaskTimelineItemDto, { type: 'comment' }> = { type: 'comment', id: 'f9200000-0000-4000-8000-000000000002', workspaceId: alpha.id, taskId: task.id, changeSeq: '9007199254740994', eventOrdinal: 1, occurredAt: '2026-10-19T09:05:00.000Z',
  comment: { id: 'f9200000-0000-4000-8000-000000000003', workspaceId: alpha.id, taskId: task.id, authorUserId: anna.id, authorMembershipId: MEMBER_ID, authorDisplayNameSnapshot: 'Name when posted', authorAvatarUrl: null, createdAt: '2026-10-19T09:05:00.000Z', body: 'Saved body' } };
const page = (rows: unknown[], meta: Record<string, unknown> = { requestId: 'timeline-api', nextCursor: null }) => json(200, { data: rows, meta });

describe('fetchTimeline', () => {
  it('sends one bounded GET and returns server-ordered rows with the opaque cursor untouched', async () => {
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page([comment, activity], { requestId: 'timeline-api', nextCursor: 'next/opaque+cursor=' }) });
    await expect(fetchTimeline(alpha.id, task.id, 'given/opaque+cursor=')).resolves.toEqual({ rows: [comment, activity], nextCursor: 'next/opaque+cursor=' });
    expect(calls).toHaveLength(1); expect(calls[0]?.method).toBe('GET'); expect(calls[0]?.path).toBe(timelinePath);
    expect(calls[0]?.searchParams.get('cursor')).toBe('given/opaque+cursor='); expect(calls[0]?.searchParams.get('limit')).toBe('50');
    expect([...(calls[0]?.searchParams.keys() ?? [])].sort()).toEqual(['cursor', 'limit']);
  });

  it('omits the cursor for the newest window', async () => {
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page([]) });
    await expect(fetchTimeline(alpha.id, task.id, null)).resolves.toEqual({ rows: [], nextCursor: null });
    expect(calls[0]?.searchParams.has('cursor')).toBe(false);
  });

  it.each([
    ['a row from another task', [{ ...activity, taskId: otherTask }]],
    ['a row from another workspace', [{ ...activity, workspaceId: beta.id }]],
    ['an embedded comment from another task', [{ ...comment, comment: { ...comment.comment, taskId: otherTask } }]],
    ['a raw audit payload', [{ ...activity, payload: { before: 'raw secret' } }]],
    ['values on an opted-out custom change', [{ ...activity, kind: 'field_value', changes: [{ field: 'custom', fieldId: null, fieldName: 'Secret budget', fieldType: null, availability: 'opted_out', after: { type: 'text', value: 'raw secret' } }] }]],
    ['changes on uncaptured activity', [{ ...activity, detail: 'uncaptured' }]],
    ['an unsafe changeSeq', [{ ...activity, changeSeq: '01' }]],
  ])('rejects %s', async (_case, rows) => {
    installFakeApi({ [`GET ${timelinePath}`]: () => page(rows) });
    await expect(fetchTimeline(alpha.id, task.id, null)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a page without nextCursor', async () => {
    installFakeApi({ [`GET ${timelinePath}`]: () => page([activity], { requestId: 'timeline-api' }) });
    await expect(fetchTimeline(alpha.id, task.id, null)).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects an oversized cursor before any request', async () => {
    const { calls } = installFakeApi({ [`GET ${timelinePath}`]: () => page([]) });
    await expect(fetchTimeline(alpha.id, task.id, 'c'.repeat(2049))).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

it('checks both the row and its embedded comment against the requested context', () => {
  expect(timelineRowsInContext([activity, comment], alpha.id.toUpperCase(), task.id.toUpperCase())).toBe(true);
  expect(timelineRowsInContext([{ ...comment, comment: { ...comment.comment, workspaceId: beta.id } }], alpha.id, task.id)).toBe(false);
  expect(timelineRowsInContext([activity], alpha.id, otherTask)).toBe(false);
});
