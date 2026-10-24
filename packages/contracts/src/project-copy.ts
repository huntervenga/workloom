import { z } from 'zod';
import { idSchema } from './common/ids.js';
import { envelopeSchema } from './common/envelope.js';

/**
 * A copy of a project's structure and settings without its tasks, for the next week or cycle. Sections, ordinary fields
 * and their options, column layout are always copied; the rest can be switched off. Dates inside copied settings move by
 * `shiftDays` (7 for "next week").
 */
export const duplicateProjectInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  shiftDays: z.number().int().min(-3660).max(3660).default(0),
  copy: z.strictObject({
    aggregates: z.boolean().default(true),
    checks: z.boolean().default(true),
    defaults: z.boolean().default(true),
    reports: z.boolean().default(true),
    workCategory: z.boolean().default(true),
  }).default({ aggregates: true, checks: true, defaults: true, reports: true, workCategory: true }),
});
export const duplicateProjectResultSchema = z.strictObject({
  projectId: idSchema,
  name: z.string(),
  copied: z.strictObject({
    sections: z.number().int().nonnegative(),
    fields: z.number().int().nonnegative(),
    aggregates: z.boolean(),
    checkRules: z.number().int().nonnegative(),
    defaults: z.boolean(),
    reports: z.number().int().nonnegative(),
    workCategory: z.boolean(),
  }),
  /** Optional parts that could not be copied; the new project is still complete without them. */
  warnings: z.array(z.strictObject({ part: z.enum(['aggregates', 'checks', 'defaults', 'reports', 'workCategory']), message: z.string() })),
});
export const duplicateProjectResponseSchema = envelopeSchema(duplicateProjectResultSchema);
export type DuplicateProjectInput = z.input<typeof duplicateProjectInputSchema>;
export type DuplicateProjectParsed = z.infer<typeof duplicateProjectInputSchema>;
export type DuplicateProjectResult = z.infer<typeof duplicateProjectResultSchema>;

/**
 * Copies one project's settings onto existing projects of the same workspace (for example week 41's checks and sums
 * onto every other week). Fields, options and sections are matched by type and name; a part that cannot be matched is
 * reported. A target part that already has settings is left alone unless `replaceExisting` is set.
 */
export const applyProjectSettingsInputSchema = z.strictObject({
  targetProjectIds: z.array(idSchema).min(1).max(100),
  replaceExisting: z.boolean().default(false),
  copy: z.strictObject({
    aggregates: z.boolean().default(true),
    checks: z.boolean().default(true),
    defaults: z.boolean().default(true),
  }).default({ aggregates: true, checks: true, defaults: true }),
});
export const applyProjectSettingsResultSchema = z.strictObject({
  results: z.array(z.strictObject({
    projectId: idSchema,
    applied: z.strictObject({ aggregates: z.boolean(), checkRules: z.number().int().nonnegative(), defaults: z.boolean() }),
    warnings: z.array(z.strictObject({ part: z.enum(['aggregates', 'checks', 'defaults']), message: z.string() })),
  })),
});
export const applyProjectSettingsResponseSchema = envelopeSchema(applyProjectSettingsResultSchema);
export type ApplyProjectSettingsInput = z.input<typeof applyProjectSettingsInputSchema>;
export type ApplyProjectSettingsResult = z.infer<typeof applyProjectSettingsResultSchema>;
