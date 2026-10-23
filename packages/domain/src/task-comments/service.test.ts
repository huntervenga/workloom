import { describe, expect, it, vi } from 'vitest';
import type { TaskActivityDto, TaskCommentDto, TaskTimelineItemDto } from '@workloom/contracts';
import { authorizeWorkspace } from '../access/access-queries.js';
import type { CommandContext } from '../access/context.js';
import type { AccessRepository, WorkspaceAccessRecord } from '../access/ports.js';
import { createPlanningMutationGuard } from '../planning/freeze.js';
import type { PlanningWriteScope } from '../planning/ports.js';
import type { IdempotencyRecord } from '../tasks/ports.js';
import { createTaskCommentsApplication } from './service.js';
import type { CommentTarget, TaskCommentsRepository, TaskCommentsTools, TaskCommentsUnitOfWork, TaskTimelineCursor } from './ports.js';
const id = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const time = '2026-10-16T00:00:00.000Z';
const ctx: CommandContext = { workspaceId: id(1), actor: { userId: id(2), displayName: 'Untrusted context label', kind: 'fixture' }, source: 'web', requestId: 'comments-test', idempotencyKey: 'test-key' };
function setup() {
  let access: WorkspaceAccessRecord | null = { workspace: { id: id(1), name: 'Test', timezone: 'UTC', weekStart: 1 }, membership: { id: id(3), workspaceId: id(1), userId: id(2), displayName: 'Trusted author', role: 'member', state: 'active', revision: 1 } };
  let current: CommentTarget | null = { id: id(4), projectId: id(5), visibility: 'workspace', archivedAt: null, projectArchivedAt: null };
  const order: string[] = [], receipts = new Map<string, IdempotencyRecord>(), comments: TaskCommentDto[] = [], activities: TaskActivityDto[] = [], timeline: TaskTimelineItemDto[] = [];
  const accessRepo = { findWorkspaceAccess: async () => { order.push('access'); return access; } } as unknown as AccessRepository;
  const repo: TaskCommentsRepository = {
    access: accessRepo, permissionEpoch: async () => '3',
    findTarget: vi.fn(async () => { order.push('target'); return current; }),
    findIdempotency: vi.fn(async (_ws, _user, _command, key) => { order.push('receipt'); return receipts.get(key) ?? null; }),
    insertIdempotency: vi.fn(async row => { receipts.set(row.idempotencyKey, row); }),
    insertComment: vi.fn(async row => { comments.push(row); }),
    insertMentions: vi.fn(async () => undefined),
    listComments: vi.fn(async () => comments), listActivity: vi.fn(async () => activities),
    listTimeline: vi.fn(async () => timeline),
  };
  const record = vi.fn(async () => ({ changeSeq: 1n, eventOrdinal: 1 }));
  const guard = createPlanningMutationGuard({} as PlanningWriteScope, { newId: () => id(6), digest: value => value });
  const check = vi.spyOn(guard, 'check');
  const unit: TaskCommentsUnitOfWork = {
    read: work => work(repo),
    run: async (context, capability, work) => {
      const authorized = await authorizeWorkspace(repo.access, context, capability);
      return work({ context, access: authorized, barrierAt: new Date(time), recordChange: record, repository: repo, planningGuard: guard });
    },
  };
  const tools: TaskCommentsTools = { newId: () => id(6), digest: value => value, encodeCursor: value => JSON.stringify(value), decodeCursor: vi.fn(value => { order.push('decode'); return JSON.parse(value) as TaskTimelineCursor; }) };
  return { app: createTaskCommentsApplication(unit, tools), repo, tools, order, comments, activities, timeline, receipts, record, check, setAccess: (value: WorkspaceAccessRecord | null) => { access = value; }, getAccess: () => access as WorkspaceAccessRecord, setTarget: (value: CommentTarget | null) => { current = value; }, getTarget: () => current as CommentTarget };
}
describe('create-only comments and safe task timeline domain', () => {
  it('uses server-authoritative author/time and exact text, with metadata-only events and an inert intent', async () => {
    const test = setup(), body = '  <b>Exact text</b>\r\n next  ';
    const result = await test.app.createComment(ctx, id(4), { body });
    expect(result).toEqual({ id: id(6), workspaceId: id(1), taskId: id(4), authorUserId: id(2), authorMembershipId: id(3), authorDisplayNameSnapshot: 'Trusted author', createdAt: time, body });
    expect(test.check).toHaveBeenCalledWith({ family: 'comment', command: 'task.comment.create', target: { taskId: id(4) }, input: { body } });
    expect(test.record.mock.calls[0]).not.toContain(body);
    expect(JSON.stringify(test.record.mock.calls)).not.toContain(body);
    expect(test.order).toEqual(['access', 'target', 'receipt']);
    expect(test.receipts.get('test-key')?.result).toEqual(result);
  });
  it('replays the exact confirmed result after archive without a new row/event/receipt', async () => {
    const test = setup(), result = await test.app.createComment(ctx, id(4), { body: 'Original' });
    test.setTarget({ ...test.getTarget(), archivedAt: time });
    expect(await test.app.createComment(ctx, id(4), { body: 'Original' })).toEqual(result);
    expect(test.repo.insertComment).toHaveBeenCalledTimes(1); expect(test.record).toHaveBeenCalledTimes(1); expect(test.repo.insertIdempotency).toHaveBeenCalledTimes(1);
    await expect(test.app.createComment({ ...ctx, idempotencyKey: 'new' }, id(4), { body: 'New' })).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
  });
  it('checks current task scope and membership before even an exact receipt replay', async () => {
    const test = setup(); await test.app.createComment(ctx, id(4), { body: 'Original' });
    test.setTarget(null); test.order.length = 0;
    await expect(test.app.createComment(ctx, id(4), { body: 'Original' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(test.order).toEqual(['access', 'target']);
    test.setAccess(null); test.order.length = 0;
    await expect(test.app.createComment(ctx, id(4), { body: 'Original' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(test.order).toEqual(['access']);
  });
  it('rejects a reused key with a different body or target and malformed input without inserts', async () => {
    const test = setup(); await test.app.createComment(ctx, id(4), { body: 'Original' });
    await expect(test.app.createComment(ctx, id(4), { body: 'Changed' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(test.app.createComment(ctx, id(7), { body: 'Original' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    for (const idempotencyKey of ['', 'has space', '\n']) await expect(test.app.createComment({ ...ctx, idempotencyKey }, id(4), { body: 'valid' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(test.app.createComment(ctx, id(4), { body: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(test.repo.insertComment).toHaveBeenCalledTimes(1);
  });
  it('allows viewer reads and denies viewer writes, and denies a hidden target before a bad cursor', async () => {
    const test = setup(); test.setAccess({ ...test.getAccess(), membership: { ...test.getAccess().membership, role: 'viewer' } });
    expect(await test.app.listComments(ctx, id(4), {})).toEqual({ items: [], nextCursor: null });
    await expect(test.app.createComment(ctx, id(4), { body: 'No' })).rejects.toMatchObject({ code: 'CAPABILITY_REQUIRED' });
    test.setTarget(null);
    await expect(test.app.listActivity(ctx, id(4), { cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(test.tools.decodeCursor).not.toHaveBeenCalled();
  });
  it('bounds pages and binds comment cursors to every identity/query dimension and feed kind', async () => {
    const test = setup(); const row = await test.app.createComment(ctx, id(4), { body: 'One' });
    test.comments.push({ ...row, id: id(7) });
    const page = await test.app.listComments(ctx, id(4), { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(test.repo.listComments).toHaveBeenLastCalledWith(id(1), id(4), null, 2);
    const cursor = JSON.parse(page.nextCursor as string) as Record<string, unknown>;
    for (const [key, value] of Object.entries({ kind: 'task-activity', version: 2, workspaceId: id(99), taskId: id(99), actorUserId: id(99), membershipId: id(99), permissionEpoch: '4', limit: 2 })) await expect(test.app.listComments(ctx, id(4), { limit: 1, cursor: JSON.stringify({ ...cursor, [key]: value }) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await test.app.listComments(ctx, id(4), { limit: 1, cursor: page.nextCursor as string });
    expect(test.repo.listComments).toHaveBeenLastCalledWith(id(1), id(4), { createdAt: row.createdAt, id: row.id }, 2);
  });
  it('bounds activity pages and uses commit sequence plus ordinal for continuation', async () => {
    const test = setup();
    const row: TaskActivityDto = { id: id(8), workspaceId: id(1), taskId: id(4), kind: 'schedule_updated', actorUserId: id(2), actorMembershipId: id(3), actorDisplayName: 'Current label', occurredAt: time, changeSeq: '9007199254740993', eventOrdinal: 2 };
    test.activities.push(row, { ...row, id: id(9), eventOrdinal: 1 });
    const page = await test.app.listActivity(ctx, id(4), { limit: 1 });
    expect(page.items).toEqual([row]);
    await test.app.listActivity(ctx, id(4), { limit: 1, cursor: page.nextCursor as string });
    expect(test.repo.listActivity).toHaveBeenLastCalledWith(id(1), id(4), { changeSeq: row.changeSeq, eventOrdinal: 2 }, 2);
  });
  describe('unified timeline', () => {
    const activity = (n: number, changeSeq: string, eventOrdinal: number): TaskTimelineItemDto => ({ type: 'activity', id: id(n), workspaceId: id(1), taskId: id(4), changeSeq, eventOrdinal, occurredAt: time, kind: 'updated', actorUserId: id(2), actorMembershipId: id(3), actorDisplayName: 'Current label', detail: 'uncaptured', changes: [] }) as TaskTimelineItemDto;
    it('pages one keyset with limit + 1 and a task-timeline cursor bound to seq/ordinal text', async () => {
      const test = setup(); test.timeline.push(activity(20, '9007199254740993', 2), activity(21, '9007199254740993', 1));
      const page = await test.app.listTimeline(ctx, id(4), { limit: 1 });
      expect(page.items.map(item => item.id)).toEqual([id(20)]);
      expect(test.repo.listTimeline).toHaveBeenLastCalledWith(id(1), id(4), null, 2);
      const cursor = JSON.parse(page.nextCursor as string) as Record<string, unknown>;
      expect(cursor).toEqual({ version: 1, kind: 'task-timeline', workspaceId: id(1), taskId: id(4), actorUserId: id(2), membershipId: id(3), permissionEpoch: '3', limit: 1, changeSeq: '9007199254740993', eventOrdinal: 2 });
      await test.app.listTimeline(ctx, id(4), { limit: 1, cursor: page.nextCursor as string });
      expect(test.repo.listTimeline).toHaveBeenLastCalledWith(id(1), id(4), { changeSeq: '9007199254740993', eventOrdinal: 2 }, 2);
      test.timeline.length = 1;
      expect((await test.app.listTimeline(ctx, id(4), { limit: 1 })).nextCursor).toBeNull();
    });
    it('rejects any cross-actor/task/workspace/membership/epoch/limit/kind cursor', async () => {
      const test = setup(); test.timeline.push(activity(20, '5', 2), activity(21, '5', 1));
      const cursor = JSON.parse((await test.app.listTimeline(ctx, id(4), { limit: 1 })).nextCursor as string) as Record<string, unknown>;
      for (const [key, value] of Object.entries({ kind: 'task-activity', version: 2, workspaceId: id(99), taskId: id(99), actorUserId: id(99), membershipId: id(99), permissionEpoch: '4', limit: 2 })) await expect(test.app.listTimeline(ctx, id(4), { limit: 1, cursor: JSON.stringify({ ...cursor, [key]: value }) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // A timeline cursor is not accepted by the old feeds either.
      await expect(test.app.listActivity(ctx, id(4), { limit: 1, cursor: JSON.stringify(cursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(test.app.listTimeline(ctx, id(4), { limit: 1, unknown: 'x' } as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
    it('denies revoked access and hidden targets before decoding a cursor', async () => {
      const test = setup(); test.setTarget(null);
      await expect(test.app.listTimeline(ctx, id(4), { cursor: 'stolen' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      test.setTarget({ id: id(4), projectId: id(5), visibility: 'workspace', archivedAt: null, projectArchivedAt: null }); test.setAccess(null);
      await expect(test.app.listTimeline(ctx, id(4), { cursor: 'stolen' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(test.tools.decodeCursor).not.toHaveBeenCalled(); expect(test.repo.listTimeline).not.toHaveBeenCalled();
    });
    it('adds a trusted HTTPS avatar only when membership carries one; receipts without it replay with no key', async () => {
      const plain = setup(), first = await plain.app.createComment(ctx, id(4), { body: 'Old' });
      expect(Object.hasOwn(first, 'authorAvatarUrl')).toBe(false);
      expect(Object.hasOwn(await plain.app.createComment(ctx, id(4), { body: 'Old' }), 'authorAvatarUrl')).toBe(false);
      const withAvatar = setup(); withAvatar.setAccess({ ...withAvatar.getAccess(), membership: { ...withAvatar.getAccess().membership, avatarUrl: 'https://cdn.example.com/a.png' } as never });
      expect((await withAvatar.app.createComment(ctx, id(4), { body: 'New' })).authorAvatarUrl).toBe('https://cdn.example.com/a.png');
      const unsafe = setup(); unsafe.setAccess({ ...unsafe.getAccess(), membership: { ...unsafe.getAccess().membership, avatarUrl: 'http://user:pw@evil.test/a.png' } as never });
      expect((await unsafe.app.createComment(ctx, id(4), { body: 'New' })).authorAvatarUrl).toBeNull();
    });
  });
});
