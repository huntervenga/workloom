import { inArray } from 'drizzle-orm';

import { isDatabase, type Database, type WorkloomExecutor } from '../client.js';
import { DEMO_MEMBERSHIPS, DEMO_USERS, DEMO_WORKSPACES } from '../fixtures.js';
import { memberships, users, workspaces } from '../schema.js';

export interface SeedTableResult {
  readonly expected: number;
  readonly inserted: number;
  readonly alreadyPresent: number;
}

export interface DemoSeedResult {
  readonly users: SeedTableResult;
  readonly workspaces: SeedTableResult;
  readonly memberships: SeedTableResult;
  /**
   * Fixture rows that exist but differ from the canonical fixture (for example
   * a membership revoked during local testing). The seed reports them and
   * leaves them untouched: it never overwrites or deletes existing rows.
   */
  readonly drift: readonly string[];
}

function tableResult(expected: number, inserted: number): SeedTableResult {
  return { expected, inserted, alreadyPresent: expected - inserted };
}

/**
 * Idempotent synthetic demo seed in one transaction. Inserts missing fixture
 * rows with `ON CONFLICT DO NOTHING`; never clears, updates or deletes data,
 * so repeated runs keep identical counts and local edits survive.
 * Callers are responsible for environment guards (see the db:seed:demo CLI).
 */
export async function seedDemoData(source: Database | WorkloomExecutor): Promise<DemoSeedResult> {
  const db: WorkloomExecutor = isDatabase(source) ? source.db : source;

  return db.transaction(async (tx) => {
    const insertedUsers = await tx
      .insert(users)
      .values(DEMO_USERS.map((user) => ({ id: user.id, displayName: user.displayName, kind: user.kind })))
      .onConflictDoNothing()
      .returning({ id: users.id });

    const insertedWorkspaces = await tx
      .insert(workspaces)
      .values(
        DEMO_WORKSPACES.map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          timezone: workspace.timezone,
          weekStart: workspace.weekStart,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: workspaces.id });

    const insertedMemberships = await tx
      .insert(memberships)
      .values(
        DEMO_MEMBERSHIPS.map((membership) => ({
          id: membership.id,
          workspaceId: membership.workspaceId,
          userId: membership.userId,
          role: membership.role,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: memberships.id });

    const drift: string[] = [];

    const userRows = await tx
      .select({ id: users.id, displayName: users.displayName, kind: users.kind })
      .from(users)
      .where(inArray(users.id, DEMO_USERS.map((user) => user.id)));
    for (const fixture of DEMO_USERS) {
      const row = userRows.find((candidate) => candidate.id === fixture.id);
      if (row === undefined) {
        drift.push(`user ${fixture.id} is missing`);
      } else if (row.displayName !== fixture.displayName || row.kind !== fixture.kind) {
        drift.push(`user ${fixture.id} differs from the fixture`);
      }
    }

    const workspaceRows = await tx
      .select({ id: workspaces.id, name: workspaces.name, timezone: workspaces.timezone, weekStart: workspaces.weekStart })
      .from(workspaces)
      .where(inArray(workspaces.id, DEMO_WORKSPACES.map((workspace) => workspace.id)));
    for (const fixture of DEMO_WORKSPACES) {
      const row = workspaceRows.find((candidate) => candidate.id === fixture.id);
      if (row === undefined) {
        drift.push(`workspace ${fixture.id} is missing`);
      } else if (row.name !== fixture.name || row.timezone !== fixture.timezone || row.weekStart !== fixture.weekStart) {
        drift.push(`workspace ${fixture.id} differs from the fixture`);
      }
    }

    const membershipRows = await tx
      .select({
        id: memberships.id,
        workspaceId: memberships.workspaceId,
        userId: memberships.userId,
        role: memberships.role,
        state: memberships.state,
      })
      .from(memberships)
      .where(inArray(memberships.id, DEMO_MEMBERSHIPS.map((membership) => membership.id)));
    for (const fixture of DEMO_MEMBERSHIPS) {
      const row = membershipRows.find((candidate) => candidate.id === fixture.id);
      if (row === undefined) {
        drift.push(`membership ${fixture.id} is missing (another row may hold its workspace/user pair)`);
      } else if (
        row.workspaceId !== fixture.workspaceId ||
        row.userId !== fixture.userId ||
        row.role !== fixture.role ||
        row.state !== 'active'
      ) {
        drift.push(`membership ${fixture.id} differs from the fixture (role ${row.role}, state ${row.state})`);
      }
    }

    return {
      users: tableResult(DEMO_USERS.length, insertedUsers.length),
      workspaces: tableResult(DEMO_WORKSPACES.length, insertedWorkspaces.length),
      memberships: tableResult(DEMO_MEMBERSHIPS.length, insertedMemberships.length),
      drift,
    };
  });
}
