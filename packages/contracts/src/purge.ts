import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';

/** The exact name or title must be typed back: a permanent delete is never a one-click action. */
export const purgeProjectInputSchema = z.strictObject({ confirmName: z.string().min(1).max(500) });
export const purgeTaskInputSchema = z.strictObject({ confirmTitle: z.string().min(1).max(500) });
export const purgeResultSchema = z.strictObject({ deleted: z.record(z.string(), z.number().int().nonnegative()) });
export const purgeResponseSchema = envelopeSchema(purgeResultSchema);

export type PurgeProjectInput = z.infer<typeof purgeProjectInputSchema>;
export type PurgeTaskInput = z.infer<typeof purgeTaskInputSchema>;
export type PurgeResultDto = z.infer<typeof purgeResultSchema>;
