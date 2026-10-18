import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { profilePhotoUrlSchema } from './profile-photo.js';

/** The synthetic actor list must never admit real shared-Auth principals. */
export const fixtureActorSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  kind: z.literal('fixture'),
});

/** Server-resolved internal actor; real identities never merge into fixtures. */
export const actorSchema = fixtureActorSchema.extend({
  kind: z.enum(['fixture', 'real']),
  /** Verified profile photo; absent or null renders initials. */
  avatarUrl: profilePhotoUrlSchema.nullable().optional(),
});

/** `GET /api/v1/me`: the UI shows the local-mode indicator from `authMode`. */
export const meSchema = z.object({
  actor: actorSchema,
  authMode: z.enum(['dev', 'shared']),
});

export const meResponseSchema = envelopeSchema(meSchema);

/** `GET /api/v1/dev/actors`: allowlisted fixture actors for the local actor switcher. */
export const devActorListResponseSchema = envelopeSchema(z.array(fixtureActorSchema));

/** `POST /api/v1/dev/session` body; responds with `meResponseSchema`. */
export const devSessionInputSchema = z.strictObject({
  actorId: idSchema,
});

export type ActorDto = z.infer<typeof actorSchema>;
export type MeDto = z.infer<typeof meSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type DevActorListResponse = z.infer<typeof devActorListResponseSchema>;
export type DevSessionInput = z.infer<typeof devSessionInputSchema>;
