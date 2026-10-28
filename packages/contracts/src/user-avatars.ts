import { z } from 'zod';
import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { profilePhotoUrlSchema } from './profile-photo.js';

export const MAX_AVATAR_BYTES = 5_000_000;
export const AVATAR_SIZE = 512;
export const userAvatarFeatureSchema = z.strictObject({
  enabled: z.boolean(), reason: z.enum(['storage_not_configured', 'storage_configuration_invalid']).nullable(),
  maxFileSizeBytes: z.literal(MAX_AVATAR_BYTES), acceptedTypes: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp'])),
});
export const userAvatarSchema = z.strictObject({
  userId: idSchema, revision: z.number().int().nonnegative(), avatarUrl: profilePhotoUrlSchema.nullable(), hasCustomAvatar: z.boolean(),
});
export const changeUserAvatarInputSchema = z.strictObject({
  expectedUserId: idSchema, expectedRevision: z.number().int().min(0).max(2_147_483_646),
});
export const userAvatarResponseSchema = envelopeSchema(userAvatarSchema);
export type UserAvatarDto = z.infer<typeof userAvatarSchema>;
export type ChangeUserAvatarInput = z.infer<typeof changeUserAvatarInputSchema>;
