import { idSchema } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DEV_ACTOR_ID,
  DEMO_MEMBERSHIPS,
  DEMO_USERS,
  DEMO_WORKSPACES,
  FIXTURE_ACTOR_IDS,
  FIXTURE_USER_IDS,
  FIXTURE_WORKSPACE_IDS,
  isFixtureActorId,
} from './fixtures.js';

describe('demo fixtures', () => {
  it('uses unique RFC 9562 UUIDs accepted by the contracts', () => {
    const ids = [...DEMO_USERS, ...DEMO_WORKSPACES, ...DEMO_MEMBERSHIPS].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(idSchema.safeParse(id).success).toBe(true);
    }
  });

  it('has six team users with the documented roles and one outsider', () => {
    const team = DEMO_MEMBERSHIPS.filter((membership) => membership.workspaceId === FIXTURE_WORKSPACE_IDS.team);
    expect(team.map((membership) => membership.role)).toEqual(['owner', 'admin', 'member', 'member', 'member', 'viewer']);
    const outside = DEMO_MEMBERSHIPS.filter((membership) => membership.workspaceId === FIXTURE_WORKSPACE_IDS.outside);
    expect(outside.map((membership) => [membership.userId, membership.role])).toEqual([[FIXTURE_USER_IDS.outsider, 'owner']]);
  });

  it('has no cross-workspace membership and one membership per workspace/user pair', () => {
    const workspacesByUser = new Map<string, Set<string>>();
    for (const membership of DEMO_MEMBERSHIPS) {
      const set = workspacesByUser.get(membership.userId) ?? new Set<string>();
      expect(set.has(membership.workspaceId)).toBe(false);
      set.add(membership.workspaceId);
      workspacesByUser.set(membership.userId, set);
    }
    for (const workspaces of workspacesByUser.values()) {
      expect(workspaces.size).toBe(1);
    }
    expect(workspacesByUser.size).toBe(DEMO_USERS.length);
  });

  it('uses explicitly synthetic names', () => {
    for (const user of DEMO_USERS) expect(user.displayName).toMatch(/^Synthetic /);
    for (const workspace of DEMO_WORKSPACES) expect(workspace.name).toMatch(/^Synthetic /);
  });

  it('allowlists exactly the fixture users and includes the default actor', () => {
    expect(FIXTURE_ACTOR_IDS).toEqual(DEMO_USERS.map((user) => user.id));
    expect(isFixtureActorId(DEFAULT_DEV_ACTOR_ID)).toBe(true);
    expect(isFixtureActorId(DEFAULT_DEV_ACTOR_ID.toUpperCase())).toBe(true);
    expect(isFixtureActorId('5eed0000-0000-4000-8000-000000000999')).toBe(false);
  });
});
