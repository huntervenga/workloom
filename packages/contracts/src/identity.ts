import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';

/** Server-resolved actor. Before shared Auth (P6) only synthetic fixture actors exist. */
export const actorSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  kind: z.literal('fixture'),
});

/** `GET /api/v1/me`: the UI shows the local-mode indicator from `authMode`. */
export const meSchema = z.object({
  actor: actorSchema,
  authMode: z.literal('dev'),
});

export const meResponseSchema = envelopeSchema(meSchema);

/** `GET /api/v1/dev/actors`: allowlisted fixture actors for the local actor switcher. */
export const devActorListResponseSchema = envelopeSchema(z.array(actorSchema));

/** `POST /api/v1/dev/session` body; responds with `meResponseSchema`. */
export const devSessionInputSchema = z.strictObject({
  actorId: idSchema,
});

export type ActorDto = z.infer<typeof actorSchema>;
export type MeDto = z.infer<typeof meSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type DevActorListResponse = z.infer<typeof devActorListResponseSchema>;
export type DevSessionInput = z.infer<typeof devSessionInputSchema>;
