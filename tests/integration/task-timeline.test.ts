import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTaskFieldInputSchema, createPlanningPeriodInputSchema, setManualPeriodWorkInputSchema, taskTimelineItemSchema, type TaskFieldData, type TaskTimelineItemDto } from '@workloom/contracts';
import type { CommandContext } from '@workloom/domain';
import { FIXTURE_MEMBERSHIP_IDS as M, FIXTURE_USER_IDS as U, FIXTURE_WORKSPACE_IDS as W } from '../../packages/db/src/fixtures.js';
import { runMigrations } from '../../packages/db/src/migrations.js';
import { seedDemoData } from '../../packages/db/src/seed/demo-seed.js';
import { createTaskApplication } from '../../packages/db/src/tasks/task-application.js';
import { createTaskFieldApplication } from '../../packages/db/src/fields/task-field-application.js';
import { createPlanningApplication } from '../../packages/db/src/planning/planning-application.js';
import { createDependencyApplication } from '../../packages/db/src/dependencies/dependency-application.js';
import { createTaskCommentsApplication } from '../../packages/db/src/task-comments/application.js';
import { createThrowawayDatabase, type ThrowawayDatabase } from '../../packages/db/integration/support.js';
// Fresh fully-migrated database: no pre-comment upgrade replay is needed for the timeline read path.
const context = (userId: string = U.owner, key = randomUUID(), workspaceId: string = W.team): CommandContext => ({ workspaceId, actor: { userId, displayName: 'Untrusted context label', kind: 'fixture' }, source: 'web', requestId: 'timeline-pg', idempotencyKey: key });
const secret = 'synthetic-task-timeline-cursor-key-thirty-two-bytes';
interface Emit { entityType: string; entityId: string; action: string; diff: Record<string, unknown>; reason?: string }

