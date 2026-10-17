import { describe, expect, it } from 'vitest';
import { originalPackageEstimateSchema, planningPackageSchema, planningSnapshotSchema } from './planning.js';

const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002', c = '00000000-0000-4000-8000-000000000003';
const target = { workspaceId: a, projectId: b, workPackageId: c };
const origin = { planBaselineId: a, periodId: b, periodLocalStart: '2026-10-12', scope: 'self', mode: 'cutoff', frozenAt: '2026-10-16T09:00:00.000Z', packageRevision: 1 };

describe('original package estimate read contract', () => {
  it('keeps not-captured, captured zero and original-unknown distinct', () => {
    const values = [
      { state: 'not_captured_yet', ...target },
      { state: 'captured', ...target, estimateMinutes: 0, packageBaselineId: a, acceptedAt: origin.frozenAt, provenance: 'first_known_plan_freeze', origin },
      { state: 'original_unknown', ...target, estimateMinutes: null, packageBaselineId: null, origin },
    ];
    for (const value of values) expect(originalPackageEstimateSchema.parse(value)).toEqual(value);
  });

  it('rejects a guessed unknown value, a captured null and provenance-free captures', () => {
    for (const value of [
      { state: 'original_unknown', ...target, estimateMinutes: 0, packageBaselineId: null, origin },
      { state: 'original_unknown', ...target, estimateMinutes: null, packageBaselineId: a, origin },
      { state: 'captured', ...target, estimateMinutes: null, packageBaselineId: a, acceptedAt: origin.frozenAt, provenance: 'first_known_plan_freeze', origin },
      { state: 'captured', ...target, estimateMinutes: 60, packageBaselineId: a, acceptedAt: origin.frozenAt, provenance: 'first_known_plan_freeze' },
      { state: 'captured', ...target, estimateMinutes: 60, packageBaselineId: a, acceptedAt: origin.frozenAt, provenance: 'late_fill', origin },
      { state: 'unknown', ...target },
    ]) expect(originalPackageEstimateSchema.safeParse(value).success).toBe(false);
  });

  it('strips any current estimate instead of presenting it as original', () => {
    expect(originalPackageEstimateSchema.parse({ state: 'not_captured_yet', ...target, estimateMinutes: 1200, currentEstimateMinutes: 1200 })).toEqual({ state: 'not_captured_yet', ...target });
  });

  it('leaves old package and snapshot JSON byte-compatible', () => {
    const pkg = { id: c, projectId: b, revision: 1, estimateMinutes: null, createdAt: origin.frozenAt, packageBaselineId: null, title: 'Old package' };
    expect(planningPackageSchema.parse(pkg)).toEqual(pkg);
    expect(Object.keys(planningPackageSchema.shape).sort()).toEqual(Object.keys(pkg).sort());
    expect(Object.keys(planningSnapshotSchema.shape)).not.toContain('originalEstimates');
  });
});
