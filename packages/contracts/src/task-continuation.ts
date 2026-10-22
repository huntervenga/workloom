import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';
import { taskSchema } from './tasks.js';

/**
 * "Close and continue in another project": the task is completed as it stands (its Fact stays with it), and a fresh task
 * with the next number in its name starts in the chosen project, blocked by the finished one. Only the title, the project
 * and the dependency carry over; everything else starts from that project's defaults.
 */
export const continueTaskInputSchema = z.strictObject({
  targetProjectId: idSchema,
  /** Optional: defaults to the old title with its trailing number raised ("Fix login" → "Fix login 2"). */
  title: z.string().trim().min(1).max(500).optional(),
});
export const continueTaskResultSchema = z.strictObject({
  closed: taskSchema,
  continued: taskSchema,
  dependencyId: idSchema,
});
export const continueTaskResponseSchema = envelopeSchema(continueTaskResultSchema);
export type ContinueTaskInput = z.infer<typeof continueTaskInputSchema>;
export type ContinueTaskResult = z.infer<typeof continueTaskResultSchema>;

/** "Fix login" → "Fix login 2"; "Fix login 2" → "Fix login 3". */
export function nextContinuationTitle(title: string): string {
  const match = /^(.*\S)\s+(\d{1,3})$/.exec(title.trim());
  const next = match ? `${match[1]} ${Number(match[2]) + 1}` : `${title.trim()} 2`;
  return next.length <= 500 ? next : `${next.slice(0, 497).trimEnd()} 2`.slice(0, 500);
}
