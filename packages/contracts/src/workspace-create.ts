import { z } from 'zod';

/** Mirrors the `workspaces_timezone_format` check; Intl then rejects unknown zones. */
const TIMEZONE_FORMAT = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

export function isSupportedWorkspaceTimezone(value: string): boolean {
  if (value.length > 64 || !TIMEZONE_FORMAT.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Body of POST /api/v1/workspaces. Only name and time zone are client-selected;
 * the owner, actor, IDs, week start and permission epoch are always server-owned.
 */
export const createWorkspaceInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !value.includes('\0'), { message: 'Workspace name contains an invalid character.' }),
  timezone: z.string().max(64).refine(isSupportedWorkspaceTimezone, { message: 'Unknown IANA time zone.' }),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;
