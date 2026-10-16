// Real PostgreSQL + source Fastify + real MCP facade. Only this file's freshly created
// disposable child is migrated/seeded/dropped; no DATABASE_URL fallback or shared-runtime use.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { localMcpSecretPreimage, type TaskDto, type TaskListQuery } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createTaskApplication, createLocalCredentialApplication, createLocalMcpApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { tasks, workPackages } from '../../packages/db/src/schema.js';
import { createTaskCursorCodec } from '../../packages/db/src/tasks/cursor.js';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';

requireTestDatabaseUrl();
const secret = 'synthetic-due-sort-stable-cursor-secret';
const context = (userId: string = U.owner, workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic due sort', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: randomUUID() });
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected due-sort fixture/cursor.');
  return value;
}
const ids = (rows: readonly TaskDto[]) => rows.map(row => row.id);
const compareDue = (left: Pick<TaskDto, 'dueDate' | 'id'>, right: Pick<TaskDto, 'dueDate' | 'id'>): number =>
  (left.dueDate === right.dueDate ? 0 : left.dueDate === null ? 1 : right.dueDate === null ? -1 : left.dueDate < right.dueDate ? -1 : 1) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

async function digest(db: Database): Promise<Record<string, string>> {
  const tables = await db.sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`;
  const result: Record<string, string> = {};
  for (const { table_name: table } of tables) {
    // Only identifier-quoted catalog table names; no caller-controlled SQL.
    const [row] = await db.sql.unsafe<{ digest: string }[]>(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as digest from "${table.replaceAll('"', '""')}" t`);
    result[table] = required(row).digest;
  }
  return result;
}

