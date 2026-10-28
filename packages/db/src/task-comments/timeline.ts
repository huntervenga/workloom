import { userAvatarSql } from '../avatars/projection.js';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  calendarDateSchema, idSchema, taskActivityChangeSchema, taskCommentSchema, taskFieldDataSchema, taskFieldDefinitionSchema, taskFieldTypeSchema,
  taskPrioritySchema, taskStatusGroupSchema, taskTimelineItemSchema,
  type TaskActivityChangeDto, type TaskTimelineItemDto,
} from '@workloom/contracts';
import type { TaskActivityAnchor } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';

/**
 * Unified task timeline: ONE statement, ONE global keyset `(change_seq, event_ordinal)` over the workspace audit
 * sequence (unique per workspace), so comments, task, custom-field, dependency and manual-work events interleave in real
 * commit order and no branch is paged/merged independently. Every branch is scoped to the current workspace and target task.
 * The SQL extracts whitelisted diff keys only; `reason`, `source`, `request_id`, credentials, raw diffs and outbox payloads are
 * never selected. Only owner_exception has a dedicated bounded reason whitelist. Mappers below are strict and fail closed: unknown or legacy shapes become partial/uncaptured, never guesses.
 */
const MAX_ROWS = 101, MAX_CHANGES = 20, MAX_REFS = 100;
const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const uuidOf = (text: SQL) => sql`(case when (${text}) ~ ${UUID} then (${text})::uuid end)`;
const actor = sql`join memberships am on am.workspace_id = a.workspace_id and am.id = a.actor_membership_id and am.user_id = a.actor_user_id join users au on au.id = am.user_id`;
const head = sql`a.change_seq, a.event_ordinal, a.recorded_at, a.action, a.actor_user_id, a.actor_membership_id, au.display_name as actor_display_name, ${userAvatarSql('au')} as actor_avatar_url`;
const order = (take: number) => sql`order by a.change_seq desc, a.event_ordinal desc limit ${take}`;
const otherTask = (id: SQL) => sql`(select jsonb_build_object('id', o.id, 'title', o.title) from tasks o where o.workspace_id = a.workspace_id and o.id = ${uuidOf(id)} and o.visibility = 'workspace')`;

