import type { WorkspaceRole } from './capabilities.js';
import type { ActorKind } from './context.js';

export type MembershipState = 'active' | 'revoked';

export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ActorKind;
  /** Safe normalized profile photo URL; null or absent renders initials. */
  readonly avatarUrl?: string | null;
}

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  /** IANA time zone name. */
  readonly timezone: string;
  /** ISO weekday the planning week starts on: 1 = Monday … 7 = Sunday. */
  readonly weekStart: number;
}

export interface MembershipRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly displayName: string;
  /** The member user's current profile photo URL. */
  readonly avatarUrl?: string | null;
  readonly role: WorkspaceRole;
  readonly state: MembershipState;
  readonly revision: number;
}

export interface WorkspaceAccessRecord {
  readonly workspace: WorkspaceRecord;
  readonly membership: MembershipRecord;
}

/**
 * Persistence port for identity and membership lookups. Implementations must
 * scope every query by the given IDs and must not cache memberships across
 * requests: authorization is evaluated on every execution.
 */
export interface AccessRepository {
  findUser(userId: string): Promise<UserRecord | null>;
  /** Returns the users that exist, in no particular order. */
  findUsers(userIds: readonly string[]): Promise<readonly UserRecord[]>;
  /** Workspaces where the user has an active membership. */
  listAccessibleWorkspaces(userId: string): Promise<readonly WorkspaceAccessRecord[]>;
  /** The membership of the user in the workspace in any state, or null when absent. */
  findWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceAccessRecord | null>;
  /** Active memberships of the workspace, owner → viewer, then by display name. */
  listActiveMemberships(workspaceId: string): Promise<readonly MembershipRecord[]>;
}
