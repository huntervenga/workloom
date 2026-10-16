/**
 * The single role → capability policy table (docs/03-domain-and-data.md §3).
 * API, MCP, jobs and imports must authorize through this module only.
 *
 * Workspace-level capabilities do not grant access to private task content:
 * private tasks additionally require an explicit TaskAccessGrant (P1).
 */
import type { WorkspaceRole as ContractWorkspaceRole } from '@workloom/contracts';

export const WORKSPACE_ROLES = ['owner', 'admin', 'member', 'viewer'] as const satisfies readonly ContractWorkspaceRole[];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const CAPABILITIES = [
  'workspace.read',
  'members.read',
  'members.manage',
  'task.read',
  'task.edit',
  'time.write_self',
  'time.write_others',
  'plan.write_self',
  'plan.write_others',
  'plan.freeze_self',
  'plan.freeze_project',
  'plan.adjust',
  'fields.manage',
  'reports.read',
  'dependencies.manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Stage in which a capability first guards a real command. Capabilities of
 * later stages are documented here so the table stays in one place; no
 * command for them exists yet.
 */
export const CAPABILITY_STAGE: Readonly<Record<Capability, 'P0' | 'P1' | 'P2' | 'P4' | 'P6'>> = {
  'workspace.read': 'P0',
  'members.read': 'P0',
  'members.manage': 'P6',
  'task.read': 'P1',
  'task.edit': 'P1',
  'time.write_self': 'P2',
  'time.write_others': 'P2',
  'plan.write_self': 'P2',
  'plan.write_others': 'P2',
  'plan.freeze_self': 'P2',
  'plan.freeze_project': 'P2',
  'plan.adjust': 'P2',
  'fields.manage': 'P1',
  'reports.read': 'P2',
  'dependencies.manage':'P4',
};

const MEMBER_CAPABILITIES: readonly Capability[] = [
  'workspace.read',
  'members.read',
  'task.read',
  'task.edit',
  'time.write_self',
  'plan.write_self',
  'plan.freeze_self',
  'reports.read',
];

const VIEWER_CAPABILITIES: readonly Capability[] = ['workspace.read', 'members.read', 'task.read', 'reports.read'];

const ROLE_CAPABILITIES: Readonly<Record<WorkspaceRole, ReadonlySet<Capability>>> = {
  owner: new Set(CAPABILITIES),
  admin: new Set(CAPABILITIES),
  member: new Set(MEMBER_CAPABILITIES),
  viewer: new Set(VIEWER_CAPABILITIES),
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === 'string' && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function roleHasCapability(role: WorkspaceRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}

/** Capabilities of a role in the stable order of {@link CAPABILITIES}. */
export function capabilitiesForRole(role: WorkspaceRole): readonly Capability[] {
  const granted = ROLE_CAPABILITIES[role];
  return CAPABILITIES.filter((capability) => granted.has(capability));
}
