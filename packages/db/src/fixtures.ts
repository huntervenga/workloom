/**
 * Stable synthetic demo fixtures. Names are deliberately artificial; no real
 * people or organizations. Importable without a database driver via
 * `@workloom/db/fixtures`.
 *
 * Team workspace: six users (owner, admin, three members, viewer).
 * Outside workspace: only the outsider. No user belongs to both.
 */
import type { WorkspaceRole } from '@workloom/domain';

export const FIXTURE_USER_IDS = {
  owner: '5eed0000-0000-4000-8000-000000000101',
  admin: '5eed0000-0000-4000-8000-000000000102',
  memberA: '5eed0000-0000-4000-8000-000000000103',
  memberB: '5eed0000-0000-4000-8000-000000000104',
  memberC: '5eed0000-0000-4000-8000-000000000105',
  viewer: '5eed0000-0000-4000-8000-000000000106',
  outsider: '5eed0000-0000-4000-8000-000000000107',
} as const;

export const FIXTURE_WORKSPACE_IDS = {
  team: '5eed0000-0000-4000-8000-000000000201',
  outside: '5eed0000-0000-4000-8000-000000000202',
} as const;

export const FIXTURE_MEMBERSHIP_IDS = {
  teamOwner: '5eed0000-0000-4000-8000-000000000301',
  teamAdmin: '5eed0000-0000-4000-8000-000000000302',
  teamMemberA: '5eed0000-0000-4000-8000-000000000303',
  teamMemberB: '5eed0000-0000-4000-8000-000000000304',
  teamMemberC: '5eed0000-0000-4000-8000-000000000305',
  teamViewer: '5eed0000-0000-4000-8000-000000000306',
  outsideOwner: '5eed0000-0000-4000-8000-000000000307',
} as const;

/** Actor used by the development identity adapter when no session selects another. */
export const DEFAULT_DEV_ACTOR_ID: string = FIXTURE_USER_IDS.owner;

export interface FixtureUser {
  readonly id: string;
  readonly displayName: string;
  readonly kind: 'fixture';
}

export interface FixtureWorkspace {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly weekStart: number;
}

export interface FixtureMembership {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
}

export const DEMO_USERS: readonly FixtureUser[] = [
  { id: FIXTURE_USER_IDS.owner, displayName: 'Synthetic Owner', kind: 'fixture' },
  { id: FIXTURE_USER_IDS.admin, displayName: 'Synthetic Admin', kind: 'fixture' },
  { id: FIXTURE_USER_IDS.memberA, displayName: 'Synthetic Member A', kind: 'fixture' },
  { id: FIXTURE_USER_IDS.memberB, displayName: 'Synthetic Member B', kind: 'fixture' },
  { id: FIXTURE_USER_IDS.memberC, displayName: 'Synthetic Member C', kind: 'fixture' },
  { id: FIXTURE_USER_IDS.viewer, displayName: 'Synthetic Viewer', kind: 'fixture' },
  { id: FIXTURE_USER_IDS.outsider, displayName: 'Synthetic Outsider', kind: 'fixture' },
];

export const DEMO_WORKSPACES: readonly FixtureWorkspace[] = [
  { id: FIXTURE_WORKSPACE_IDS.team, name: 'Synthetic Team Workspace', timezone: 'Asia/Nicosia', weekStart: 1 },
  { id: FIXTURE_WORKSPACE_IDS.outside, name: 'Synthetic Outside Workspace', timezone: 'UTC', weekStart: 1 },
];

export const DEMO_MEMBERSHIPS: readonly FixtureMembership[] = [
  { id: FIXTURE_MEMBERSHIP_IDS.teamOwner, workspaceId: FIXTURE_WORKSPACE_IDS.team, userId: FIXTURE_USER_IDS.owner, role: 'owner' },
  { id: FIXTURE_MEMBERSHIP_IDS.teamAdmin, workspaceId: FIXTURE_WORKSPACE_IDS.team, userId: FIXTURE_USER_IDS.admin, role: 'admin' },
  { id: FIXTURE_MEMBERSHIP_IDS.teamMemberA, workspaceId: FIXTURE_WORKSPACE_IDS.team, userId: FIXTURE_USER_IDS.memberA, role: 'member' },
  { id: FIXTURE_MEMBERSHIP_IDS.teamMemberB, workspaceId: FIXTURE_WORKSPACE_IDS.team, userId: FIXTURE_USER_IDS.memberB, role: 'member' },
  { id: FIXTURE_MEMBERSHIP_IDS.teamMemberC, workspaceId: FIXTURE_WORKSPACE_IDS.team, userId: FIXTURE_USER_IDS.memberC, role: 'member' },
  { id: FIXTURE_MEMBERSHIP_IDS.teamViewer, workspaceId: FIXTURE_WORKSPACE_IDS.team, userId: FIXTURE_USER_IDS.viewer, role: 'viewer' },
  {
    id: FIXTURE_MEMBERSHIP_IDS.outsideOwner,
    workspaceId: FIXTURE_WORKSPACE_IDS.outside,
    userId: FIXTURE_USER_IDS.outsider,
    role: 'owner',
  },
];

/** Allowlist for the development identity adapter, in display order. */
export const FIXTURE_ACTOR_IDS: readonly string[] = DEMO_USERS.map((user) => user.id);

export function isFixtureActorId(value: string): boolean {
  return FIXTURE_ACTOR_IDS.includes(value.toLowerCase());
}