export function timelineStatement(workspaceId: string, taskId: string, after: TaskActivityAnchor | null, take: number): SQL {
  if (!Number.isSafeInteger(take) || take < 1 || take > MAX_ROWS) throw new TypeError('Task timeline pages are bounded to 101 read rows.');
  const keyset = after ? sql`and (a.change_seq, a.event_ordinal) < (${after.changeSeq}::bigint, ${after.eventOrdinal}::integer)` : sql``;
  const activity = sql`jsonb_build_object('v', a.diff->'activity'->'v', 'status', a.diff->'activity'->'status', 'section', a.diff->'activity'->'section', 'responsible', a.diff->'activity'->'responsible', 'tags', a.diff->'activity'->'tags', 'participants', a.diff->'activity'->'participants')`;
  return sql`with t as (
    select id, project_id, work_package_id from tasks where workspace_id = ${workspaceId}::uuid and id = ${taskId}::uuid and visibility = 'workspace'
  )
  select * from (
    (select 'task' as src, a.id as item_id, ${head}, jsonb_build_object(
        'title', a.diff->'title', 'description', a.diff ? 'description', 'position', a.diff ? 'position',
        'statusId', a.diff->'statusId', 'sectionId', a.diff->'sectionId', 'responsibleMembershipId', a.diff->'responsibleMembershipId',
        'parentTaskId', a.diff->'parentTaskId',
        'parentFrom', ${otherTask(sql`a.diff->'parentTaskId'->>'from'`)}, 'parentTo', ${otherTask(sql`a.diff->'parentTaskId'->>'to'`)},
        'startDate', a.diff->'startDate', 'dueDate', a.diff->'dueDate', 'priority', a.diff->'priority',
        'estimate', a.diff->'workPackage'->'estimateMinutes', 'tagIds', a.diff->'tagIds',
        'participants', jsonb_build_object('added', a.diff->'participants'->'added', 'removed', a.diff->'participants'->'removed'),
        'activity', ${activity}) as payload
      from t join audit_events a on a.workspace_id = ${workspaceId}::uuid and a.entity_type = 'task' and a.entity_id = t.id
        and a.action in ('created', 'updated', 'archived', 'restored', 'schedule_updated') ${keyset}
      ${actor} ${order(take)})
    union all
    (select 'shared_estimate', a.id, ${head}, jsonb_build_object('estimate', a.diff->'workPackage'->'estimateMinutes')
      from t join tasks s on s.workspace_id = ${workspaceId}::uuid and s.project_id = t.project_id and s.work_package_id = t.work_package_id and s.id <> t.id
      join audit_events a on a.workspace_id = s.workspace_id and a.entity_type = 'task' and a.entity_id = s.id and a.action = 'updated'
        and a.diff->'workPackage'->>'id' = t.work_package_id::text and a.diff->'workPackage' ? 'estimateMinutes' ${keyset}
      ${actor} ${order(take)})
    union all
    (select 'comment', a.id, ${head}, jsonb_build_object(
        'id', c.id, 'workspaceId', c.workspace_id, 'taskId', c.task_id, 'authorUserId', c.author_user_id, 'authorMembershipId', c.author_membership_id,
        'authorDisplayNameSnapshot', c.author_display_name_snapshot, 'createdAt', c.created_at, 'body', c.body, 'authorAvatarUrl', ${userAvatarSql('cu')})
      from t join task_comments c on c.workspace_id = ${workspaceId}::uuid and c.task_id = t.id
      join audit_events a on a.workspace_id = c.workspace_id and a.entity_type = 'task_comment' and a.entity_id = c.id and a.action = 'created' ${keyset}
      left join users cu on cu.id = c.author_user_id
      ${actor} ${order(take)})
    union all
    (select 'field', a.id, ${head}, jsonb_build_object(
        'ownerException', case when a.action = 'owner_exception' then jsonb_build_object('policyRevision',a.diff->'ownerException'->'policyRevision','reason',a.diff->'ownerException'->'reason') end,
        'historyCaptured', case when jsonb_typeof(a.diff->'historyCaptured') = 'boolean' then a.diff->'historyCaptured' end,
        'fieldId', f.id, 'fieldName', f.name, 'fieldType', f.type, 'projectId', f.project_id,
        'history', h.id is not null, 'historyFieldId', h.field_id, 'historyProjectId', h.project_id,
        'before', h.before, 'after', h.after, 'definition', dv.snapshot)
      from t join audit_events a on a.workspace_id = ${workspaceId}::uuid and a.entity_type = 'task_field_value' and a.entity_id = t.id
        and a.action in ('created', 'updated', 'owner_exception') ${keyset}
      left join task_field_definitions f on f.workspace_id = a.workspace_id and f.id = ${uuidOf(sql`a.diff->>'fieldId'`)}
        and (f.project_id = t.project_id or exists (select 1 from task_project_placements fp
          where fp.workspace_id = f.workspace_id and fp.task_id = t.id and fp.project_id = f.project_id and fp.archived_at is null))
      left join task_field_value_history h on h.workspace_id = a.workspace_id and h.project_id = f.project_id and h.field_id = f.id and h.task_id = t.id and h.change_seq = a.change_seq and h.event_ordinal = a.event_ordinal
      left join task_field_definition_versions dv on dv.workspace_id = h.workspace_id and dv.project_id = h.project_id and dv.field_id = h.field_id and dv.id = h.definition_version_id
      ${actor} ${order(take)})
    union all
    (select 'dependency', a.id, ${head}, jsonb_build_object(
        'direction', case when d.predecessor_task_id = t.id then 'blocks' else 'blocked_by' end, 'other', o.id is not null, 'otherId', o.id, 'otherTitle', o.title)
      from t join task_dependencies d on d.workspace_id = ${workspaceId}::uuid and (d.predecessor_task_id = t.id or d.successor_task_id = t.id)
      join audit_events a on a.workspace_id = d.workspace_id and a.entity_type = 'task_dependency' and a.entity_id = d.id
        and a.action in ('created', 'restored', 'removed') ${keyset}
      left join tasks o on o.workspace_id = d.workspace_id and o.visibility = 'workspace'
        and o.id = case when d.predecessor_task_id = t.id then d.successor_task_id else d.predecessor_task_id end
      ${actor} ${order(take)})
    union all
    (select 'work', a.id, ${head}, jsonb_build_object(
        'membershipId', w.membership_id, 'membershipName', wu.display_name,
        'diffMembershipId', a.diff->>'membershipId', 'diffTaskId', a.diff->>'taskId', 'diffPeriodId', a.diff->>'periodId', 'taskId', t.id, 'periodId', w.period_id,
        'beforeKind', jsonb_typeof(a.diff->'before'), 'beforeMinutes', a.diff->'before'->'minutes', 'beforeState', a.diff->'before'->'state',
        'afterKind', jsonb_typeof(a.diff->'after'), 'afterMinutes', a.diff->'after'->'minutes', 'afterState', a.diff->'after'->'state',
        'period', jsonb_build_object('id', p.id, 'name', p.name, 'localStart', p.local_start, 'localEndExclusive', p.local_end_exclusive, 'timezone', p.timezone))
      from t join work_logs w on w.workspace_id = ${workspaceId}::uuid and w.task_id = t.id and w.project_id = t.project_id and w.source_kind = 'manual_period'
      join planning_periods p on p.workspace_id = w.workspace_id and p.project_id = w.project_id and p.id = w.period_id
      join audit_events a on a.workspace_id = w.workspace_id and a.entity_type = 'work_log' and a.entity_id = w.id and a.action in ('created', 'revised') ${keyset}
      left join memberships wm on wm.workspace_id = w.workspace_id and wm.id = w.membership_id
      left join users wu on wu.id = wm.user_id
      ${actor} ${order(take)})
  ) u order by change_seq desc, event_ordinal desc limit ${take}`;
}

