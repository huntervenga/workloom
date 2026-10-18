import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notFoundError, type TaskCommentsApplication } from '@workloom/domain';
import type { TaskCommentDto, TaskTimelineItemDto } from '@workloom/contracts';
import { registerTaskCommentsRoutes } from './task-comments-routes.js';
import { mapError } from './errors.js';
const id = (n: number) => `ac000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { userId: id(2), displayName: 'Trusted actor', kind: 'fixture' as const };
const row: TaskCommentDto = { id: id(6), workspaceId: id(1), taskId: id(4), authorUserId: id(2), authorMembershipId: id(3), authorDisplayNameSnapshot: 'Trusted author', createdAt: '2026-10-16T00:00:00.000Z', body: '  <b>Text</b>\r\n  ' };
const timelineItem: TaskTimelineItemDto = { type: 'comment', id: row.id, workspaceId: id(1), taskId: id(4), changeSeq: '7', eventOrdinal: 1, occurredAt: row.createdAt, comment: row } as TaskTimelineItemDto;
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function harness() {
  const app = Fastify(); apps.push(app);
  app.setErrorHandler((error, _request, reply) => { const mapped = mapError(error); return reply.code(mapped.statusCode).send(mapped.body); });
  const comments = { createComment: vi.fn<TaskCommentsApplication['createComment']>(async () => row), listComments: vi.fn<TaskCommentsApplication['listComments']>(async () => ({ items: [row], nextCursor: null })), listActivity: vi.fn<TaskCommentsApplication['listActivity']>(async () => ({ items: [], nextCursor: 'opaque-next' })), listTimeline: vi.fn<TaskCommentsApplication['listTimeline']>(async () => ({ items: [timelineItem], nextCursor: 'timeline-next' })) };
  registerTaskCommentsRoutes(app, { identity: { mode: 'dev', resolveActor: async () => actor }, comments });
  await app.ready(); return { app, comments };
}
const path = `/api/v1/workspaces/${id(1)}/tasks/${id(4)}`;
describe('comments and safe activity HTTP adapter', () => {
  it('passes trusted canonical actor/task and exact plaintext with the operation key', async () => {
    const { app, comments } = await harness();
    const reply = await app.inject({ method: 'POST', url: path.toUpperCase().replace('/API/V1/WORKSPACES/', '/api/v1/workspaces/').replace('/TASKS/', '/tasks/') + '/comments', headers: { 'idempotency-key': 'same-command-key' }, payload: { body: row.body } });
    expect(reply.statusCode).toBe(201); expect(reply.json()).toMatchObject({ data: row });
    expect(comments.createComment).toHaveBeenCalledWith(expect.objectContaining({ actor, workspaceId: id(1), idempotencyKey: 'same-command-key', source: 'web' }), id(4), { body: row.body });
  });
  it('returns explicit pagination metadata for both authorized feeds', async () => {
    const { app, comments } = await harness();
    const reply = await app.inject(`${path}/comments?limit=1&cursor=opaque%2Bcursor`);
    expect(reply.statusCode).toBe(200); expect(reply.json()).toMatchObject({ data: [row], meta: { nextCursor: null } });
    expect(comments.listComments).toHaveBeenCalledWith(expect.objectContaining({ actor }), id(4), { limit: 1, cursor: 'opaque+cursor' });
    expect((await app.inject(`${path}/activity`)).json()).toMatchObject({ data: [], meta: { nextCursor: 'opaque-next' } });
  });
  it('rejects spoofed author/time/body and unbounded/arbitrary query input before the service', async () => {
    const { app, comments } = await harness();
    for (const payload of [{ body: 'Valid', authorUserId: id(9) }, { body: 'Valid', createdAt: row.createdAt }, { body: '   ' }, { body: '\0' }, { body: 'a'.repeat(4001) }]) expect((await app.inject({ method: 'POST', url: `${path}/comments`, headers: { 'idempotency-key': 'key' }, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${path}/comments`, payload: { body: 'Valid' } })).statusCode).toBe(400);
    for (const query of ['limit=101', 'actorUserId=x', 'sort=title']) expect((await app.inject(`${path}/activity?${query}`)).statusCode).toBe(400);
    expect(comments.createComment).not.toHaveBeenCalled(); expect(comments.listActivity).not.toHaveBeenCalled();
  });
  it('serves the unified timeline with the actual actor, strict query and envelope', async () => {
    const { app, comments } = await harness();
    const reply = await app.inject(`${path}/timeline?limit=1&cursor=opaque%2Bcursor`);
    expect(reply.statusCode).toBe(200); expect(reply.json()).toMatchObject({ data: [timelineItem], meta: { nextCursor: 'timeline-next' } });
    expect(comments.listTimeline).toHaveBeenCalledWith(expect.objectContaining({ actor, workspaceId: id(1), source: 'web' }), id(4), { limit: 1, cursor: 'opaque+cursor' });
    for (const query of ['limit=101', 'limit=0', 'limit=1&limit=2', 'cursor=a&cursor=b', 'actorUserId=x', 'kind=comment', `cursor=${'a'.repeat(2049)}`]) expect((await app.inject(`${path}/timeline?${query}`)).statusCode).toBe(400);
    expect(comments.listTimeline).toHaveBeenCalledTimes(1);
  });
  it('maps timeline denial without a 500 and never serves an item outside the response contract', async () => {
    const { app, comments } = await harness(); comments.listTimeline.mockRejectedValueOnce(notFoundError());
    expect((await app.inject(`${path}/timeline?cursor=previous`)).statusCode).toBe(404);
    comments.listTimeline.mockResolvedValueOnce({ items: [{ ...timelineItem, reason: 'secret raw reason' } as never], nextCursor: null });
    const leaked = await app.inject(`${path}/timeline`);
    expect(leaked.body).not.toContain('secret raw reason');
  });
  it('keeps missing/revoked denial and exposes no comment edit/delete operation', async () => {
    const { app, comments } = await harness(); comments.listComments.mockRejectedValue(notFoundError());
    expect((await app.inject(`${path}/comments?cursor=previous`)).statusCode).toBe(404);
    for (const method of ['PATCH', 'DELETE'] as const) expect((await app.inject({ method, url: `${path}/comments/${row.id}`, payload: { body: 'changed' } })).statusCode).toBe(404);
  });
});
