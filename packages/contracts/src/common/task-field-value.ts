import { z } from 'zod';
import { idSchema } from './ids.js';
/** Shared value projection without importing tasks/fields into each other. No output defaults. */
export function createTaskFieldValueSchema<TValue extends z.ZodType, TRevision extends z.ZodType<number>, TTimestamp extends z.ZodType<string>>({ valueSchema, revisionSchema, timestampSchema }: { valueSchema: TValue; revisionSchema: TRevision; timestampSchema: TTimestamp }) {
  return z.strictObject({
    workspaceId: idSchema, projectId: idSchema, taskId: idSchema, fieldId: idSchema,
    definitionVersionId: idSchema, revision: revisionSchema, value: valueSchema, updatedAt: timestampSchema,
  });
}