describe('unified task timeline on owned disposable PostgreSQL', () => {
  let target: ThrowawayDatabase, projectId: string, taskId: string, otherTaskId: string, statusId: string;
  const app = () => createTaskCommentsApplication(target.database, { secret });
  const all = async (limit: number, ctx = context(), id = taskId) => {
    const seen: TaskTimelineItemDto[] = []; let cursor: string | undefined;
    do { const page = await app().listTimeline(ctx, id, { limit, ...(cursor ? { cursor } : {}) }); seen.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
    return seen;
  };
  /** Synthetic legacy/foreign-shape audit rows sharing one commit sequence, in ordinal order. */
  async function emit(rows: readonly Emit[]): Promise<string> {
    return target.database.sql.begin(async sql => {
      const [seq] = await sql<{ change_seq: string }[]>`update workspaces set change_seq = change_seq + 1 where id = ${W.team} returning change_seq::text`;
      if (!seq) throw new Error('Synthetic workspace missing.');
      for (const [index, row] of rows.entries()) await sql`insert into audit_events (workspace_id, change_seq, event_ordinal, actor_user_id, actor_membership_id, source, request_id, entity_type, entity_id, action, diff, reason, recorded_at) values (${W.team}, ${seq.change_seq}::bigint, ${index + 1}, ${U.owner}, ${M.teamOwner}, 'web', 'timeline-pg', ${row.entityType}, ${row.entityId}, ${row.action}, ${JSON.stringify(row.diff)}::jsonb, ${row.reason ?? null}, now())`;
      return seq.change_seq;
    });
  }
  beforeAll(async () => {
    target = await createThrowawayDatabase('timeline');
    await runMigrations(target.url, { requireLoopback: true });
    await seedDemoData(target.database);
    const tasks = createTaskApplication(target.database), owner = context(U.owner);
    projectId = (await tasks.createProject(owner, { name: 'Synthetic timeline project' })).id;
    const status = (await tasks.listStatuses(owner, projectId)).find(row => row.group === 'todo'); if (!status) throw new Error('Synthetic todo required.'); statusId = status.id;
    taskId = (await tasks.createTask(context(U.owner), { projectId, statusId, title: 'Timeline task' })).id;
    otherTaskId = (await tasks.createTask(context(U.owner), { projectId, statusId, title: 'Other end' })).id;
  }, 60_000);
  afterAll(async () => { await target?.drop(); });

  it('never publishes raw diff/reason/unknown keys; legacy builtin labels stay uncaptured without the current name', async () => {
    await emit([{ entityType: 'task', entityId: taskId, action: 'updated', reason: 'SECRET-REASON', diff: { statusId: { from: statusId, to: statusId }, injected: 'SECRET-KEY', revision: { from: 1, to: 2 }, title: { from: 'Old <b>', to: 'Timeline task' } } }]);
    const items = await all(100), json = JSON.stringify(items);
    for (const leak of ['SECRET-REASON', 'SECRET-KEY', 'timeline-pg', '"diff"', '"source"']) expect(json).not.toContain(leak);
    items.forEach(item => expect(taskTimelineItemSchema.safeParse(item).success).toBe(true));
    const update = items.find(item => item.type === 'activity' && item.changes.some(change => change.field === 'status'));
    expect(update).toMatchObject({ detail: 'partial', changes: expect.arrayContaining([{ field: 'status', from: { id: statusId, name: null, availability: 'uncaptured' }, to: { id: statusId, name: null, availability: 'uncaptured' } }, { field: 'title', from: 'Old <b>', to: 'Timeline task' }]) });
  });

  it('keeps a v1 snapshot name after a rename (no imposter current label)', async () => {
    await emit([{ entityType: 'task', entityId: taskId, action: 'updated', diff: { statusId: { from: statusId, to: statusId }, activity: { v: 1, status: { from: { id: statusId, name: 'Then todo', group: 'todo' }, to: { id: statusId, name: 'Then todo', group: 'todo' } } } } }]);
    const [latest] = (await app().listTimeline(context(), taskId, { limit: 1 })).items;
    expect(latest).toMatchObject({ detail: 'exact', changes: [{ field: 'status', to: { name: 'Then todo', availability: 'snapshot', group: 'todo' } }] });
  });

  it('labels a field write as redacted (foreign/missing field), opted_out (explicit flag) or uncaptured (legacy) with no values', async () => {
    await emit([
      { entityType: 'task_field_value', entityId: taskId, action: 'updated', diff: { taskId, fieldId: randomUUID(), type: 'text', historyCaptured: false, value: 'SECRET-VALUE' } },
      { entityType: 'task_field_value', entityId: taskId, action: 'updated', diff: { taskId, fieldId: 'not-a-uuid', type: 'text' } },
    ]);
    const page = (await app().listTimeline(context(), taskId, { limit: 2 })).items;
    expect(JSON.stringify(page)).not.toContain('SECRET-VALUE');
    for (const item of page) expect(item).toMatchObject({ kind: 'field_value', changes: [{ field: 'custom', fieldId: null, availability: 'redacted' }] });
  });

  it('shows a dependency with the other end current title and op from the audit action', async () => {
    const edge = randomUUID(), now = new Date().toISOString();
    await target.database.sql`insert into task_dependencies (id, workspace_id, predecessor_task_id, successor_task_id, type, state, revision, created_at, updated_at) values (${edge}, ${W.team}, ${taskId}, ${otherTaskId}, 'finish_to_start', 'removed', 2, ${now}::timestamptz, ${now}::timestamptz)`;
    await emit([{ entityType: 'task_dependency', entityId: edge, action: 'created', diff: {} }]);
    await emit([{ entityType: 'task_dependency', entityId: edge, action: 'removed', diff: {} }]);
    const [removed, added] = (await app().listTimeline(context(), taskId, { limit: 2 })).items;
    expect(removed).toMatchObject({ kind: 'dependency', changes: [{ op: 'removed', direction: 'blocks', other: { id: otherTaskId, title: 'Other end', availability: 'current' } }] });
    expect(added).toMatchObject({ changes: [{ op: 'added' }] });
  });

  it('pages interleaved comments and same-TX action ties exactly once in (seq, ordinal) DESC with limit 1, then 101 rows with limit 100', async () => {
    const comment = await app().createComment(context(), taskId, { body: 'Tie comment' });
    const tiedCommentId = randomUUID();
    const tieSeq = await target.database.sql.begin(async sql => {
      const [head] = await sql<{ seq: string }[]>`update workspaces set change_seq=change_seq+1 where id=${W.team} returning change_seq::text as seq`;
      if (!head) throw new Error('Synthetic workspace missing.');
      await sql`insert into task_comments(id,workspace_id,task_id,author_user_id,author_membership_id,author_display_name_snapshot,created_at,body) values(${tiedCommentId},${W.team},${taskId},${U.owner},${M.teamOwner},'Synthetic tied author',now(),'Comment between tied actions')`;
      for (const [index, row] of [
        { type: 'task', id: taskId, action: 'updated', diff: {} },
        { type: 'task_comment', id: tiedCommentId, action: 'created', diff: { taskId } },
        { type: 'task_field_value', id: taskId, action: 'updated', diff: { taskId, fieldId: randomUUID() } },
      ].entries()) await sql`insert into audit_events(workspace_id,change_seq,event_ordinal,actor_user_id,actor_membership_id,source,request_id,entity_type,entity_id,action,diff,recorded_at) values(${W.team},${head.seq}::bigint,${index+1},${U.owner},${M.teamOwner},'web','synthetic-tied-branches',${row.type},${row.id},${row.action},${JSON.stringify(row.diff)}::jsonb,now())`;
      return head.seq;
    });
    const items = await all(1), keys = items.map(item => `${item.changeSeq}:${item.eventOrdinal}`);
    expect(new Set(keys).size).toBe(keys.length);
    const sorted = [...items].sort((a, b) => (BigInt(b.changeSeq) > BigInt(a.changeSeq) ? 1 : BigInt(b.changeSeq) < BigInt(a.changeSeq) ? -1 : b.eventOrdinal - a.eventOrdinal));
    expect(items).toEqual(sorted);
    expect(items.filter(item => item.type === 'comment' && item.comment.id === comment.id)).toHaveLength(1);
    expect(items.filter(item => item.changeSeq === tieSeq).map(item => [item.type, item.eventOrdinal])).toEqual([['activity', 3], ['comment', 2], ['activity', 1]]);
    expect(items.filter(item => item.type === 'comment' && item.comment.id === tiedCommentId)).toHaveLength(1);
    const before = items.length;
    const added = 205;
    await emit(Array.from({ length: added }, () => ({ entityType: 'task', entityId: taskId, action: 'updated', diff: {} })));
    const total = (await all(100)).length, first = await app().listTimeline(context(), taskId, { limit: 100 });
    expect(first.items).toHaveLength(100); expect(first.nextCursor).not.toBeNull();
    expect(total).toBe(before + added);
    expect(new Set((await all(100)).map(item => item.id)).size).toBe(total);
    let last = first; while (last.nextCursor) last = await app().listTimeline(context(), taskId, { limit: 100, cursor: last.nextCursor });
    expect(last.nextCursor).toBeNull();
  });

  it('denies cross actor/task/workspace/kind/epoch cursors, and a hidden task before decode', async () => {
    const page = await app().listTimeline(context(), taskId, { limit: 1 }), cursor = page.nextCursor as string;
    await expect(app().listTimeline(context(U.memberA), taskId, { limit: 1, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app().listTimeline(context(), otherTaskId, { limit: 1, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app().listTimeline(context(U.outsider, randomUUID(), W.outside), taskId, { limit: 1, cursor })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(app().listTimeline(context(), taskId, { limit: 2, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app().listActivity(context(), taskId, { limit: 1, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(app().listTimeline(context(), randomUUID(), { limit: 1, cursor: 'not-even-a-token' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await target.database.sql`update workspaces set permission_epoch = permission_epoch + 1 where id = ${W.team}`;
    await expect(app().listTimeline(context(), taskId, { limit: 1, cursor })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('replays a comment without a duplicate row/audit and keeps an avatar-less receipt key-exact', async () => {
    const key = randomUUID(), first = await app().createComment(context(U.owner, key), taskId, { body: 'Once' });
    await target.database.sql`update command_idempotency set result = result - 'authorAvatarUrl' where idempotency_key = ${key}`;
    const legacy = { ...first }; delete legacy.authorAvatarUrl;
    const replay = await app().createComment(context(U.owner, key), taskId, { body: 'Once' });
    expect(replay).toEqual(legacy); expect(Object.hasOwn(replay, 'authorAvatarUrl')).toBe(false);
    const [count] = await target.database.sql<{ count: string }[]>`select count(*)::text as count from audit_events where entity_type = 'task_comment' and entity_id = ${first.id}`;
    expect(count?.count).toBe('1');
  });

  const changes = (items: TaskTimelineItemDto[]) => items.flatMap(item => item.type === 'activity' ? item.changes : []);
  async function fresh(title: string, parentTaskId?: string) {
    return createTaskApplication(target.database).createTask(context(), { projectId, statusId, title, ...(parentTaskId ? { parentTaskId } : {}) });
  }
  async function snapshot() {
    const sql = target.database.sql, tables = await sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by table_name`;
    const rows: Record<string, unknown> = {};
    for (const { table_name: table } of tables) {
      const [row] = await sql`select count(*)::text as count, md5(coalesce(jsonb_agg(to_jsonb(x.*) order by to_jsonb(x.*)::text),'[]'::jsonb)::text) as digest from ${sql(table)} x`;
      if (!row) throw new Error('Snapshot aggregation missing.'); rows[table] = row;
    }
    return rows;
  }

  it('records actual builtin status/complete/reopen/assignee/dates/estimate/tags with snapshots and exact replay', async () => {
    const tasks = createTaskApplication(target.database), task = await fresh('Actual builtin history');
    const done = (await tasks.listStatuses(context(), projectId)).find(row => row.group === 'done');
    if (!done) throw new Error('Done status missing.');
    const tag = await tasks.createTag(context(), { name: 'Historical tag', color: null });
    const key = randomUUID(), input = { expectedRevision: task.revision, statusId: done.id, responsibleMembershipId: M.teamMemberA, startDate: '2090-01-02', dueDate: '2090-01-03', priority: 'high' as const, estimateMinutes: 125, expectedWorkPackageRevision: task.workPackageRevision, tagIds: [tag.id] };
    const updated = await tasks.updateTask(context(U.owner, key), task.id, input);
    const committed = await snapshot();
    expect(await tasks.updateTask(context(U.owner, key), task.id, input)).toEqual(updated);
    expect(await snapshot()).toEqual(committed);
    const values = changes(await all(100, context(), task.id));
    expect(values).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'status', from: expect.objectContaining({ id: statusId, group: 'todo', availability: 'snapshot' }), to: expect.objectContaining({ id: done.id, group: 'done', name: done.name, availability: 'snapshot' }) }),
      expect.objectContaining({ field: 'responsible', to: expect.objectContaining({ id: M.teamMemberA, availability: 'snapshot' }) }),
      { field: 'startDate', from: null, to: '2090-01-02' },
      { field: 'dueDate', from: null, to: '2090-01-03' },
      { field: 'estimate', from: null, to: 125 },
      expect.objectContaining({ field: 'tags', added: [expect.objectContaining({ id: tag.id, name: tag.name, availability: 'snapshot' })] }),
    ]));
    await tasks.updateTask(context(), task.id, { expectedRevision: updated.revision, statusId });
    expect(changes(await all(100, context(), task.id))).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'status', from: expect.objectContaining({ group: 'done' }), to: expect.objectContaining({ group: 'todo' }) })]));
  });

  it('captures all nine typed custom fields, preserving historical definitions and absent/null/zero after opt-out', async () => {
    const fields = createTaskFieldApplication(target.database), task = await fresh('Nine typed values');
    const kinds = ['text','number','duration','date','single_select','multi_select','person','boolean','url'] as const;
    for (const type of kinds) {
      const field = await fields.createField(context(), createTaskFieldInputSchema.parse({ projectId, name: `Then ${type}`, type, options: type.includes('select') ? [{ name: 'Option then' }] : [] }));
      const option = field.options[0]?.id;
      const raw = { text: 'verbatim <value>', number: 0, duration: 0, date: '2090-02-03', single_select: option, multi_select: [option], person: [M.teamMemberA], boolean: false, url: 'https://example.com/synthetic' }[type];
      const value = { type, value: raw } as TaskFieldData;
      const saved = await fields.setTaskValue(context(), task.id, field.id, { expectedRevision: 0, expectedDefinitionRevision: field.revision, value });
      const disabled = await fields.updateField(context(), field.id, { expectedRevision: field.revision, historyEnabled: false, name: `Now ${type}` });
      await fields.setTaskValue(context(), task.id, field.id, { expectedRevision: saved.revision, expectedDefinitionRevision: disabled.revision, value: { type, value: null } as TaskFieldData });
      const entries = changes(await all(100, context(), task.id)).filter(change => change.field === 'custom' && change.fieldId === field.id);
      expect(entries).toHaveLength(2);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ availability: 'history', fieldName: `Then ${type}`, before: null, after: value, definition: expect.objectContaining({ name: `Then ${type}`, historyEnabled: true }) }),
        expect.objectContaining({ availability: 'opted_out' }),
      ]));
      const hidden = entries.find(change => change.field === 'custom' && change.availability === 'opted_out');
      expect(hidden).not.toHaveProperty('before'); expect(hidden).not.toHaveProperty('after'); expect(hidden).not.toHaveProperty('definition');
    }
  });

  it('redacts a real foreign-project field and rolls back history/value/audit/outbox/receipt on a SQL history failure', async () => {
    const tasks = createTaskApplication(target.database), fields = createTaskFieldApplication(target.database), task = await fresh('Rollback and redaction');
    const foreign = await tasks.createProject(context(), { name: 'Foreign field project' });
    const foreignField = await fields.createField(context(), createTaskFieldInputSchema.parse({ projectId: foreign.id, name: 'FOREIGN-FIELD-SECRET', type: 'text' }));
    await emit([{ entityType: 'task_field_value', entityId: task.id, action: 'updated', diff: { taskId: task.id, fieldId: foreignField.id, type: 'text', historyCaptured: true, value: 'FOREIGN-VALUE-SECRET' } }]);
    const redacted = await all(100, context(), task.id);
    expect(changes(redacted)).toEqual(expect.arrayContaining([{ field: 'custom', fieldId: null, fieldName: null, fieldType: null, availability: 'redacted' }]));
    expect(JSON.stringify(redacted)).not.toContain('FOREIGN-');
    const field = await fields.createField(context(), createTaskFieldInputSchema.parse({ projectId, name: 'Rollback', type: 'text' }));
    const sql = target.database.sql, key = randomUUID(), input = { expectedRevision: 0, expectedDefinitionRevision: field.revision, value: { type: 'text' as const, value: 'Committed once' } };
    await sql.unsafe("create function synthetic_timeline_history_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic_timeline_history_failure'; end $$");
    await sql.unsafe('create trigger synthetic_timeline_history_failure before insert on task_field_value_history for each row execute function synthetic_timeline_history_failure()');
    const before = await snapshot();
    try { await expect(fields.setTaskValue(context(U.owner, key), task.id, field.id, input)).rejects.toThrow(); expect(await snapshot()).toEqual(before); }
    finally { await sql.unsafe('drop trigger synthetic_timeline_history_failure on task_field_value_history'); await sql.unsafe('drop function synthetic_timeline_history_failure()'); }
    const saved = await fields.setTaskValue(context(U.owner, key), task.id, field.id, input);
    expect(await fields.setTaskValue(context(U.owner, key), task.id, field.id, input)).toEqual(saved);
    expect(changes(await all(100, context(), task.id)).filter(change => change.field === 'custom' && change.fieldId === field.id)).toHaveLength(1);
  });

  it('attributes manual-period zero/edit/void to its actual owner rather than the actor and checks period scope', async () => {
    const planning = createPlanningApplication(target.database), task = await fresh('Manual work history');
    const period = await planning.createPeriod(context(), createPlanningPeriodInputSchema.parse({ projectId, name: 'Synthetic far future', localStart: '2090-01-02', timezone: 'UTC', cutoffAt: '2090-01-01T00:00:00.000Z' }));
    const first = await planning.setManualPeriodWork(context(), task.id, period.id, M.teamMemberA, setManualPeriodWorkInputSchema.parse({ expectedRevision: null, minutes: 0 }));
    const second = await planning.setManualPeriodWork(context(), task.id, period.id, M.teamMemberA, setManualPeriodWorkInputSchema.parse({ expectedRevision: first.revision, minutes: 35, reason: 'Synthetic correction' }));
    await planning.setManualPeriodWork(context(), task.id, period.id, M.teamMemberA, setManualPeriodWorkInputSchema.parse({ expectedRevision: second.revision, minutes: 35, state: 'void', reason: 'Synthetic void' }));
    const rows = (await all(100, context(), task.id)).filter(item => item.type === 'activity' && item.kind === 'work');
    expect(rows).toHaveLength(3);
    for (const row of rows) { expect(row).toMatchObject({ actorUserId: U.owner }); expect(row.type === 'activity' && row.changes[0]).toMatchObject({ field: 'work', membership: { id: M.teamMemberA }, precision: 'period', period: { id: period.id, timezone: 'UTC' } }); }
    expect(changes(rows)).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: 'logged', from: null, to: 0, toState: 'active' }),
      expect.objectContaining({ op: 'edited', from: 0, to: 35 }),
      expect.objectContaining({ op: 'removed', toState: 'void' }),
    ]));
    const foreign = await createTaskApplication(target.database).createProject(context(), { name: 'Other period project' });
    const foreignPeriod = await planning.createPeriod(context(), createPlanningPeriodInputSchema.parse({ projectId: foreign.id, name: 'Other period', localStart: '2090-01-02', timezone: 'UTC', cutoffAt: '2090-01-01T00:00:00.000Z' }));
    const before = await snapshot();
    await expect(planning.setManualPeriodWork(context(), task.id, foreignPeriod.id, M.teamMemberA, setManualPeriodWorkInputSchema.parse({ expectedRevision: null, minutes: 999 }))).rejects.toMatchObject({ code: 'DOMAIN_VALIDATION_FAILED' });
    expect(await snapshot()).toEqual(before);
  });

  it('shows exactly one shared estimate event to source, second selected and unloaded sibling without leaking other task fields', async () => {
    const tasks = createTaskApplication(target.database), parent = await fresh('Package parent'), selected = await fresh('Selected detail', parent.id), unloaded = await fresh('Unselected detail', parent.id), distinct = await fresh('Distinct package');
    expect(selected.workPackageId).toBe(parent.workPackageId); expect(unloaded.workPackageId).toBe(parent.workPackageId); expect(distinct.workPackageId).not.toBe(parent.workPackageId);
    const input = { projectId, tasks: [parent, selected].map(task => ({ taskId: task.id, expectedRevision: task.revision, expectedWorkPackageRevision: task.workPackageRevision })), changes: { estimateMinutes: 90, priority: 'urgent' as const } };
    const key = randomUUID(); const result = await tasks.bulkUpdateTasks(context(U.owner, key), input);
    const beforeReplay = await snapshot(); expect(await tasks.bulkUpdateTasks(context(U.owner, key), input)).toEqual(result); expect(await snapshot()).toEqual(beforeReplay);
    for (const task of [parent, selected, unloaded]) {
      const values = changes(await all(100, context(), task.id));
      expect(values.filter(change => change.field === 'estimate' && change.to === 90)).toEqual([{ field: 'estimate', from: null, to: 90 }]);
      if (task.id === unloaded.id) { expect(values.some(change => change.field === 'priority')).toBe(false); expect(JSON.stringify(values)).not.toContain('Package parent'); }
    }
    expect(changes(await all(100, context(), distinct.id)).some(change => change.field === 'estimate')).toBe(false);
  });

  it('records real dependency removal/restore and rejects a foreign-workspace end with no changes', async () => {
    const dependencies = createDependencyApplication(target.database), source = await fresh('Real predecessor'), destination = await fresh('Real successor');
    const edge = await dependencies.createDependency(context(), { predecessorTaskId: source.id, successorTaskId: destination.id, type: 'finish_to_start', expectedAbsent: true });
    const removed = await dependencies.updateDependency(context(), edge.id, { expectedRevision: edge.revision, state: 'removed' });
    await dependencies.updateDependency(context(), edge.id, { expectedRevision: removed.revision, state: 'active' });
    const values = changes(await all(100, context(), source.id)).filter(change => change.field === 'dependency');
    expect(values).toHaveLength(3); expect(values).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'removed', direction: 'blocks', other: { id: destination.id, title: destination.title, availability: 'current' } })]));
    const tasks = createTaskApplication(target.database), outsideContext = context(U.outsider, randomUUID(), W.outside), project = await tasks.createProject(outsideContext, { name: 'Outside' });
    const status = (await tasks.listStatuses(outsideContext, project.id))[0]; if (!status) throw new Error('Outside status missing.');
    const outside = await tasks.createTask(context(U.outsider, randomUUID(), W.outside), { projectId: project.id, statusId: status.id, title: 'CROSS-WORKSPACE-SECRET' });
    const before = await snapshot();
    await expect(dependencies.createDependency(context(), { predecessorTaskId: source.id, successorTaskId: outside.id, type: 'finish_to_start', expectedAbsent: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await snapshot()).toEqual(before); expect(JSON.stringify(await all(100, context(), source.id))).not.toContain('CROSS-WORKSPACE-SECRET');
    // Current tasks are workspace-visible only; unsupported future private-ACL redaction is covered by the fail-closed mapper unit, not fabricated SQL state.
  });
});
