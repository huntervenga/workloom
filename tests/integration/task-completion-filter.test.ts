// Source-backed Fastify/domain/PostgreSQL/MCP acceptance for the optional task-list completion
// filter. The shared integration helper creates and drops this file's own child database; the
// validated TEST_DATABASE_URL base is untouched and no DATABASE_URL fallback is used.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { localMcpSecretPreimage, type TaskDto, type TaskListQuery, type TaskStatusGroup } from '@workloom/contracts';
import type { CommandContext, TaskApplication } from '@workloom/domain';
import { createDatabase, createTaskApplication, createLocalCredentialApplication, createLocalMcpApplication, runMigrations, seedDemoData, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W, FIXTURE_MEMBERSHIP_IDS as M, type Database } from '@workloom/db';
import { tasks, taskStatuses, workPackages } from '../../packages/db/src/schema.js';
import { createTaskCursorCodec } from '../../packages/db/src/tasks/cursor.js';
import { createApp } from '../../apps/api/src/app.js';
import { loadConfig } from '../../apps/api/src/config.js';
import { requireTestDatabaseUrl } from './support/test-database-url.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from './support/test-database.js';

requireTestDatabaseUrl();
const secret = 'synthetic-completion-filter-stable-cursor-secret';
const context = (userId: string = U.owner, workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Synthetic completion test', kind: 'fixture' }, requestId: randomUUID(), source: 'web', idempotencyKey: randomUUID() });
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Expected completion fixture/cursor value.');
  return value;
}
// Typed independently of the contract so this gate stays RED (strict schema rejection) until the field exists.
type CompletionQuery = TaskListQuery & { completion?: 'open' };
const OPEN = { completion: 'open' } as const;
const OPEN_GROUPS: ReadonlySet<TaskStatusGroup> = new Set(['todo', 'in_progress']);
const ids = (rows: readonly Pick<TaskDto, 'id'>[]) => rows.map(row => row.id);
const compareDue = (left: Pick<TaskDto, 'dueDate' | 'id'>, right: Pick<TaskDto, 'dueDate' | 'id'>): number =>
  (left.dueDate === right.dueDate ? 0 : left.dueDate === null ? 1 : right.dueDate === null ? -1 : left.dueDate < right.dueDate ? -1 : 1) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const legacyHash = (literal: string) => createHash('sha256').update(literal).digest('hex');

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

