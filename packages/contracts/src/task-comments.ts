import { z } from 'zod';
import { envelopeSchema, responseMetaSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { taskFieldDataSchema, taskFieldDefinitionSchema, taskFieldTypeSchema } from './fields.js';
import { profilePhotoUrlSchema } from './profile-photo.js';
import { calendarDateSchema, minutesSchema, taskPrioritySchema, taskStatusGroupSchema, utcTimestampSchema } from './tasks.js';

const MAX_INT32 = 2_147_483_647;
const MAX_TIMELINE_CHANGES = 20;
const MAX_SET_REFS = 100;

/** Canonical profile photo policy; optional and nullable without a default so old receipts and cached JSON stay byte-identical. */
const avatarUrlSchema = profilePhotoUrlSchema.nullable().optional();
const changeSeqSchema = z.string().regex(/^[1-9][0-9]{0,18}$/);
const displayNameSchema = z.string().min(1).max(200);

/** Preserve exact submitted text; names, author identity and server time are not client input. */
export const createTaskCommentInputSchema = z.strictObject({
  body: z.string().min(1).max(4000).refine(value => value.length <= 4000 && value.trim().length > 0 && !value.includes('\0'), 'A nonblank plain-text comment is required.'),
  /** People named with @ in the body, chosen by the author; ignored for anyone who is not an active member. Absent keeps old requests byte-identical. */
  mentionedMembershipIds: z.array(idSchema).max(20).optional(),
});
export const taskCommentSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, taskId: idSchema,
  authorUserId: idSchema, authorMembershipId: idSchema,
  authorDisplayNameSnapshot: displayNameSchema,
  authorAvatarUrl: avatarUrlSchema,
  createdAt: utcTimestampSchema, body: createTaskCommentInputSchema.shape.body,
});
const pageQuery = { limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(2048).optional() };
export const taskCommentsQuerySchema = z.strictObject(pageQuery);
export const taskActivityQuerySchema = z.strictObject(pageQuery);
export const taskTimelineQuerySchema = z.strictObject(pageQuery);
export const taskCommentResponseSchema = envelopeSchema(taskCommentSchema);
const pageMeta = responseMetaSchema.extend({ nextCursor: z.string().nullable() });
export const taskCommentsResponseSchema = envelopeSchema(z.array(taskCommentSchema).max(100)).extend({ meta: pageMeta });
/** Public summaries only. Raw audit values, reasons, sources and payloads are intentionally absent. */
export const taskActivityKindSchema = z.enum(['created', 'updated', 'archived', 'restored', 'schedule_updated']);
export const taskActivitySchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, taskId: idSchema, kind: taskActivityKindSchema,
  actorUserId: idSchema, actorMembershipId: idSchema,
  actorDisplayName: displayNameSchema, // Current membership name; not a historical snapshot.
  actorAvatarUrl: avatarUrlSchema,
  occurredAt: utcTimestampSchema,
  changeSeq: changeSeqSchema, eventOrdinal: z.number().int().positive(),
});
export const taskActivityResponseSchema = envelopeSchema(z.array(taskActivitySchema).max(100)).extend({ meta: pageMeta });

/**
 * A referenced label. `snapshot` was captured at write time and `current` is today's name; both carry
 * an ID and a name. `uncaptured` has no name (never fabricated) and `redacted` has neither ID nor name.
 * `group` is the status group, so completion and reopening stay readable after a rename.
 */
export const taskActivityLabelRefSchema = z.strictObject({
  id: idSchema.nullable(),
  name: displayNameSchema.nullable(),
  availability: z.enum(['snapshot', 'uncaptured', 'current', 'redacted']),
  group: taskStatusGroupSchema.optional(),
}).superRefine((ref, ctx) => {
  const known = ref.availability === 'snapshot' || ref.availability === 'current';
  if (ref.availability === 'redacted' && ref.id !== null) ctx.addIssue({ code: 'custom', path: ['id'], message: 'A redacted label has no ID.' });
  if (known ? ref.id === null || ref.name === null : ref.name !== null) {
    ctx.addIssue({ code: 'custom', path: ['name'], message: 'Only a known label has an ID and a name.' });
  }
  if (!known && ref.group !== undefined) ctx.addIssue({ code: 'custom', path: ['group'], message: 'Only a known label has a group.' });
});