type Json = Record<string, unknown>;
export interface TimelineRow {
  src: string; item_id: string; change_seq: string | bigint; event_ordinal: number; recorded_at: Date | string; action: string;
  actor_user_id: string; actor_membership_id: string; actor_display_name: string; actor_avatar_url: string | null; payload: Json;
}
type LabelRef = { id: string | null; name: string | null; availability: 'snapshot' | 'uncaptured' | 'current' | 'redacted'; group?: z.infer<typeof taskStatusGroupSchema> };
type TaskRef = { id: string | null; title: string | null; availability: 'current' | 'redacted' };
interface Mapped { changes: TaskActivityChangeDto[]; partial: boolean }

const obj = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const iso = (value: Date | string) => new Date(value).toISOString();
const id = (value: unknown): string | null => { const parsed = idSchema.safeParse(value); return parsed.success ? parsed.data : null; };
const minutes = z.number().int().min(0);
const labelName = z.string().min(1).max(200);
const title = z.string().max(500);
/** Same HTTPS-only avatar policy as the public comment contract; anything else is null. */
export function safeAvatarUrl(value: unknown): string | null { const parsed = taskCommentSchema.shape.authorAvatarUrl.safeParse(value ?? null); return parsed.success ? parsed.data ?? null : null; }

/** `{from, to}` pair; `undefined` when absent or invalid (the caller marks invalid as partial). */
function pair<T>(value: unknown, schema: z.ZodType<T>): { from: T | null; to: T | null } | 'invalid' | undefined {
  if (value === null || value === undefined) return undefined;
  const record = obj(value);
  if (!record || !Object.hasOwn(record, 'from') || !Object.hasOwn(record, 'to')) return 'invalid';
  const from = record.from === null ? { success: true as const, data: null } : schema.safeParse(record.from);
  const to = record.to === null ? { success: true as const, data: null } : schema.safeParse(record.to);
  return from.success && to.success ? { from: from.data, to: to.data } : 'invalid';
}

