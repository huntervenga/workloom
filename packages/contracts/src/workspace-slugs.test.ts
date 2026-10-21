import { describe, expect, it } from 'vitest';
import { workspaceSlugReferenceSchema, persistedWorkspaceSlugSchema, workspaceSlugSchema, updateWorkspaceSlugInputSchema, workspaceSchema } from './workspaces.js';

describe('workspace URL labels', () => {
  it('normalizes case and surrounding spaces without rewriting internal IDs', () => {
    expect(workspaceSlugSchema.parse('  Balancy-Team  ')).toBe('balancy-team');
    expect(updateWorkspaceSlugInputSchema.parse({ slug: 'BALANCY', expectedSlugRevision: 1 })).toEqual({ slug: 'balancy', expectedSlugRevision: 1 });
  });
  it.each(['ab', '-team', 'team-', 'team--one', 'team/name', 'team name', 'Компания', 'a'.repeat(64), 'app', 'api', 'join', '00000000-0000-4000-8000-000000000001', 'team\n', 'te\0am'])('rejects invalid, reserved or ambiguous address %j', slug => {
    expect(workspaceSlugSchema.safeParse(slug).success).toBe(false);
  });
  it('separates strict URL syntax and persisted values from new-address policy', () => {
    expect(workspaceSlugReferenceSchema.parse('BALANCY')).toBe('balancy');
    for (const value of [' balancy ', 'balancy/project', 'balancy\n', 'balancy--team']) expect(workspaceSlugReferenceSchema.safeParse(value).success).toBe(false);
    expect(persistedWorkspaceSlugSchema.parse('admin')).toBe('admin');
    expect(workspaceSlugSchema.safeParse('admin').success).toBe(false);
  });
  it('keeps optional fields absent in historical workspace results', () => {
    const legacy = { id: '00000000-0000-4000-8000-000000000001', name: 'Legacy', role: 'owner', timezone: 'UTC' };
    expect(workspaceSchema.parse(legacy)).toEqual(legacy);
    expect(updateWorkspaceSlugInputSchema.safeParse({ slug: 'team', expectedSlugRevision: 0 }).success).toBe(false);
    expect(updateWorkspaceSlugInputSchema.safeParse({ slug: 'team', expectedSlugRevision: 1, owner: true }).success).toBe(false);
  });
});
