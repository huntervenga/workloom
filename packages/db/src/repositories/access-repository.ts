import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AccessRepository, MembershipRecord, UserRecord, WorkspaceAccessRecord } from '@workloom/domain';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { memberships, users, workspaces } from '../schema.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Malformed IDs cannot match any row; answering "absent" avoids a database cast error. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const accessColumns = {
  workspaceId: workspaces.id,
  workspaceName: workspaces.name,
  timezone: workspaces.timezone,
  weekStart: workspaces.weekStart,
  membershipId: memberships.id,
  userId: memberships.userId,
  displayName: users.displayName,
  role: memberships.role,
  state: memberships.state,
  revision: memberships.revision,
};

type AccessRow = {
  workspaceId: string;
  workspaceName: string;
  timezone: string;
  weekStart: number;
  membershipId: string;
  userId: string;
  displayName: string;
  role: MembershipRecord['role'];
  state: MembershipRecord['state'];
  revision: number;
};

function toAccessRecord(row: AccessRow): WorkspaceAccessRecord {
  return {
    workspace: { id: row.workspaceId, name: row.workspaceName, timezone: row.timezone, weekStart: row.weekStart },
    membership: {
      id: row.membershipId,
      workspaceId: row.workspaceId,
      userId: row.userId,
      displayName: row.displayName,
      role: row.role,
      state: row.state,
      revision: row.revision,
    },
  };
}

/**
 * Drizzle implementation of the domain AccessRepository. Every query is scoped
 * by explicit workspace/user IDs. Pass a transaction to read under a barrier.
 */
export function createAccessRepository(source: Database | WorkloomExecutor): AccessRepository {
  const db: WorkloomExecutor = isDatabase(source) ? source.db : source;

  function selectAccess() {
    return db
      .select(accessColumns)
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .innerJoin(users, eq(users.id, memberships.userId));
  }

  return {
    async findUser(userId): Promise<UserRecord | null> {
      if (!isUuid(userId)) {
        return null;
      }
      const [row] = await db
        .select({ id: users.id, displayName: users.displayName, kind: users.kind })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return row ?? null;
    },

    async findUsers(userIds): Promise<readonly UserRecord[]> {
      const ids = [...new Set(userIds.filter(isUuid))];
      if (ids.length === 0) {
        return [];
      }
      return db
        .select({ id: users.id, displayName: users.displayName, kind: users.kind })
        .from(users)
        .where(inArray(users.id, ids));
    },

    async listAccessibleWorkspaces(userId): Promise<readonly WorkspaceAccessRecord[]> {
      if (!isUuid(userId)) {
        return [];
      }
      const rows = await selectAccess()
        .where(and(eq(memberships.userId, userId), eq(memberships.state, 'active')))
        .orderBy(asc(workspaces.name), asc(workspaces.id));
      return rows.map(toAccessRecord);
    },

    async findWorkspaceAccess(workspaceId, userId): Promise<WorkspaceAccessRecord | null> {
      if (!isUuid(workspaceId) || !isUuid(userId)) {
        return null;
      }
      const [row] = await selectAccess()
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)))
        .limit(1);
      return row === undefined ? null : toAccessRecord(row);
    },

    async listActiveMemberships(workspaceId): Promise<readonly MembershipRecord[]> {
      if (!isUuid(workspaceId)) {
        return [];
      }
      const rows = await selectAccess()
        .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.state, 'active')))
        .orderBy(asc(memberships.role), asc(users.displayName), asc(memberships.id));
      return rows.map((row) => toAccessRecord(row).membership);
    },
  };
}