/** Snapshot metadata written by the v1 activity helper; anything else proves nothing. */
function snapshots(meta: Json | null, key: string): Map<string, LabelRef> {
  const out = new Map<string, LabelRef>();
  const section = meta?.v === 1 ? obj(meta[key]) : null;
  if (!section) return out;
  const add = (value: unknown) => {
    const snap = obj(value), snapId = id(snap?.id);
    if (!snap || !snapId) return;
    const name = labelName.safeParse(snap.name), group = taskStatusGroupSchema.safeParse(snap.group);
    out.set(snapId, { id: snapId, name: name.success ? name.data : null, availability: name.success ? 'snapshot' : 'uncaptured', ...(group.success ? { group: group.data } : {}) });
  };
  for (const side of ['from', 'to', 'added', 'removed']) { const value = section[side]; if (Array.isArray(value)) value.slice(0, MAX_REFS).forEach(add); else add(value); }
  return out;
}
/** Legacy or missing name: keep the known id, never substitute the current name as history. */
const label = (refId: string, snaps: Map<string, LabelRef>): LabelRef => snaps.get(refId) ?? { id: refId, name: null, availability: 'uncaptured' };
const taskRef = (value: unknown): TaskRef => {
  const row = obj(value), refId = id(row?.id), text = title.safeParse(row?.title);
  return refId && text.success ? { id: refId, title: text.data, availability: 'current' } : { id: null, title: null, availability: 'redacted' };
};

function labelChange(out: Mapped, field: 'status' | 'section' | 'responsible', raw: unknown, meta: Json | null, key: string) {
  const ids = pair(raw, idSchema);
  if (ids === undefined) return;
  if (ids === 'invalid') { out.partial = true; return; }
  const snaps = snapshots(meta, key);
  const from = ids.from === null ? null : label(ids.from, snaps), to = ids.to === null ? null : label(ids.to, snaps);
  if ([from, to].some(ref => ref && ref.availability !== 'snapshot')) out.partial = true;
  out.changes.push({ field, from, to } as TaskActivityChangeDto);
}

function refList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(item => id(typeof item === 'string' ? item : obj(item)?.membershipId ?? obj(item)?.id));
  return ids.every((item): item is string => item !== null) ? [...new Set(ids)] : null;
}
function setDelta(out: Mapped, field: 'tags' | 'participants', added: string[], removed: string[], snaps: Map<string, LabelRef>) {
  if (!added.length && !removed.length) return;
  const refs = (ids: string[]) => ids.slice(0, MAX_REFS).map(item => label(item, snaps));
  const delta = { field, added: refs(added), removed: refs(removed), omitted: Math.max(0, added.length - MAX_REFS) + Math.max(0, removed.length - MAX_REFS) };
  if ([...delta.added, ...delta.removed].some(ref => ref.availability !== 'snapshot') || delta.omitted) out.partial = true;
  out.changes.push(delta as TaskActivityChangeDto);
}

function taskChanges(payload: Json, out: Mapped) {
  const meta = obj(payload.activity);
  const text = pair(payload.title, title);
  if (text === 'invalid') out.partial = true; else if (text) out.changes.push({ field: 'title', ...text } as TaskActivityChangeDto);
  if (payload.description === true) out.changes.push({ field: 'description' } as TaskActivityChangeDto);
  labelChange(out, 'status', payload.statusId, meta, 'status');
  labelChange(out, 'section', payload.sectionId, meta, 'section');
  labelChange(out, 'responsible', payload.responsibleMembershipId, meta, 'responsible');
  const parent = pair(payload.parentTaskId, idSchema);
  if (parent === 'invalid') out.partial = true;
  else if (parent) {
    const from = parent.from === null ? null : taskRef(payload.parentFrom), to = parent.to === null ? null : taskRef(payload.parentTo);
    if ([from, to].some(ref => ref?.availability === 'redacted')) out.partial = true;
    out.changes.push({ field: 'parent', from, to } as TaskActivityChangeDto);
  }
  for (const field of ['startDate', 'dueDate'] as const) {
    const dates = pair(payload[field], calendarDateSchema);
    if (dates === 'invalid') out.partial = true; else if (dates) out.changes.push({ field, ...dates } as TaskActivityChangeDto);
  }
  const priority = pair(payload.priority, taskPrioritySchema);
  if (priority === 'invalid') out.partial = true; else if (priority) out.changes.push({ field: 'priority', ...priority } as TaskActivityChangeDto);
  if (payload.position === true) out.changes.push({ field: 'position' } as TaskActivityChangeDto);
  estimate(payload, out);
  const tags = pair(payload.tagIds, z.array(z.unknown()));
  if (tags === 'invalid') out.partial = true;
  else if (tags) {
    const from = refList(tags.from ?? []), to = refList(tags.to ?? []);
    if (!from || !to) out.partial = true;
    else setDelta(out, 'tags', to.filter(tag => !from.includes(tag)), from.filter(tag => !to.includes(tag)), snapshots(meta, 'tags'));
  }
  const people = obj(payload.participants);
  if (people && (people.added !== null || people.removed !== null)) {
    const added = refList(people.added ?? []), removed = refList(people.removed ?? []);
    if (!added || !removed) out.partial = true; else setDelta(out, 'participants', added, removed, snapshots(meta, 'participants'));
  }
}
function estimate(payload: Json, out: Mapped) {
  const value = pair(payload.estimate, minutes);
  if (value === 'invalid') out.partial = true; else if (value) out.changes.push({ field: 'estimate', ...value } as TaskActivityChangeDto);
}

