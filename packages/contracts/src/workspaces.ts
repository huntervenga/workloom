import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { profilePhotoUrlSchema } from './profile-photo.js';

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

/** A workspace as seen by the current actor; `role` is that actor's membership role. */
export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string(),
  role: workspaceRoleSchema,
  /** IANA time zone, e.g. `Asia/Nicosia`. */
  timezone: z.string(),
});

export const membershipSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  displayName: z.string(),
  /** The member user's verified profile photo; absent or null renders initials. */
  avatarUrl: profilePhotoUrlSchema.nullable().optional(),
  role: workspaceRoleSchema,
});

export const workspaceListResponseSchema = envelopeSchema(z.array(workspaceSchema));
export const workspaceResponseSchema = envelopeSchema(workspaceSchema);
export const membershipListResponseSchema = envelopeSchema(z.array(membershipSchema));

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type WorkspaceDto = z.infer<typeof workspaceSchema>;
export type MembershipDto = z.infer<typeof membershipSchema>;
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;
export type MembershipListResponse = z.infer<typeof membershipListResponseSchema>;
