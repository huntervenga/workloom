import { describe, expect, it } from 'vitest';
import { actorSchema, devActorListResponseSchema, meSchema } from './identity.js';
const fixture = { id: '01000000-0000-4000-8000-000000000001', displayName: 'Synthetic', kind: 'fixture' as const };
describe('shared identity extends me without broadening dev discovery', () => {
  it('preserves the legacy dev response and accepts an explicit real/shared principal without defaults', () => {
    expect(meSchema.parse({ actor: fixture, authMode: 'dev' })).toEqual({ actor: fixture, authMode: 'dev' });
    const real = { ...fixture, kind: 'real' };
    expect(actorSchema.parse(real)).toEqual(real);
    expect(meSchema.parse({ actor: real, authMode: 'shared' })).toEqual({ actor: real, authMode: 'shared' });
    expect(meSchema.safeParse({ actor: fixture }).success).toBe(false);
  });
  it('keeps the synthetic actor-list payload fixture-only', () => {
    const meta = { requestId: 'identity-contract' };
    expect(devActorListResponseSchema.safeParse({ data: [fixture], meta }).success).toBe(true);
    expect(devActorListResponseSchema.safeParse({ data: [{ ...fixture, kind: 'real' }], meta }).success).toBe(false);
  });
});
