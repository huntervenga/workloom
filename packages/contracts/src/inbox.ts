import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { utcTimestampSchema } from './tasks.js';

/**
 * The person's inbox, derived on read from what already happened: someone else made them responsible for a task, wrote a
 * comment on a task they are responsible for or take part in, or decided one of their time-off requests; people who may
 * approve time off also see requests still waiting for a decision. Nothing is stored per person; "unread" is a browser-side
 * bookmark. The window is the last 30 days.
 */
export const INBOX_WINDOW_DAYS = 30;
export const inboxQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const taskRefSchema = z.strictObject({ id: idSchema, title: z.string(), projectId: idSchema, projectName: z.string() });
const leaveRefSchema = z.strictObject({
  requestId: idSchema,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  startDate: z.string(),
  endDate: z.string(),
  /** Whose request it is; for a pending request waiting on the reader this is somebody else. */
  personName: z.string(),
});
export const inboxItemSchema = z.strictObject({
  /** The audit event or comment this item comes from; stable, so the browser can remember what it showed. */
  id: idSchema,
  kind: z.enum(['assigned', 'comment', 'leave_decided', 'leave_pending']),
  at: utcTimestampSchema,
  actorName: z.string(),
  task: taskRefSchema.nullable(),
  leave: leaveRefSchema.nullable(),
  /** First part of the comment text; null for assignments. */
  excerpt: z.string().nullable(),
});
export const inboxResponseSchema = envelopeSchema(z.array(inboxItemSchema).max(100));
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type InboxQueryInput = z.input<typeof inboxQuerySchema>;
export type InboxItemDto = z.infer<typeof inboxItemSchema>;