/** Another task: its current title, or nothing at all when the reader may not see it. */
export const taskActivityTaskRefSchema = z.strictObject({
  id: idSchema.nullable(),
  title: z.string().min(1).max(500).nullable(),
  availability: z.enum(['current', 'redacted']),
}).superRefine((ref, ctx) => {
  const visible = ref.availability === 'current';
  if (visible !== (ref.id !== null) || visible !== (ref.title !== null)) {
    ctx.addIssue({ code: 'custom', path: ['availability'], message: 'A current task has an ID and a title; a redacted one has neither.' });
  }
});

const labelRef = taskActivityLabelRefSchema;
const labelRefChange = <F extends string>(field: F) =>
  z.strictObject({ field: z.literal(field), from: labelRef.nullable(), to: labelRef.nullable() });
const labelSetChange = <F extends string>(field: F) => z.strictObject({
  field: z.literal(field),
  added: z.array(labelRef).max(MAX_SET_REFS),
  removed: z.array(labelRef).max(MAX_SET_REFS),
  /** References beyond the public cap, counted rather than silently dropped. */
  omitted: z.number().int().min(0).max(MAX_INT32),
});
const dateChange = <F extends string>(field: F) => z.strictObject({
  field: z.literal(field),
  from: calendarDateSchema.nullable(),
  to: calendarDateSchema.nullable(),
  availability: z.literal('uncaptured').optional(),
}).superRefine((change, ctx) => {
  if (change.availability === 'uncaptured' && (change.from !== null || change.to !== null)) {
    ctx.addIssue({ code: 'custom', path: ['availability'], message: 'Uncaptured dates carry no values.' });
  }
});
const titleTextSchema = z.string().max(500);
const workStateSchema = z.enum(['active', 'void']);

/**
 * Custom values appear only with recorded history and a definition snapshot describing the same
 * field and type. Opted-out, uncaptured and redacted changes never carry values; redacted ones
 * carry no field identity either.
 */
const customChangeSchema = z.strictObject({
  field: z.literal('custom'),
  ownerException: z.strictObject({policyRevision:z.number().int().min(0),reason:z.string().trim().min(1).max(500)}).optional(),
  fieldId: idSchema.nullable(),
  fieldName: displayNameSchema.nullable(),
  fieldType: taskFieldTypeSchema.nullable(),
  availability: z.enum(['history', 'opted_out', 'uncaptured', 'redacted']),
  before: taskFieldDataSchema.nullable().optional(),
  after: taskFieldDataSchema.optional(),
  definition: taskFieldDefinitionSchema.optional(),
}).superRefine((change, ctx) => {
  if (change.availability !== 'history') {
    for (const key of ['before', 'after', 'definition'] as const) {
      if (change[key] !== undefined) ctx.addIssue({ code: 'custom', path: [key], message: 'Values are exposed only with recorded history.' });
    }
    if(change.availability==='redacted'&&change.ownerException!==undefined)ctx.addIssue({code:'custom',path:['ownerException'],message:'A redacted field has no exception metadata.'});
    if (change.availability === 'redacted' && (change.fieldId !== null || change.fieldName !== null || change.fieldType !== null)) {
      ctx.addIssue({ code: 'custom', path: ['fieldId'], message: 'A redacted field has no identity.' });
    }
    return;
  }
  const { definition, before, after } = change;
  if (definition === undefined || before === undefined || after === undefined) {
    ctx.addIssue({ code: 'custom', path: ['definition'], message: 'History requires a definition, before and after.' });
    return;
  }
  if (change.fieldId !== definition.id || change.fieldType !== definition.type) {
    ctx.addIssue({ code: 'custom', path: ['definition'], message: 'Snapshot must describe fieldId and fieldType.' });
  }
  if (after.type !== definition.type || (before !== null && before.type !== definition.type)) {
    ctx.addIssue({ code: 'custom', path: ['after', 'type'], message: 'Value type must match the field type.' });
  }
});

const workPeriodSchema = z.strictObject({
  id: idSchema,
  name: displayNameSchema,
  localStart: calendarDateSchema,
  localEndExclusive: calendarDateSchema,
  timezone: z.string().max(64).regex(/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/),
}).refine(period => period.localStart < period.localEndExclusive, { error: 'A period ends after it starts.' });

