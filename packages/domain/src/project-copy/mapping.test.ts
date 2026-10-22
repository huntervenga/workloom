import { describe, expect, it } from 'vitest';
import { derivedId, remapSettings, shiftDate, suggestNextProjectName } from './mapping.js';

/** Stand-in for SHA-256: any deterministic function that spreads its input over 64 hex digits. */
const digest = (value: string) => {
  let hex = '';
  for (let round = 0; hex.length < 64; round += 1) {
    let h = 2166136261 ^ round;
    for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    hex += (h >>> 0).toString(16).padStart(8, '0');
  }
  return hex.slice(0, 64);
};
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222', C = '33333333-3333-4333-8333-333333333333';

describe('project copy mapping', () => {
  it('replaces known ids anywhere in a settings document and leaves people and tags alone', () => {
    const ids = new Map([[A, B]]);
    const doc = { fieldId: A, nested: [{ ids: [A.toUpperCase(), C] }], filters: { tagIds: [C], assignee: { kind: 'member', membershipId: C } }, text: `mentions ${A} inline` };
    expect(remapSettings(doc, ids, 0)).toEqual({ fieldId: B, nested: [{ ids: [B, C] }], filters: { tagIds: [C], assignee: { kind: 'member', membershipId: C } }, text: `mentions ${A} inline` });
  });
  it('moves every { from, to } date pair and nothing else', () => {
    const doc = { dateRange: { source: { kind: 'due_date' }, from: '2026-10-19', to: '2026-10-25' }, other: { from: 'x', to: '2026-10-25' }, plain: '2026-10-19' };
    expect(remapSettings(doc, new Map(), 7)).toEqual({ dateRange: { source: { kind: 'due_date' }, from: '2026-10-26', to: '2026-11-01' }, other: { from: 'x', to: '2026-10-25' }, plain: '2026-10-19' });
    expect(remapSettings(doc, new Map(), 0)).toEqual(doc);
  });
  it('shifts across month ends and keeps dates that would leave the supported years', () => {
    expect(shiftDate('2026-12-28', 7)).toBe('2027-01-04');
    expect(shiftDate('2200-12-30', 7)).toBe('2200-12-30');
    expect(shiftDate('not a date', 7)).toBe('not a date');
  });
  it('derives stable, distinct, well-formed ids from the operation and the original', () => {
    const one = derivedId(digest, 'op-1', A), again = derivedId(digest, 'op-1', A.toUpperCase());
    expect(one).toBe(again);
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(derivedId(digest, 'op-2', A)).not.toBe(one);
    expect(derivedId(digest, 'op-1', B)).not.toBe(one);
  });
  it('suggests the next number and week dates for a weekly project name', () => {
    expect(suggestNextProjectName('42 week (since 19 October 2026) Hour-Based Planning')).toBe('43 week (since 26 October 2026) Hour-Based Planning');
    expect(suggestNextProjectName('52 week (since 28 December 2026) Plan')).toBe('53 week (since 4 January 2027) Plan');
    expect(suggestNextProjectName('Launch')).toBe('Launch (copy)');
  });
});
