import { z } from 'zod';

import { envelopeSchema } from './common/envelope.js';
import { idSchema } from './common/ids.js';
import { profilePhotoUrlSchema } from './profile-photo.js';

export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);

export const WORKSPACE_SLUG_RESERVED = ['app', 'api', 'auth', 'login', 'logout', 'signin', 'signup', 'join', 'new', 'workspaces', 'settings', 'admin', 'support', 'help', 'assets', 'static', 'reports', 'projects', 'me', 'home', 'healthz', 'www'] as const;
const uuidShapedSlug = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Stable persisted syntax: future command restrictions must not invalidate stored links. */
export const persistedWorkspaceSlugSchema = z.string().min(3).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(value => !uuidShapedSlug.test(value));
/** URL references may use uppercase but never trim whitespace or repair malformed segments. */
export const workspaceSlugReferenceSchema = z.string().max(63).regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/).transform(value => value.toLowerCase()).pipe(persistedWorkspaceSlugSchema);
/** A URL label only; authorization and all stored references continue to use the UUID. */
export const workspaceSlugSchema = z.string().max(256).regex(/^[^\p{Cc}]*$/u)
  .transform(value => value.trim().toLowerCase())
  .pipe(z.string().min(3).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
  .refine(value => !uuidShapedSlug.test(value) && !(WORKSPACE_SLUG_RESERVED as readonly string[]).includes(value));
export const updateWorkspaceSlugInputSchema = z.object({
  slug: workspaceSlugSchema,
  expectedSlugRevision: z.number().int().positive(),
}).strict();
export type UpdateWorkspaceSlugInput = z.infer<typeof updateWorkspaceSlugInputSchema>;

/** A workspace as seen by the current actor; `role` is that actor's membership role. */
export const workspaceSchema = z.object({
  id: idSchema,
  name: z.string(),
  role: workspaceRoleSchema,
  /** IANA time zone, e.g. `Asia/Nicosia`. */
  timezone: z.string(),
  /** ISO weekday 1–7; omitted by older responses, which clients treat as Monday. No default changes stored/replayed results. */
  weekStart: z.number().int().min(1).max(7).optional(),
  slug: persistedWorkspaceSlugSchema.nullable().optional(),
  slugRevision: z.number().int().positive().optional(),
  /** Reserved former addresses, visible only to current workspace members. */
  slugAliases: z.array(persistedWorkspaceSlugSchema).max(100).optional(),
});

export const membershipSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  userId: idSchema,
  displayName: z.string(),
  /** A schedulable invited person has no account/access until the addressed invitation is accepted. */
  pending: z.boolean().optional(),
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