describe('server task due sorting on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  let app: TaskApplication;
  let api: FastifyInstance;
  let projectId: string, statusId: string, doneId: string, sectionId: string, tagId: string, otherTagId: string, foreignTagId: string;
  let undated: TaskDto, dated: TaskDto, tie: TaskDto, early: TaskDto, child: TaskDto, plainParent: TaskDto, removed: TaskDto, archived: TaskDto;
  let all: TaskDto[], bulkProjectId: string;
  let bulk: { id: string; dueDate: string | null }[];
  let bearer: string;
  const query = (extra: Partial<TaskListQuery> = {}): TaskListQuery => ({ projectId, sort: 'due_asc', limit: 50, ...extra });
  const list = (extra: Partial<TaskListQuery> = {}) => app.listTasks(context(), query(extra));

  async function exhaust(q: TaskListQuery): Promise<TaskDto[]> {
    const found: TaskDto[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 300; page += 1) {
      const result = await app.listTasks(context(), { ...q, ...(cursor ? { cursor } : {}) });
      expect(result.items.length).toBeLessThanOrEqual(q.limit);
      found.push(...result.items);
      if (!result.nextCursor) return found;
      expect(result.items).toHaveLength(q.limit);
      cursor = result.nextCursor;
    }
    throw new Error('Task pagination did not terminate.');
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase('task_due_sort');
    console.info(`DUE_SORT_OWNED_DB=${target.name}`);
    db = createDatabase(target.url, { requireLoopback: true });
    const existing = await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`;
    if (existing.length) throw new Error('Refusing to migrate/seed a nonempty due-sort child database.');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
    app = createTaskApplication(db, { cursorSecret: secret });
    projectId = (await app.createProject(context(), { name: 'Due sort project' })).id;
    const statuses = await app.listStatuses(context(), projectId);
    statusId = required(statuses.find(row => row.group === 'todo')).id;
    doneId = required(statuses.find(row => row.group === 'done')).id;
    sectionId = (await app.createSection(context(), projectId, { name: 'Due section' })).id;
    tagId = (await app.createTag(context(), { name: 'Due filter' })).id;
    otherTagId = (await app.createTag(context(), { name: 'Due other' })).id;
    foreignTagId = (await app.createTag(context(U.outsider, W.outside), { name: 'Outside due tag' })).id;
    const create = (input: Partial<Parameters<TaskApplication['createTask']>[1]>) => app.createTask(context(), { projectId, statusId, title: 'Due needle', ...input });
    // Deliberately put the earliest dates beyond the first manually ordered page.
    undated = await create({ title: 'Undated needle', tagIds: [tagId, otherTagId], sectionId, participantMembershipIds: [M.teamViewer] });
    dated = await create({ dueDate: '2026-10-20', tagIds: [tagId, otherTagId], sectionId, participantMembershipIds: [M.teamViewer], estimateMinutes: 120 });
    tie = await create({ dueDate: '2026-10-20', tagIds: [tagId], sectionId, participantMembershipIds: [M.teamViewer] });
    early = await create({ title: 'Early needle %_\\', dueDate: '0001-01-01', tagIds: [tagId], sectionId, participantMembershipIds: [M.teamViewer] });
    plainParent = await create({ title: 'Untagged parent', dueDate: '9999-12-31' });
    child = await create({ title: 'Tagged child', parentTaskId: plainParent.id, dueDate: '2026-10-18', tagIds: [tagId], statusId: doneId });
    await create({ title: 'Untagged detail of tagged task', parentTaskId: dated.id, dueDate: '2026-10-19' });
    const beforeRemoval = await create({ title: 'Removed needle', dueDate: '2026-10-21', tagIds: [tagId], sectionId, participantMembershipIds: [M.teamViewer] });
    removed = await app.updateTask(context(), beforeRemoval.id, { expectedRevision: beforeRemoval.revision, expectedParticipantsRevision: beforeRemoval.participantsRevision, participantMembershipIds: [] });
    await create({ title: 'Other undated', tagIds: [otherTagId] });
    const beforeArchive = await create({ title: 'Archived needle', dueDate: '0001-01-02', tagIds: [tagId] });
    archived = await app.archiveTask(context(), beforeArchive.id, { expectedRevision: beforeArchive.revision });
    all = await exhaust({ projectId, limit: 200 });

    bulkProjectId = (await app.createProject(context(), { name: 'Due sort bulk' })).id;
    const bulkStatus = required((await app.listStatuses(context(), bulkProjectId)).find(row => row.group === 'todo')).id;
    bulk = Array.from({ length: 205 }, (_, n) => ({ id: `da000000-0000-4000-8000-${String(n).padStart(12, '0')}`, dueDate: n < 102 ? null : n < 150 ? '9999-12-31' : n < 200 ? '2026-10-20' : '0001-01-01' }));
    // Direct fixture insertion is restricted to the empty owned child, never application state.
    await db.db.insert(workPackages).values(bulk.map(row => ({ id: row.id, workspaceId: W.team, projectId: bulkProjectId, origin: 'new_task' as const })));
    await db.db.insert(tasks).values(bulk.map((row, position) => ({ ...row, workspaceId: W.team, projectId: bulkProjectId, workPackageId: row.id, title: `Bulk ${position}`, statusId: bulkStatus, position })));
    const outsideProject = (await app.createProject(context(U.outsider, W.outside), { name: 'Outside due project' })).id;
    const outsideStatus = required((await app.listStatuses(context(U.outsider, W.outside), outsideProject)).find(row => row.group === 'todo')).id;
    await app.createTask(context(U.outsider, W.outside), { projectId: outsideProject, statusId: outsideStatus, title: 'Outside early task', dueDate: '0001-01-01' });
    const material = randomBytes(32), credentialId = randomUUID();
    await createLocalCredentialApplication(db).issueCredential(context(), { id: credentialId, name: 'Due sort read proof', hashVersion: 1, secretHash: createHash('sha256').update(localMcpSecretPreimage(credentialId, material)).digest('hex'), scopes: ['tasks.read'], expiresInSeconds: 3600 });
    bearer = `wlm_local_v1_${credentialId}.${material.toString('base64url')}`;
    api = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: U.owner, DATABASE_URL: target.url }), { database: db, taskApplication: app, webDistDir: null, logger: false });
  }, 60_000);
  afterAll(async () => {
    try { await api?.close(); }
    finally { try { await db?.close(); } finally { await target?.drop(); } }
  });

  it('sorts the entire project before paging through date ties and null boundaries', async () => {
    const expected = [...all].sort(compareDue);
    expect((await list({ limit: 1 })).items[0]?.id).toBe(early.id);
    expect(all[0]?.id).toBe(undated.id);
    for (const limit of [1, 2, 200]) expect(ids(await exhaust(query({ limit })))).toEqual(ids(expected));
    expect(ids(await exhaust(query({ includeArchived: true, limit: 2 })))).toEqual(ids([...all, archived].sort(compareDue)));
    expect(ids(expected)).toContain(plainParent.id);
  });

  it('returns every one of 205 tasks exactly once at all accepted page sizes', async () => {
    const expected = [...bulk].sort(compareDue).map(row => row.id);
    for (const limit of [1, 2, 200]) {
      const found = ids(await exhaust({ projectId: bulkProjectId, sort: 'due_asc', limit }));
      expect(found).toEqual(expected);
      expect(new Set(found).size).toBe(205);
    }
  });

  it('intersects filters without tag inheritance, duplicate joins or inactive participants', async () => {
    const active = [early, dated, tie, undated].sort(compareDue);
    expect(ids((await list({ tagId, sectionId, statusId, participantMembershipId: M.teamViewer, search: 'needle' })).items)).toEqual(ids(active));
    expect(ids((await list({ tagId, statusId: doneId })).items)).toEqual([child.id]);
    expect(ids((await list({ tagId, search: 'Removed', participantMembershipId: M.teamViewer })).items)).toEqual([]);
    for (const search of ['%', '_', '\\']) expect(ids((await list({ search })).items)).toEqual([early.id]);
    const tagged = (await list({ tagId })).items;
    expect(ids(tagged)).not.toContain(plainParent.id);
    expect(ids(tagged)).not.toContain(all.find(row => row.title === 'Untagged detail of tagged task')?.id);
    expect(new Set(ids(tagged)).size).toBe(tagged.length);
    expect(tagged.find(row => row.id === dated.id)?.estimateMinutes).toBe(120);
    expect(ids(tagged)).toContain(removed.id);
  });

  it('rejects cross-sort, query, actor, workspace, permission and version cursor reuse', async () => {
    const first = await list({ limit: 1 });
    const cursor = required(first.nextCursor);
    const manual = await app.listTasks(context(), { projectId, limit: 1 });
    for (const extra of [{ sort: 'manual' as const }, { limit: 2 }, { projectId: bulkProjectId }, { tagId }, { sectionId }, { statusId }, { participantMembershipId: M.teamViewer }, { search: 'needle' }, { includeArchived: true }]) {
      await expect(list({ limit: 1, cursor, ...extra })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(app.listTasks(context(), { projectId, limit: 1, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(list({ limit: 1, cursor: required(manual.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app.listTasks(context(U.viewer), query({ limit: 1, cursor }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app.listTasks(context(U.outsider, W.outside), query({ limit: 1, cursor }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const codec = createTaskCursorCodec({ secret });
    const payload = codec.decode(cursor);
    await expect(list({ limit: 1, cursor: codec.encode({ ...payload, permissionEpoch: '999999999999' }) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(list({ limit: 1, cursor: codec.encode({ ...payload, workspaceId: W.outside }) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('checks current access and owned filter scope before decoding an invalid due cursor', async () => {
    await expect(list({ tagId: foreignTagId, cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(list({ projectId: randomUUID(), cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await db.sql`update memberships set state='revoked', revoked_at=now() where id=${M.teamViewer}`;
    try { await expect(app.listTasks(context(U.viewer), query({ cursor: 'bad' }))).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    finally { await db.sql`update memberships set state='active', revoked_at=null where id=${M.teamViewer}`; }
  });

  it('preserves the literal legacy hash and accepts v1 cursors in omitted/manual mode', async () => {
    const omitted = { projectId, limit: 1 };
    const first = await app.listTasks(context(), omitted);
    const explicit = await app.listTasks(context(), { ...omitted, sort: 'manual' });
    const codec = createTaskCursorCodec({ secret, now: () => Date.UTC(2026, 9, 16, 12) });
    const payload = createTaskCursorCodec({ secret }).decode(required(first.nextCursor));
    const legacyHash = createHash('sha256').update(`{"limit":1,"projectId":"${projectId}"}`).digest('hex');
    expect(payload).toMatchObject({ version: 1, queryHash: legacyHash, position: all[0]?.position, id: undated.id });
    const explicitPayload = createTaskCursorCodec({ secret }).decode(required(explicit.nextCursor));
    expect(explicitPayload).toEqual(payload);
    // Fixed clock makes exact byte comparisons independent of per-read expiry time.
    expect(codec.encode(explicitPayload)).toBe(codec.encode(payload));
    for (const sort of [undefined, 'manual'] as const) {
      expect(ids((await app.listTasks(context(), { ...omitted, ...(sort ? { sort } : {}), cursor: required(first.nextCursor) })).items)).toEqual([all[1]?.id]);
    }
  });

  it('uses due order through actual HTTP and real authorized MCP facade without writes', async () => {
    const before = await digest(db);
    const url = `/api/v1/workspaces/${W.team}/tasks?projectId=${projectId}&sort=due_asc&limit=1`;
    const response = await api.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4310' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: TaskDto) => row.id)).toEqual([early.id]);
    const next = await api.inject({ method: 'GET', url: `${url}&cursor=${encodeURIComponent(required(response.json().meta.nextCursor))}`, headers: { host: '127.0.0.1:4310' } });
    expect(next.statusCode).toBe(200);
    expect(next.json().data.map((row: TaskDto) => row.id)).toEqual([child.id]);
    for (const suffix of ['sort=due_desc', 'sort=due_asc&sort=manual']) expect((await api.inject({ method: 'GET', url: `/api/v1/workspaces/${W.team}/tasks?projectId=${projectId}&${suffix}`, headers: { host: '127.0.0.1:4310' } })).statusCode).toBe(400);
    const mcp = createLocalMcpApplication(db, { cursorSecret: secret });
    const search = (q: TaskListQuery) => mcp.callTool(bearer, randomUUID(), { tool: 'search_tasks', input: { query: q } });
    const first = await search(query({ limit: 1 }));
    if (first.tool !== 'search_tasks') throw new Error('Expected MCP search result.');
    expect(ids(first.data)).toEqual([early.id]);
    const continuation = await search(query({ limit: 1, cursor: required(first.nextCursor) }));
    expect(continuation.data).toMatchObject([{ id: child.id }]);
    await expect(search({ projectId, limit: 1, cursor: required(first.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(search(query({ tagId: foreignTagId }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await digest(db)).toEqual(before);
  });
});