/** One public change line, discriminated by `field`. Description and position never expose values. */
export const taskActivityChangeSchema = z.discriminatedUnion('field', [
  z.strictObject({ field: z.literal('title'), from: titleTextSchema.nullable(), to: titleTextSchema.nullable() }),
  z.strictObject({ field: z.literal('description') }),
  labelRefChange('status'),
  labelRefChange('section'),
  labelRefChange('responsible'),
  z.strictObject({ field: z.literal('parent'), from: taskActivityTaskRefSchema.nullable(), to: taskActivityTaskRefSchema.nullable() }),
  dateChange('startDate'),
  dateChange('dueDate'),
  z.strictObject({ field: z.literal('priority'), from: taskPrioritySchema.nullable(), to: taskPrioritySchema.nullable() }),
  z.strictObject({ field: z.literal('position') }),
  z.strictObject({ field: z.literal('estimate'), from: minutesSchema.nullable(), to: minutesSchema.nullable() }),
  labelSetChange('tags'),
  labelSetChange('participants'),
  customChangeSchema,
  z.strictObject({
    field: z.literal('dependency'),
    op: z.enum(['added', 'removed']),
    direction: z.enum(['blocks', 'blocked_by']),
    other: taskActivityTaskRefSchema,
  }),
  z.strictObject({
    field: z.literal('work'),
    op: z.enum(['logged', 'edited', 'removed']),
    from: minutesSchema.nullable(),
    to: minutesSchema.nullable(),
    fromState: workStateSchema.nullable(),
    toState: workStateSchema.nullable(),
    membership: labelRef,
    period: workPeriodSchema,
    precision: z.literal('period'),
  }),
]);

/** Superset of `taskActivityKindSchema`; the legacy activity endpoint keeps its five kinds. */
export const taskTimelineActivityKindSchema = z.enum([...taskActivityKindSchema.options, 'field_value', 'dependency', 'work']);
const timelineItemBase = {
  id: idSchema, workspaceId: idSchema, taskId: idSchema,
  changeSeq: changeSeqSchema, eventOrdinal: z.number().int().positive(), occurredAt: utcTimestampSchema,
};
const timelineCommentItemSchema = z.strictObject({ type: z.literal('comment'), ...timelineItemBase, comment: taskCommentSchema })
  .superRefine((item, ctx) => {
    if (item.comment.taskId !== item.taskId || item.comment.workspaceId !== item.workspaceId) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Comment must belong to the item task.' });
    }
  });
/** `exact`: every change listed; `partial`: some could not be described; `uncaptured`: none were. */
const timelineActivityItemSchema = z.strictObject({
  type: z.literal('activity'), ...timelineItemBase,
  kind: taskTimelineActivityKindSchema,
  actorUserId: idSchema, actorMembershipId: idSchema,
  actorDisplayName: displayNameSchema,
  actorAvatarUrl: avatarUrlSchema,
  detail: z.enum(['exact', 'partial', 'uncaptured']),
  changes: z.array(taskActivityChangeSchema).max(MAX_TIMELINE_CHANGES),
}).superRefine((item, ctx) => {
  if (item.detail === 'uncaptured' && item.changes.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['changes'], message: 'Uncaptured activity lists no changes.' });
  }
});
export const taskTimelineItemSchema = z.discriminatedUnion('type', [timelineCommentItemSchema, timelineActivityItemSchema]);
export const taskTimelineResponseSchema = envelopeSchema(z.array(taskTimelineItemSchema).max(100)).extend({ meta: pageMeta });

export type CreateTaskCommentInput = z.infer<typeof createTaskCommentInputSchema>;
export type TaskCommentDto = z.infer<typeof taskCommentSchema>;
export type TaskCommentsQueryInput = z.input<typeof taskCommentsQuerySchema>;
export type TaskActivityQueryInput = z.input<typeof taskActivityQuerySchema>;
export type TaskTimelineQuery = z.infer<typeof taskCommentsQuerySchema>;
export type TaskTimelineQueryInput = z.input<typeof taskTimelineQuerySchema>;
export type TaskActivityDto = z.infer<typeof taskActivitySchema>;
export type TaskActivityLabelRef = z.infer<typeof taskActivityLabelRefSchema>;
export type TaskActivityTaskRef = z.infer<typeof taskActivityTaskRefSchema>;
export type TaskActivityChangeDto = z.infer<typeof taskActivityChangeSchema>;
export type TaskTimelineItemDto = z.infer<typeof taskTimelineItemSchema>;
export type TaskTimelineResponse = z.infer<typeof taskTimelineResponseSchema>;