/** Values come only from the immutable history row + its definition version, never from the current value. */
function fieldChange(payload: Json, out: Mapped, action:string) {
  // Only the explicit owner-exception action may publish its bounded, purpose-specific reason.
  const exception=z.strictObject({policyRevision:z.number().int().min(0),reason:z.string().trim().min(1).max(500)}).safeParse(payload.ownerException);
  const ownerException=action==='owner_exception'&&exception.success?{ownerException:exception.data}:{};
  if(action==='owner_exception'&&!exception.success)out.partial=true;
  const fieldId = id(payload.fieldId), type = taskFieldTypeSchema.safeParse(payload.fieldType), name = labelName.safeParse(payload.fieldName);
  const redacted = { field: 'custom', fieldId: null, fieldName: null, fieldType: null, availability: 'redacted' } as TaskActivityChangeDto;
  if (!fieldId || !type.success) { out.partial = true; out.changes.push(redacted); return; }
  if (payload.history === true) {
    // Existing history stays visible even if history is disabled now: the opt-out only stops future capture.
    const definition = taskFieldDefinitionSchema.safeParse(payload.definition);
    const before = payload.before === null ? { success: true as const, data: null } : taskFieldDataSchema.safeParse(payload.before);
    const after = taskFieldDataSchema.safeParse(payload.after);
    const matches = payload.historyFieldId === fieldId && payload.historyProjectId === payload.projectId && definition.success
      && definition.data.id === fieldId && definition.data.projectId === payload.projectId && definition.data.type === type.data
      && before.success && (before.data === null || before.data.type === type.data) && after.success && after.data.type === type.data;
    if (!matches) { out.partial = true; out.changes.push(redacted); return; }
    out.changes.push({ ...ownerException, field: 'custom', fieldId, fieldName: definition.data.name, fieldType: type.data, availability: 'history', before: before.data, after: after.data, definition: definition.data } as TaskActivityChangeDto);
    return;
  }
  // No history row: only an explicit write-time flag proves an opt-out; legacy rows stay uncaptured.
  const availability = payload.historyCaptured === false ? 'opted_out' : 'uncaptured';
  if (availability === 'uncaptured') out.partial = true;
  out.changes.push({ ...ownerException, field: 'custom', fieldId, fieldName: name.success ? name.data : null, fieldType: type.data, availability } as TaskActivityChangeDto);
}

function dependencyChange(action: string, payload: Json, out: Mapped) {
  const other = payload.other === true ? taskRef({ id: payload.otherId, title: payload.otherTitle }) : taskRef(null);
  if (other.availability === 'redacted') out.partial = true;
  const direction = payload.direction === 'blocks' ? 'blocks' : 'blocked_by';
  out.changes.push({ field: 'dependency', op: action === 'removed' ? 'removed' : 'added', direction, other } as TaskActivityChangeDto);
}

