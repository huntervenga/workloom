import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { utcTimestampSchema } from './tasks.js';

/**
 * The person's inbox, derived on read from what already happened: someone else made them responsible for a task, or wrote a
 * comment on a task they are responsible for or take part in. Nothing is stored per person; "unread" is a browser-side
 * bookmark. The window is the last 30 days.
 */
export const INBOX_WINDOW_DAYS = 30;
export const inboxQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });
export const inboxItemSchema = z.strictObject({
  /** The audit event or comment this item comes from; stable, so the browser can remember what it showed. */
  id: idSchema,
  kind: z.enum(['assigned', 'comment']),
  at: utcTimestampSchema,
  actorName: z.string(),
  task: z.strictObject({ id: idSchema, title: z.string(), projectId: idSchema, projectName: z.string() }),
  /** First part of the comment text; null for assignments. */
  excerpt: z.string().nullable(),
});
export const inboxResponseSchema = envelopeSchema(z.array(inboxItemSchema).max(100));
export type InboxQuery = z.infer<typeof inboxQuerySchema>;
export type InboxQueryInput = z.input<typeof inboxQuerySchema>;
export type InboxItemDto = z.infer<typeof inboxItemSchema>;
