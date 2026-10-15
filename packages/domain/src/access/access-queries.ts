import { notFoundError, capabilityRequiredError, unauthenticatedError } from '../errors.js';
import { roleHasCapability, type Capability, type WorkspaceRole } from './capabilities.js';
import type { ActorContext, CommandContext } from './context.js';
import type { AccessRepository, MembershipRecord, UserRecord, WorkspaceAccessRecord } from './ports.js';

export interface WorkspaceView {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly weekStart: number;
  /** Role of the current actor in this workspace. */
  readonly role: WorkspaceRole;
}

export type WorkspaceScope = Pick<CommandContext, 'actor' | 'workspaceId'>;

/**
 * Pure authorization decision for a loaded membership. Absent and revoked
 * memberships produce the identical NOT_FOUND error so that callers cannot
 * learn whether a workspace exists. A visible workspace without the capability
 * produces CAPABILITY_REQUIRED.
 */
export function authorizeLoadedAccess(
  access: WorkspaceAccessRecord | null,
  capability: Capability,
): WorkspaceAccessRecord {
  if (access === null || access.membership.state !== 'active') {
    throw notFoundError();
  }
  if (!roleHasCapability(access.membership.role, capability)) {
    throw capabilityRequiredError();
  }
  return access;
}

/** Loads and authorizes the actor's membership. Called on every execution; never cached. */
export async function authorizeWorkspace(
  repository: AccessRepository,
  scope: WorkspaceScope,
  capability: Capability,
): Promise<WorkspaceAccessRecord> {
  const access = await repository.findWorkspaceAccess(scope.workspaceId, scope.actor.userId);
  return authorizeLoadedAccess(access, capability);
}

/** Confirms that the resolved actor still exists in persistence. */
export async function getCurrentActor(repository: AccessRepository, context: ActorContext): Promise<UserRecord> {
  const user = await repository.findUser(context.actor.userId);
  if (user === null) {
    throw unauthenticatedError();
  }
  return user;
}

export async function listWorkspacesForActor(
  repository: AccessRepository,
  context: ActorContext,
): Promise<readonly WorkspaceView[]> {
  const records = await repository.listAccessibleWorkspaces(context.actor.userId);
  return records
    .filter(
      (record) =>
        record.membership.state === 'active' &&
        sameId(record.membership.userId, context.actor.userId) &&
        roleHasCapability(record.membership.role, 'workspace.read'),
    )
    .map(toWorkspaceView);
}

export async function getWorkspaceForActor(
  repository: AccessRepository,
  scope: WorkspaceScope,
): Promise<WorkspaceView> {
  return toWorkspaceView(await authorizeWorkspace(repository, scope, 'workspace.read'));
}

export async function listWorkspaceMembers(
  repository: AccessRepository,
  scope: WorkspaceScope,
): Promise<readonly MembershipRecord[]> {
  await authorizeWorkspace(repository, scope, 'members.read');
  const members = await repository.listActiveMemberships(scope.workspaceId);
  return members.filter((member) => sameId(member.workspaceId, scope.workspaceId) && member.state === 'active');
}

/** UUIDs compare case-insensitively, as in PostgreSQL; callers may pass non-canonical case. */
function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function toWorkspaceView(record: WorkspaceAccessRecord): WorkspaceView {
  return {
    id: record.workspace.id,
    name: record.workspace.name,
    timezone: record.workspace.timezone,
    weekStart: record.workspace.weekStart,
    role: record.membership.role,
  };
}