/** Owner is the work log's membership (cross-checked with `diff.membershipId`), never the audit actor. */
function workChange(payload: Json, out: Mapped) {
  const state = z.enum(['active', 'void']);
  const side = (kind: unknown, rawMinutes: unknown, rawState: unknown) => {
    if (kind === 'null' || kind === null) return { present: false, minutes: null, state: null, valid: kind === 'null' };
    const m = minutes.safeParse(rawMinutes), s = state.safeParse(rawState);
    return { present: true, minutes: m.success ? m.data : null, state: s.success ? s.data : null, valid: kind === 'object' && m.success && s.success };
  };
  const before = side(payload.beforeKind, payload.beforeMinutes, payload.beforeState), after = side(payload.afterKind, payload.afterMinutes, payload.afterState);
  const ownerId = id(payload.membershipId), ownerName = labelName.safeParse(payload.membershipName);
  const ownerMatches = ownerId !== null && payload.diffMembershipId === ownerId;
  const scoped = payload.diffTaskId === payload.taskId && payload.diffPeriodId === payload.periodId;
  const valid = before.valid && after.valid && after.present && ownerMatches && scoped;
  if (!valid) out.partial = true;
  const membership: LabelRef = ownerMatches ? { id: ownerId, name: ownerName.success ? ownerName.data : null, availability: ownerName.success ? 'current' : 'uncaptured' } : { id: null, name: null, availability: 'redacted' };
  const period = obj(payload.period) ?? {};
  const facts = valid ? { from: before.minutes, to: after.minutes, fromState: before.state, toState: after.state } : { from: null, to: null, fromState: null, toState: null };
  const op = after.state === 'void' ? 'removed' : before.present ? 'edited' : 'logged';
  out.changes.push({ field: 'work', op, ...facts, membership, period: { id: period.id, name: period.name, localStart: period.localStart, localEndExclusive: period.localEndExclusive, timezone: period.timezone }, precision: 'period' } as TaskActivityChangeDto);
}

const TASK_KINDS = new Set(['created', 'updated', 'archived', 'restored', 'schedule_updated']);
export function mapTimelineRow(row: TimelineRow, workspaceId: string, taskId: string): TaskTimelineItemDto {
  const position = { workspaceId, taskId, changeSeq: row.change_seq.toString(), eventOrdinal: row.event_ordinal, occurredAt: iso(row.recorded_at) };
  const payload = obj(row.payload) ?? {};
  if (row.src === 'comment') {
    const avatar = safeAvatarUrl(payload.authorAvatarUrl);
    const comment = taskCommentSchema.parse({ ...payload, createdAt: iso(payload.createdAt as string), authorAvatarUrl: avatar });
    return taskTimelineItemSchema.parse({ type: 'comment', id: row.item_id, ...position, comment });
  }
  const out: Mapped = { changes: [], partial: false };
  let kind: string = row.action;
  if (row.src === 'task') { if (row.action === 'updated' || row.action === 'schedule_updated') taskChanges(payload, out); }
  else if (row.src === 'shared_estimate') { kind = 'updated'; estimate(payload, out); }
  else if (row.src === 'field') { kind = 'field_value'; fieldChange(payload, out, row.action); }
  else if (row.src === 'dependency') { kind = 'dependency'; dependencyChange(row.action, payload, out); }
  else if (row.src === 'work') { kind = 'work'; workChange(payload, out); }
  if (row.src === 'task' && !TASK_KINDS.has(kind)) kind = 'updated';
  // Every change is re-validated one by one; an invalid change is dropped, never published.
  const changes = out.changes.filter(change => { const ok = taskActivityChangeSchema.safeParse(change).success; if (!ok) out.partial = true; return ok; }).slice(0, MAX_CHANGES);
  if (out.changes.length > MAX_CHANGES) out.partial = true;
  const valuesExpected = row.src !== 'task' || kind === 'updated' || kind === 'schedule_updated';
  const detail = valuesExpected && changes.length === 0 ? 'uncaptured' : out.partial ? 'partial' : 'exact';
  return taskTimelineItemSchema.parse({
    type: 'activity', id: row.item_id, ...position, kind, actorUserId: row.actor_user_id, actorMembershipId: row.actor_membership_id,
    actorDisplayName: row.actor_display_name, actorAvatarUrl: safeAvatarUrl(row.actor_avatar_url), detail, changes,
  });
}

export async function listTimeline(db: WorkloomExecutor, workspaceId: string, taskId: string, after: TaskActivityAnchor | null, take: number): Promise<TaskTimelineItemDto[]> {
  const result = await (db as unknown as { execute(query: SQL): Promise<unknown> }).execute(timelineStatement(workspaceId, taskId, after, take));
  const rows = (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as TimelineRow[];
  if (rows.length > take) throw new Error('Task timeline statement exceeded its bound.');
  return rows.map(row => mapTimelineRow(row, workspaceId, taskId));
}
