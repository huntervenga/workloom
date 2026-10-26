import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';

export const userThemeSchema = z.enum(['default', 'dark', 'light']);
export const userPreferencesSchema = z.object({ version: z.literal(1), theme: userThemeSchema });
export const userSettingsSchema = z.object({
  userId: idSchema,
  revision: z.number().int().min(0),
  settings: userPreferencesSchema,
  updatedAt: z.iso.datetime().nullable(),
});
export const updateUserSettingsInputSchema = z.strictObject({
  expectedUserId: idSchema,
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
  settings: z.strictObject({ theme: userThemeSchema }),
});
export const userSettingsResponseSchema = envelopeSchema(userSettingsSchema);
export type UserTheme = z.infer<typeof userThemeSchema>;
export type UserPreferences = z.infer<typeof userPreferencesSchema>;
export type UserSettingsDto = z.infer<typeof userSettingsSchema>;
export type UpdateUserSettingsInput = z.infer<typeof updateUserSettingsInputSchema>;
