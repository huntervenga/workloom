import { describe, expect, it } from 'vitest';
import { configureCutoffInputSchema, cutoffJobSchema, cutoffReadinessSchema, retryCutoffInputSchema } from './cutoff.js';
import { createPlanningPeriodInputSchema, planningPeriodSchema } from './planning.js';
const id = 'abcdef00-0000-4000-8000-000000000001';
const job = { schemaVersion: 1, requestId: id, workspaceId: id, projectId: id, periodId: id, grantId: id, grantRevision: 1, periodRevision: 1, cutoffAt: '2026-10-16T12:00:00.000Z', sourceManifestHash: 'a'.repeat(64) };
describe('explicit cutoff contracts', () => {
  it('requires explicit enablement and optimistic source/grant guards', () => {
    expect(configureCutoffInputSchema.parse({ expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true })).toEqual({ expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true });
    expect(configureCutoffInputSchema.safeParse({ expectedPeriodRevision: 1, expectedGrantRevision: 0 }).success).toBe(false);
    expect(retryCutoffInputSchema.safeParse({ expectedPeriodRevision: 1, expectedGrantRevision: 0 }).success).toBe(false);
    expect(configureCutoffInputSchema.safeParse({ expectedPeriodRevision: 1, expectedGrantRevision: 0, enabled: true, authorizerUserId: id }).success).toBe(false);
  });
  it('accepts only the exact versioned stored-source job with canonical IDs', () => {
    expect(cutoffJobSchema.parse({ ...job, periodId: id.toUpperCase() })).toEqual(job);
    for (const extra of [{ actorUserId: id }, { role: 'owner' }, { serverNow: job.cutoffAt }, { bearer: 'not-a-real-secret' }]) expect(cutoffJobSchema.safeParse({ ...job, ...extra }).success).toBe(false);
    expect(cutoffJobSchema.safeParse({ ...job, schemaVersion: 2 }).success).toBe(false);
    expect(cutoffJobSchema.safeParse({ ...job, grantRevision: 0 }).success).toBe(false);
  });
  it('does not inject automation fields into existing period input or stored DTO schemas', () => {
    const old = createPlanningPeriodInputSchema.parse({ projectId: id, name: 'Legacy period', localStart: '2026-10-12', timezone: 'UTC', cutoffAt: job.cutoffAt });
    expect(Object.hasOwn(old, 'cutoffAutomation')).toBe(false);
    expect(Object.hasOwn(planningPeriodSchema.shape, 'automation')).toBe(false);
  });
});


it('requires persisted frozen state and a baseline together before labeling readiness frozen', () => {
  const base = { periodId: id, periodRevision: 1, persistedState: 'planning', serverNow: job.cutoffAt, cutoffAt: job.cutoffAt,
    baseline: null, automation: { state: 'not_configured', grant: null }, readiness: 'overdue_waiting', missingCount: 0,
    blockedCount: 0, blockers: [], truncated: false, latestRequest: null, latestOutcome: null,
    actions: { canConfigure: true, canRetry: false, canFreezeProject: true } };
  expect(cutoffReadinessSchema.safeParse(base).success).toBe(true);
  expect(cutoffReadinessSchema.safeParse({ ...base, readiness: 'frozen' }).success).toBe(false);
  expect(cutoffReadinessSchema.safeParse({ ...base, persistedState: 'frozen', readiness: 'frozen' }).success).toBe(false);
  const baseline = { id, frozenAt: job.cutoffAt, requestedCutoffAt: job.cutoffAt };
  expect(cutoffReadinessSchema.safeParse({ ...base, baseline }).success).toBe(false);
  expect(cutoffReadinessSchema.safeParse({ ...base, baseline, persistedState: 'frozen', readiness: 'frozen' }).success).toBe(true);
});
