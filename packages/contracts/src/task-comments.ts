import { z } from 'zod';
import { envelopeSchema, responseMetaSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { utcTimestampSchema } from './tasks.js';

/** Preserve exact submitted text; names, author identity and server time are not client input. */
export const createTaskCommentInputSchema = z.strictObject({
  body: z.string().min(1).max(4000).refine(value => value.length <= 4000 && value.trim().length > 0 && !value.includes('\0'), 'A nonblank plain-text comment is required.'),
});
export const taskCommentSchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, taskId: idSchema,
  authorUserId: idSchema, authorMembershipId: idSchema,
  authorDisplayNameSnapshot: z.string().min(1).max(200),
  createdAt: utcTimestampSchema, body: createTaskCommentInputSchema.shape.body,
});
const pageQuery = { limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(2048).optional() };
export const taskCommentsQuerySchema = z.strictObject(pageQuery);
export const taskActivityQuerySchema = z.strictObject(pageQuery);
export const taskCommentResponseSchema = envelopeSchema(taskCommentSchema);
const pageMeta = responseMetaSchema.extend({ nextCursor: z.string().nullable() });
export const taskCommentsResponseSchema = envelopeSchema(z.array(taskCommentSchema).max(100)).extend({ meta: pageMeta });
/** Public summaries only. Raw audit values, reasons, sources and payloads are intentionally absent. */
export const taskActivityKindSchema = z.enum(['created', 'updated', 'archived', 'restored', 'schedule_updated']);
export const taskActivitySchema = z.strictObject({
  id: idSchema, workspaceId: idSchema, taskId: idSchema, kind: taskActivityKindSchema,
  actorUserId: idSchema, actorMembershipId: idSchema,
  actorDisplayName: z.string().min(1).max(200), // Current membership name; not a historical snapshot.
  occurredAt: utcTimestampSchema,
  changeSeq: z.string().regex(/^[1-9][0-9]{0,18}$/), eventOrdinal: z.number().int().positive(),
});
export const taskActivityResponseSchema = envelopeSchema(z.array(taskActivitySchema).max(100)).extend({ meta: pageMeta });
export type CreateTaskCommentInput = z.infer<typeof createTaskCommentInputSchema>;
export type TaskCommentDto = z.infer<typeof taskCommentSchema>;
export type TaskCommentsQueryInput = z.input<typeof taskCommentsQuerySchema>;
export type TaskActivityQueryInput = z.input<typeof taskActivityQuerySchema>;
export type TaskTimelineQuery = z.infer<typeof taskCommentsQuerySchema>;
export type TaskActivityDto = z.infer<typeof taskActivitySchema>;
