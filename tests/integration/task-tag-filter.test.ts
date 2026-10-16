// Source-backed Fastify/domain/PostgreSQL acceptance. The shared integration helper creates
// and drops this file's own child database; the validated TEST_DATABASE_URL base is untouched.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { localMcpSecretPreimage, type TagDto, type TaskDto, type TaskListQuery } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createTaskApplication, createTaskRepository, createLocalCredentialApplication, createLocalMcpApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { createTaskCursorCodec } from '../../packages/db/src/tasks/cursor.js';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';

// Fail collection for missing/unsafe explicit test configuration, never DATABASE_URL fallback.
requireTestDatabaseUrl();
const secret = 'synthetic-tag-filter-stable-cursor-secret';
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected fixture/cursor value.');
  return value;
}
const context = (userId: string = U.owner, workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic tag test', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: randomUUID() });

describe('exact single-tag reads on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  let api: FastifyInstance;
  let app: TaskApplication;
  let projectId: string, statusId: string, doneId: string, sectionId: string;
  let tag: TagDto, other: TagDto, archived: TagDto, foreign: TagDto;
  let root: TaskDto, taggedDetail: TaskDto, plainParent: TaskDto, taggedOnlyChild: TaskDto, removed: TaskDto, archivedTask: TaskDto;
  let bearer: string;
  const query = (extra: Partial<TaskListQuery> = {}): TaskListQuery => ({ projectId, limit: 50, ...extra });
  const ids = (items: readonly TaskDto[]) => items.map(row => row.id);
  const list = (extra: Partial<TaskListQuery> = {}) => app.listTasks(context(), query({ tagId: tag.id, ...extra }));

  beforeAll(async () => {
    target = await createThrowawayDatabase('task_tag_filter');
    console.info(`TAG_FILTER_OWNED_DB=${target.name}`);
    db = createDatabase(target.url, { requireLoopback: true });
    // The newly created owned child must be empty; never seed existing data.
    const existing = await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`;
    if (existing.length) throw new Error('Refusing to migrate/seed a nonempty tag-filter test database.');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
    app = createTaskApplication(db, { cursorSecret: secret });
    projectId = (await app.createProject(context(), { name: 'Exact tag project' })).id;
    const statuses = await app.listStatuses(context(), projectId);
    statusId = required(statuses.find(row => row.group === 'todo')).id;
    doneId = required(statuses.find(row => row.group === 'done')).id;
    sectionId = (await app.createSection(context(), projectId, { name: 'Tagged section' })).id;
    tag = await app.createTag(context(), { name: 'Filter exact tag' });
    other = await app.createTag(context(), { name: 'Second tag' });
    archived = await app.createTag(context(), { name: 'Archived tag' });
    foreign = await app.createTag(context(U.outsider, W.outside), { name: 'Outside tag' });
    const create = (input: Partial<Parameters<TaskApplication['createTask']>[1]>) => app.createTask(context(), { projectId, statusId, title: 'Tagged needle', ...input });
    root = await create({ tagIds: [tag.id, other.id, archived.id], participantMembershipIds: [M.teamOwner, M.teamViewer], sectionId, estimateMinutes: 120 });
    await create({ title: 'Untagged detail', parentTaskId: root.id });
    taggedDetail = await create({ parentTaskId: root.id, tagIds: [tag.id, other.id], participantMembershipIds: [M.teamOwner, M.teamViewer], sectionId });
    plainParent = await create({ title: 'Untagged parent' });
    taggedOnlyChild = await create({ parentTaskId: plainParent.id, tagIds: [tag.id], statusId: doneId });
    const beforeRemoval = await create({ title: 'Removed participant needle', tagIds: [tag.id], participantMembershipIds: [M.teamViewer], sectionId });
    removed = await app.updateTask(context(), beforeRemoval.id, { expectedRevision: beforeRemoval.revision, expectedParticipantsRevision: beforeRemoval.participantsRevision, participantMembershipIds: [] });
    const beforeArchive = await create({ title: 'Archived task needle', tagIds: [tag.id] });
    archivedTask = await app.archiveTask(context(), beforeArchive.id, { expectedRevision: beforeArchive.revision });
    await app.updateTag(context(), archived.id, { expectedRevision: 1, archived: true });
    const material = randomBytes(32), credentialId = randomUUID();
    await createLocalCredentialApplication(db).issueCredential(context(), { id: credentialId, name: 'Tag read proof', hashVersion: 1, secretHash: createHash('sha256').update(localMcpSecretPreimage(credentialId, material)).digest('hex'), scopes: ['tasks.read'], expiresInSeconds: 3600 });
    bearer = `wlm_local_v1_${credentialId}.${material.toString('base64url')}`;
    api = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: U.owner, DATABASE_URL: target.url }), { database: db, taskApplication: app, webDistDir: null, logger: false });
  }, 60_000);
  afterAll(async () => {
    try { await api?.close(); }
    finally {
      try { await db?.close(); }
      finally { await target?.drop(); }
    }
  });

  it('filters only own tags, includes matching children alone, and never multiplies task/package estimates', async () => {
    const page = await list();
    expect(ids(page.items)).toEqual([root.id, taggedDetail.id, taggedOnlyChild.id, removed.id]);
    expect(ids(page.items)).not.toContain(plainParent.id);
    expect(new Set(ids(page.items)).size).toBe(page.items.length);
    const packages = new Map(page.items.map(row => [row.workPackageId, row.estimateMinutes ?? 0]));
    expect(packages.get(root.workPackageId)).toBe(120);
    expect([...packages.values()].reduce((sum, minutes) => sum + minutes, 0)).toBe(120);
    expect((await list({ includeArchived: true })).items.map(row => row.id)).toContain(archivedTask.id);
  });

  it('intersects tag/status/section/search/active-participant filters and preserves literal search', async () => {
    expect(ids((await list({ statusId, sectionId, search: 'needle', participantMembershipId: M.teamViewer })).items)).toEqual([root.id, taggedDetail.id]);
    expect(ids((await list({ statusId: doneId })).items)).toEqual([taggedOnlyChild.id]);
    expect(ids((await list({ search: 'Removed', participantMembershipId: M.teamViewer })).items)).toEqual([]);
    expect(ids((await list({ search: '%' })).items)).toEqual([]);
    expect(ids((await list({ search: '_' })).items)).toEqual([]);
    expect(ids((await list({ search: '\\' })).items)).toEqual([]);
  });

  it('paginates tagged tasks once and rejects cross-tag/untagged cursor reuse', async () => {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ limit: 1, ...(cursor ? { cursor } : {}) });
      found.push(...ids(page.items)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found).toEqual([root.id, taggedDetail.id, taggedOnlyChild.id, removed.id]);
    const first = await list({ limit: 1 });
    await expect(list({ tagId: other.id, limit: 1, cursor: required(first.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app.listTasks(context(), query({ limit: 1, cursor: required(first.nextCursor) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('reads archived owned tags and rejects missing/foreign tags before decoding a cursor', async () => {
    expect(ids((await list({ tagId: archived.id })).items)).toEqual([root.id]);
    for (const tagId of [foreign.id, randomUUID()]) await expect(list({ tagId, cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app.listTasks(context(U.outsider), query({ tagId: tag.id, cursor: 'bad' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(list({ projectId: randomUUID(), cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reauthorizes a revoked current membership before cursor decoding', async () => {
    await db.sql`update memberships set state='revoked', revoked_at=now() where id=${M.teamViewer}`;
    try { await expect(app.listTasks(context(U.viewer), query({ tagId: tag.id, cursor: 'bad' }))).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    finally { await db.sql`update memberships set state='active', revoked_at=null where id=${M.teamViewer}`; }
  });

  it('preserves literal pre-filter v1 hash/envelope and accepts the old signed cursor', async () => {
    const page = await app.listTasks(context(), query({ limit: 1 }));
    const codec = createTaskCursorCodec({ secret });
    const payload = codec.decode(required(page.nextCursor));
    const queryHash = createHash('sha256').update(`{"limit":1,"projectId":"${projectId}"}`).digest('hex');
    expect(payload).toMatchObject({ version: 1, queryHash, position: root.position, id: root.id });
    const legacy = codec.encode({ ...payload, queryHash });
    const next = await app.listTasks(context(), query({ limit: 1, cursor: legacy }));
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(root.id);
  });

  it('forwards the filter through real HTTP parsing and defensive repository UUID checks', async () => {
    const response = await api.inject({ method: 'GET', url: `/api/v1/workspaces/${W.team}/tasks?projectId=${projectId}&tagId=${tag.id}&limit=1`, headers: { host: '127.0.0.1:4310' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: TaskDto) => row.id)).toEqual([root.id]);
    for (const suffix of [`tagId=${tag.id}&tagId=${other.id}`, 'tagId=nope', `tagIds=${tag.id}`, 'sort=title']) {
      expect((await api.inject({ method: 'GET', url: `/api/v1/workspaces/${W.team}/tasks?projectId=${projectId}&${suffix}`, headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(400);
    }
    expect(await createTaskRepository(db).listTasks(W.team, query({ tagId: 'nope' }), null, 10)).toEqual([]);
  });

  it('uses the same tag filter, pagination and legacy unfiltered contract through the real MCP facade', async () => {
    const mcp = createLocalMcpApplication(db, { cursorSecret: secret });
    const search = (q: TaskListQuery) => mcp.callTool(bearer, randomUUID(), { tool: 'search_tasks', input: { query: q } });
    const first = await search(query({ tagId: tag.id, limit: 1 }));
    expect(first.tool).toBe('search_tasks');
    if (first.tool !== 'search_tasks') throw new Error('Expected search result.');
    expect(ids(first.data)).toEqual([root.id]);
    const next = await search(query({ tagId: tag.id, limit: 1, cursor: required(first.nextCursor) }));
    expect(next.data).toMatchObject([{ id: taggedDetail.id }]);
    await expect(search(query({ tagId: other.id, limit: 1, cursor: required(first.nextCursor) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const old = await search(query({ limit: 1 }));
    expect(old.data).toMatchObject([{ id: root.id }]);
    await expect(search(query({ tagId: foreign.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
