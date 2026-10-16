import { z } from 'zod';
import { envelopeSchema, responseMetaSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { taskSchema, taskStatusGroupSchema, utcTimestampSchema } from './tasks.js';

const queryBoolean = z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')]);
/** Self-only read filters. No client-selected membership, actor or sort expression is accepted. */
export const myTasksQuerySchema = z.strictObject({
  relation: z.enum(['all', 'assigned', 'participating']).default('all'),
  completion: z.enum(['open', 'closed', 'all']).default('open'),
  includeArchived: queryBoolean.default(false),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(2048).optional(),
});

/** Current labels are data, never UI translations; decoration is bounded by this task page. */
export const myTaskSchema = z.object({
  task: taskSchema,
  project: z.object({ id: idSchema, name: z.string(), archivedAt: utcTimestampSchema.nullable() }),
  status: z.object({ id: idSchema, name: z.string(), group: taskStatusGroupSchema }),
}).refine(row => row.task.projectId === row.project.id && row.task.statusId === row.status.id, 'Task decoration does not match its identity.');
export const myTasksResponseSchema = envelopeSchema(z.array(myTaskSchema).max(200)).extend({ meta: responseMetaSchema.extend({ nextCursor: z.string().nullable() }) });
export type MyTasksQuery = z.infer<typeof myTasksQuerySchema>;
export type MyTasksQueryInput = z.input<typeof myTasksQuerySchema>;
export type MyTaskDto = z.infer<typeof myTaskSchema>;