describe('server task completion=open filter on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase | undefined;
  let db: Database;
  let app: TaskApplication;
  let api: FastifyInstance;
  let bearer: string;
  let projectId: string, sectionId: string, tagId: string, otherTagId: string, foreignTagId: string;
  let todoId: string, progressId: string, doneId: string, cancelledId: string;
  // Custom statuses in every group prove the server correlates groups, never default names/IDs.
  let backlogId: string, reviewId: string, shippedId: string, wontId: string;
  let groupOf: Map<string, TaskStatusGroup>;
  let openA: TaskDto, doneA: TaskDto, progressA: TaskDto, cancelledA: TaskDto, backlogA: TaskDto, shippedA: TaskDto, reviewA: TaskDto, wontA: TaskDto;
  let openChild: TaskDto, doneChild: TaskDto, removed: TaskDto, archivedOpen: TaskDto, archivedDone: TaskDto;
  let all: TaskDto[];
  let bulkProjectId: string;
  let bulk: { id: string; dueDate: string | null; statusId: string; open: boolean; position: number }[];
  const query = (extra: Partial<CompletionQuery> = {}): CompletionQuery => ({ projectId, limit: 50, ...extra });
  const list = (extra: Partial<CompletionQuery> = {}, ctx: CommandContext = context()) => app.listTasks(ctx, query(extra) as TaskListQuery);
  const isOpen = (row: TaskDto) => OPEN_GROUPS.has(required(groupOf.get(row.statusId)));

  async function exhaust(q: CompletionQuery): Promise<TaskDto[]> {
    const found: TaskDto[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 400; page += 1) {
      const result = await app.listTasks(context(), { ...q, ...(cursor ? { cursor } : {}) } as TaskListQuery);
      // A non-final page is always full: filtering happens in SQL before LIMIT+1, not after.
      expect(result.items.length).toBeLessThanOrEqual(q.limit);
      found.push(...result.items);
      if (!result.nextCursor) return found;
      expect(result.items).toHaveLength(q.limit);
      cursor = result.nextCursor;
    }
    throw new Error('Completion pagination did not terminate.');
  }

  async function customStatus(project: string, name: string, group: TaskStatusGroup, position: number): Promise<string> {
    const id = randomUUID();
    // Direct fixture insertion is restricted to the empty owned child; no public status writer exists.
    await db.db.insert(taskStatuses).values({ id, workspaceId: W.team, projectId: project, name, group, position });
    return id;
  }

  beforeAll(async () => {
    target = await createThrowawayDatabase('task_completion_filter');
    console.info(`COMPLETION_FILTER_OWNED_DB=${target.name}`);
    db = createDatabase(target.url, { requireLoopback: true });
    const existing = await db.sql`select 1 from information_schema.tables where table_schema='public' limit 1`;
    if (existing.length) throw new Error('Refusing to migrate/seed a nonempty completion-filter child database.');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(db);
    app = createTaskApplication(db, { cursorSecret: secret });
    projectId = (await app.createProject(context(), { name: 'Completion project' })).id;
    const defaults = await app.listStatuses(context(), projectId);
    const byGroup = (group: TaskStatusGroup) => required(defaults.find(row => row.group === group)).id;
    todoId = byGroup('todo'); progressId = byGroup('in_progress'); doneId = byGroup('done'); cancelledId = byGroup('cancelled');
    backlogId = await customStatus(projectId, 'Backlog', 'todo', 4);
    reviewId = await customStatus(projectId, 'Review', 'in_progress', 5);
    shippedId = await customStatus(projectId, 'Shipped', 'done', 6);
    wontId = await customStatus(projectId, "Won't do", 'cancelled', 7);
    const statuses = await app.listStatuses(context(), projectId);
    groupOf = new Map(statuses.map(row => [row.id, row.group]));
    expect(statuses).toHaveLength(8);
    sectionId = (await app.createSection(context(), projectId, { name: 'Completion section' })).id;
    tagId = (await app.createTag(context(), { name: 'Completion filter' })).id;
    otherTagId = (await app.createTag(context(), { name: 'Completion other' })).id;
    foreignTagId = (await app.createTag(context(U.outsider, W.outside), { name: 'Outside completion tag' })).id;
    const create = (input: Partial<Parameters<TaskApplication['createTask']>[1]>) => app.createTask(context(), { projectId, statusId: todoId, title: 'Completion needle', ...input });
    const scoped = { tagIds: [tagId], sectionId, participantMembershipIds: [M.teamViewer] };
    // Closed rows interleave every open row in both manual and due order, including ties and nulls.
    openA = await create({ title: 'Open needle', ...scoped, tagIds: [tagId, otherTagId], estimateMinutes: 120 });
    doneA = await create({ title: 'Done needle', dueDate: '2026-10-01', ...scoped, statusId: doneId });
    progressA = await create({ title: 'Progress needle', dueDate: '2026-10-20', ...scoped, statusId: progressId });
    cancelledA = await create({ title: 'Cancelled needle', dueDate: '0001-01-01', ...scoped, statusId: cancelledId });
    backlogA = await create({ title: 'Backlog needle %_\\', dueDate: '2026-10-20', ...scoped, statusId: backlogId });
    shippedA = await create({ title: 'Shipped needle', ...scoped, statusId: shippedId });
    reviewA = await create({ title: 'Review needle', dueDate: '9999-12-31', ...scoped, statusId: reviewId });
    wontA = await create({ title: 'Wont needle', dueDate: '2026-10-20', ...scoped, statusId: wontId });
    // Hierarchy never inherits completion: an open child of a closed parent appears alone.
    openChild = await create({ title: 'Open child needle', parentTaskId: doneA.id, dueDate: '2026-10-19', tagIds: [tagId] });
    doneChild = await create({ title: 'Done child needle', parentTaskId: openA.id, dueDate: '2026-10-02', tagIds: [tagId], statusId: shippedId });
    const beforeRemoval = await create({ title: 'Removed needle', dueDate: '2026-10-21', ...scoped, statusId: reviewId });
    removed = await app.updateTask(context(), beforeRemoval.id, { expectedRevision: beforeRemoval.revision, expectedParticipantsRevision: beforeRemoval.participantsRevision, participantMembershipIds: [] });
    const beforeArchiveOpen = await create({ title: 'Archived open needle', dueDate: '0001-01-02', tagIds: [tagId], statusId: backlogId });
    archivedOpen = await app.archiveTask(context(), beforeArchiveOpen.id, { expectedRevision: beforeArchiveOpen.revision });
    const beforeArchiveDone = await create({ title: 'Archived done needle', tagIds: [tagId], statusId: doneId });
    archivedDone = await app.archiveTask(context(), beforeArchiveDone.id, { expectedRevision: beforeArchiveDone.revision });
    all = await exhaust({ projectId, limit: 200 });

    bulkProjectId = (await app.createProject(context(), { name: 'Completion bulk' })).id;
    const bulkDefaults = await app.listStatuses(context(), bulkProjectId);
    const bulkTodo = required(bulkDefaults.find(row => row.group === 'todo')).id;
    const bulkDone = required(bulkDefaults.find(row => row.group === 'done')).id;
    const bulkCancelled = required(bulkDefaults.find(row => row.group === 'cancelled')).id;
    const bulkReview = await customStatus(bulkProjectId, 'Bulk review', 'in_progress', 4);
    // The first 150 manual positions are closed, so post-LIMIT client-style filtering would return empty pages.
    bulk = Array.from({ length: 420 }, (_, n) => {
      const open = n >= 150 && n % 4 !== 1;
      const statusId = open ? (n % 2 ? bulkReview : bulkTodo) : n % 2 ? bulkCancelled : bulkDone;
      const dueDate = n % 3 === 0 ? null : n % 3 === 1 ? '2026-10-20' : n % 7 === 0 ? '0001-01-01' : '9999-12-31';
      return { id: `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, dueDate, statusId, open, position: n };
    });
    await db.db.insert(workPackages).values(bulk.map(row => ({ id: row.id, workspaceId: W.team, projectId: bulkProjectId, origin: 'new_task' as const })));
    await db.db.insert(tasks).values(bulk.map(row => ({ id: row.id, dueDate: row.dueDate, statusId: row.statusId, position: row.position, workspaceId: W.team, projectId: bulkProjectId, workPackageId: row.id, title: `Bulk ${row.position}` })));

    const material = randomBytes(32), credentialId = randomUUID();
    await createLocalCredentialApplication(db).issueCredential(context(), { id: credentialId, name: 'Completion read proof', hashVersion: 1, secretHash: createHash('sha256').update(localMcpSecretPreimage(credentialId, material)).digest('hex'), scopes: ['tasks.read'], expiresInSeconds: 3600 });
    bearer = `wlm_local_v1_${credentialId}.${material.toString('base64url')}`;
    api = await createApp(loadConfig({ APP_ENV: 'local', AUTH_MODE: 'dev', DEV_ACTOR_ID: U.owner, DATABASE_URL: target.url }), { database: db, taskApplication: app, webDistDir: null, logger: false });
  }, 60_000);
  afterAll(async () => {
    try { await api?.close(); }
    finally { try { await db?.close(); } finally { await target?.drop(); } }
  });

  it('keeps absent completion as ALL tasks and returns only todo/in_progress groups, custom statuses included, for open', async () => {
    const manualAll = [openA, doneA, progressA, cancelledA, backlogA, shippedA, reviewA, wontA, openChild, doneChild, removed];
    expect(ids(all)).toEqual(ids(manualAll));
    const open = await list(OPEN);
    expect(ids(open.items)).toEqual([openA.id, progressA.id, backlogA.id, reviewA.id, openChild.id, removed.id]);
    expect(ids(open.items)).toEqual(ids(all.filter(isOpen)));
    expect(open.items.every(isOpen)).toBe(true);
    for (const closed of [doneA, cancelledA, shippedA, wontA, doneChild]) expect(ids(open.items)).not.toContain(closed.id);
    expect(open.nextCursor).toBeNull();
    expect(new Set(ids(open.items)).size).toBe(6);
    expect(open.items.find(row => row.id === openA.id)?.estimateMinutes).toBe(120);
    expect(ids((await list({ ...OPEN, includeArchived: true })).items)).toEqual([...ids(open.items), archivedOpen.id]);
    expect(ids((await list({ includeArchived: true })).items)).toEqual([...ids(all), archivedOpen.id, archivedDone.id]);
  });

  it('pages open tasks once at limit 1 and 2 in manual and due order through ties, nulls and interleaved closed rows', async () => {
    const openRows = all.filter(isOpen);
    for (const limit of [1, 2]) {
      expect(ids(await exhaust(query({ ...OPEN, limit })))).toEqual(ids(openRows));
      expect(ids(await exhaust(query({ ...OPEN, sort: 'manual', limit })))).toEqual(ids(openRows));
      expect(ids(await exhaust(query({ ...OPEN, sort: 'due_asc', limit })))).toEqual(ids([...openRows].sort(compareDue)));
    }
    const due = await exhaust(query({ ...OPEN, sort: 'due_asc', limit: 2 }));
    expect(due.map(row => row.dueDate)).toEqual([...openRows].sort(compareDue).map(row => row.dueDate));
    expect(ids(due).at(-1)).toBe(openA.id);
    // Unfiltered due order still includes the earliest closed row first.
    expect((await list({ sort: 'due_asc', limit: 1 })).items[0]?.id).toBe(cancelledA.id);
    expect(ids((await list({ ...OPEN, sort: 'due_asc', limit: 3 })).items)).toEqual([openChild.id, ...ids([backlogA, progressA].sort(compareDue))]);
  });

  it('returns every one of 203 open bulk tasks exactly once behind 150 closed leading rows', async () => {
    const openBulk = bulk.filter(row => row.open);
    expect(openBulk).toHaveLength(203);
    const manual = openBulk.map(row => row.id);
    const due = [...openBulk].sort(compareDue).map(row => row.id);
    for (const limit of [2, 200]) {
      const foundManual = ids(await exhaust({ projectId: bulkProjectId, ...OPEN, limit }));
      expect(foundManual).toEqual(manual);
      expect(new Set(foundManual).size).toBe(203);
      const foundDue = ids(await exhaust({ projectId: bulkProjectId, ...OPEN, sort: 'due_asc', limit }));
      expect(foundDue).toEqual(due);
      expect(new Set(foundDue).size).toBe(203);
    }
    const first = await app.listTasks(context(), { projectId: bulkProjectId, ...OPEN, limit: 1 } as TaskListQuery);
    expect(ids(first.items)).toEqual([required(manual[0])]);
    expect(ids((await app.listTasks(context(), { projectId: bulkProjectId, limit: 1 })).items)).toEqual([required(bulk[0]).id]);
  });

  it('ANDs completion with exact status, tag, section, participant, search and archive filters', async () => {
    expect(ids((await list({ ...OPEN, statusId: backlogId })).items)).toEqual([backlogA.id]);
    expect(ids((await list({ ...OPEN, statusId: reviewId })).items)).toEqual([reviewA.id, removed.id]);
    expect(ids((await list({ ...OPEN, statusId: progressId })).items)).toEqual([progressA.id]);
    for (const statusId of [doneId, cancelledId, shippedId, wontId]) {
      expect(ids((await list({ statusId })).items).length).toBeGreaterThan(0);
      expect(ids((await list({ ...OPEN, statusId })).items)).toEqual([]);
    }
    expect(ids((await list({ ...OPEN, tagId, sectionId, participantMembershipId: M.teamViewer, search: 'needle' })).items)).toEqual([openA.id, progressA.id, backlogA.id, reviewA.id]);
    expect(ids((await list({ ...OPEN, tagId: otherTagId })).items)).toEqual([openA.id]);
    expect(ids((await list({ ...OPEN, tagId })).items)).toEqual([openA.id, progressA.id, backlogA.id, reviewA.id, openChild.id, removed.id]);
    expect(ids((await list({ ...OPEN, search: 'Removed', participantMembershipId: M.teamViewer })).items)).toEqual([]);
    expect(ids((await list({ ...OPEN, search: 'Removed' })).items)).toEqual([removed.id]);
    expect(ids((await list({ ...OPEN, search: 'Done' })).items)).toEqual([]);
    for (const search of ['%', '_', '\\']) expect(ids((await list({ ...OPEN, search })).items)).toEqual([backlogA.id]);
    expect(ids((await list({ ...OPEN, statusId: backlogId, includeArchived: true })).items)).toEqual([backlogA.id, archivedOpen.id]);
    expect(ids((await list({ ...OPEN, statusId: doneId, includeArchived: true })).items)).toEqual([]);
    expect(ids((await list({ ...OPEN, sort: 'due_asc', statusId: reviewId, tagId, limit: 1 })).items)).toEqual([removed.id]);
  });

  it('continues only the same completion query and rejects cross-filter, cross-sort and legacy cursor reuse', async () => {
    const first = await list({ ...OPEN, limit: 1 });
    expect(ids(first.items)).toEqual([openA.id]);
    const cursor = required(first.nextCursor);
    expect(ids((await list({ ...OPEN, limit: 1, cursor })).items)).toEqual([progressA.id]);
    await expect(list({ limit: 1, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    for (const extra of [{ sort: 'due_asc' as const }, { sort: 'manual' as const }, { limit: 2 }, { tagId }, { statusId: backlogId }, { sectionId }, { participantMembershipId: M.teamViewer }, { search: 'needle' }, { includeArchived: true }]) {
      if (!('sort' in extra && extra.sort === 'manual')) await expect(list({ ...OPEN, limit: 1, cursor, ...extra })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(list({ limit: 1, cursor, ...extra })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    // Explicit manual is the same binding as omitted sort for the open filter too.
    expect(ids((await list({ ...OPEN, sort: 'manual', limit: 1, cursor })).items)).toEqual([progressA.id]);
    const unfiltered = await list({ limit: 1 });
    await expect(list({ ...OPEN, limit: 1, cursor: required(unfiltered.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const dueOpen = await list({ ...OPEN, sort: 'due_asc', limit: 1 });
    const dueNext = await list({ ...OPEN, sort: 'due_asc', limit: 1, cursor: required(dueOpen.nextCursor) });
    expect(ids([...dueOpen.items, ...dueNext.items])).toEqual(ids(all.filter(isOpen).sort(compareDue).slice(0, 2)));
    await expect(list({ ...OPEN, limit: 1, cursor: required(dueOpen.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(list({ sort: 'due_asc', limit: 1, cursor: required(dueOpen.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const unfilteredDue = await list({ sort: 'due_asc', limit: 1 });
    await expect(list({ ...OPEN, sort: 'due_asc', limit: 1, cursor: required(unfilteredDue.nextCursor) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(list({ ...OPEN, limit: 1, cursor }, context(U.viewer))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(list({ ...OPEN, limit: 1, cursor }, context(U.outsider, W.outside))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const codec = createTaskCursorCodec({ secret });
    const payload = codec.decode(cursor);
    expect(payload.version).toBe(1);
    expect(payload.queryHash).not.toBe(legacyHash(`{"limit":1,"projectId":"${projectId}"}`));
    await expect(list({ ...OPEN, limit: 1, cursor: codec.encode({ ...payload, permissionEpoch: '999999999999' }) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('preserves literal legacy v1 manual and v2 due hashes and old cursors when completion is absent', async () => {
    const codec = createTaskCursorCodec({ secret });
    const fixed = createTaskCursorCodec({ secret, now: () => Date.UTC(2026, 9, 17, 12) });
    const omitted = { projectId, limit: 1 };
    const manual = await app.listTasks(context(), omitted);
    const manualPayload = codec.decode(required(manual.nextCursor));
    expect(manualPayload).toMatchObject({ version: 1, queryHash: legacyHash(`{"limit":1,"projectId":"${projectId}"}`), position: openA.position, id: openA.id });
    const explicitManual = await app.listTasks(context(), { ...omitted, sort: 'manual' });
    expect(fixed.encode(codec.decode(required(explicitManual.nextCursor)))).toBe(fixed.encode(manualPayload));
    const legacyManual = codec.encode({ ...manualPayload });
    for (const sort of [undefined, 'manual'] as const) {
      expect(ids((await app.listTasks(context(), { ...omitted, ...(sort ? { sort } : {}), cursor: legacyManual })).items)).toEqual([doneA.id]);
    }
    const due = await app.listTasks(context(), { ...omitted, sort: 'due_asc' });
    const duePayload = codec.decode(required(due.nextCursor));
    const dueAll = [...all].sort(compareDue);
    expect(duePayload).toMatchObject({ version: 2, queryHash: legacyHash(`{"limit":1,"projectId":"${projectId}","sort":"due_asc"}`), dueDate: required(dueAll[0]).dueDate, id: required(dueAll[0]).id });
    expect(ids((await app.listTasks(context(), { ...omitted, sort: 'due_asc', cursor: codec.encode({ ...duePayload }) })).items)).toEqual([required(dueAll[1]).id]);
    // Old hashes stay bound to ALL: they never continue an open-filtered read.
    await expect(list({ ...OPEN, limit: 1, cursor: legacyManual })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('checks current access and owned filter scope before decoding an invalid completion cursor', async () => {
    await expect(list({ ...OPEN, tagId: foreignTagId, cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(list({ ...OPEN, projectId: randomUUID(), cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(list({ ...OPEN, statusId: randomUUID(), cursor: 'bad' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(list({ ...OPEN, cursor: 'bad' }, context(U.outsider))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(list({ ...OPEN, cursor: 'bad' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await db.sql`update memberships set state='revoked', revoked_at=now() where id=${M.teamViewer}`;
    try { await expect(list({ ...OPEN, sort: 'due_asc', cursor: 'bad' }, context(U.viewer))).rejects.toMatchObject({ code: 'NOT_FOUND' }); }
    finally { await db.sql`update memberships set state='active', revoked_at=null where id=${M.teamViewer}`; }
    for (const completion of ['all', 'closed', 'done', 'OPEN', '', null, true]) {
      await expect(list({ completion: completion as 'open' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('forwards completion through real HTTP parsing and rejects unknown, repeated or invalid values without writes', async () => {
    const before = await digest(db);
    const get = (suffix: string) => api.inject({ method: 'GET', url: `/api/v1/workspaces/${W.team}/tasks?projectId=${projectId}&${suffix}`, headers: { host: '127.0.0.1:4310' } });
    const first = await get('completion=open&limit=1');
    expect(first.statusCode).toBe(200);
    expect(first.json().data.map((row: TaskDto) => row.id)).toEqual([openA.id]);
    const next = await get(`completion=open&limit=1&cursor=${encodeURIComponent(required(first.json().meta.nextCursor))}`);
    expect(next.statusCode).toBe(200);
    expect(next.json().data.map((row: TaskDto) => row.id)).toEqual([progressA.id]);
    const allRows = await get('limit=200');
    expect(allRows.statusCode).toBe(200);
    expect(allRows.json().data.map((row: TaskDto) => row.id)).toEqual(ids(all));
    const due = await get(`completion=open&sort=due_asc&statusId=${reviewId}&limit=200`);
    expect(due.statusCode).toBe(200);
    expect(due.json().data.map((row: TaskDto) => row.id)).toEqual(ids([reviewA, removed].sort(compareDue)));
    for (const suffix of ['completion=all', 'completion=closed', 'completion=done', 'completion=OPEN', 'completion=', 'completion=open&completion=open', 'completion=open&completion=all', 'completion[]=open', 'completions=open', 'completed=false']) {
      expect((await get(suffix)).statusCode, suffix).toBe(400);
    }
    const unfilteredCursor = required((await get('limit=1')).json().meta.nextCursor as string | null);
    expect((await get(`completion=open&limit=1&cursor=${encodeURIComponent(unfilteredCursor)}`)).statusCode).toBe(400);
    expect(await digest(db)).toEqual(before);
  });

  it('uses the same completion filter, pagination and legacy unfiltered contract through the real MCP facade', async () => {
    const before = await digest(db);
    const mcp = createLocalMcpApplication(db, { cursorSecret: secret });
    const search = (q: CompletionQuery) => mcp.callTool(bearer, randomUUID(), { tool: 'search_tasks', input: { query: q as TaskListQuery } });
    const first = await search(query({ ...OPEN, limit: 1 }));
    if (first.tool !== 'search_tasks') throw new Error('Expected MCP search result.');
    expect(ids(first.data)).toEqual([openA.id]);
    const next = await search(query({ ...OPEN, limit: 1, cursor: required(first.nextCursor) }));
    expect(next.data).toMatchObject([{ id: progressA.id }]);
    await expect(search(query({ limit: 1, cursor: required(first.nextCursor) }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const exact = await search(query({ ...OPEN, statusId: backlogId, tagId }));
    if (exact.tool !== 'search_tasks') throw new Error('Expected MCP search result.');
    expect(ids(exact.data)).toEqual([backlogA.id]);
    const old = await search(query({ limit: 1 }));
    expect(old.data).toMatchObject([{ id: openA.id }]);
    const oldAll = await search(query({ limit: 200 }));
    if (oldAll.tool !== 'search_tasks') throw new Error('Expected MCP search result.');
    expect(ids(oldAll.data)).toEqual(ids(all));
    for (const completion of ['all', 'closed']) await expect(search(query({ completion: completion as 'open' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(search(query({ ...OPEN, tagId: foreignTagId }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await digest(db)).toEqual(before);
  });
});
