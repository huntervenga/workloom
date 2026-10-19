import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_STAGE,
  WORKSPACE_ROLES,
  capabilitiesForRole,
  isWorkspaceRole,
  roleHasCapability,
} from './capabilities.js';

describe('role capability policy', () => {
  it('grants every capability to owner and admin', () => {
    for (const capability of CAPABILITIES) {
      expect(roleHasCapability('owner', capability)).toBe(true);
      expect(roleHasCapability('admin', capability)).toBe(true);
    }
  });

  it('lets every role read the workspace and its members', () => {
    for (const role of WORKSPACE_ROLES) {
      expect(roleHasCapability(role, 'workspace.read')).toBe(true);
      expect(roleHasCapability(role, 'members.read')).toBe(true);
    }
  });

  it('allows members to edit tasks and write their own time but not manage the workspace', () => {
    expect(roleHasCapability('member', 'task.edit')).toBe(true);
    expect(roleHasCapability('member', 'time.write_self')).toBe(true);
    expect(roleHasCapability('member', 'plan.freeze_self')).toBe(true);
    expect(roleHasCapability('member', 'time.write_others')).toBe(false);
    expect(roleHasCapability('member', 'plan.freeze_project')).toBe(false);
    expect(roleHasCapability('member', 'plan.adjust')).toBe(false);
    expect(roleHasCapability('member', 'fields.manage')).toBe(false);
    expect(roleHasCapability('member', 'members.manage')).toBe(false);
  });

  it('keeps viewers read-only', () => {
    expect(capabilitiesForRole('viewer')).toEqual(['workspace.read', 'members.read', 'task.read', 'reports.read', 'leave.read']);
    expect(roleHasCapability('viewer', 'task.edit')).toBe(false);
    expect(roleHasCapability('viewer', 'time.write_self')).toBe(false);
  });

  it('separates neutral availability, own requests, management and approval',()=>{expect(roleHasCapability('viewer','leave.read')).toBe(true);expect(roleHasCapability('viewer','leave.request_self')).toBe(false);expect(roleHasCapability('member','leave.request_self')).toBe(true);expect(roleHasCapability('member','leave.manage')).toBe(false);expect(roleHasCapability('member','leave.approve')).toBe(false);expect(roleHasCapability('admin','leave.approve')).toBe(true);});

  it('documents a stage for every capability', () => {
    expect(Object.keys(CAPABILITY_STAGE).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('recognizes only the four roles', () => {
    expect(isWorkspaceRole('owner')).toBe(true);
    expect(isWorkspaceRole('superuser')).toBe(false);
    expect(isWorkspaceRole(undefined)).toBe(false);
  });
});
