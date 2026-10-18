import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInvitationMaterial } from './invitationMaterial';
afterEach(() => vi.unstubAllGlobals());
describe('invitation material', () => {
  it('uses 32 random bytes, hashes the versioned preimage and keeps the raw credential out of the server payload', async () => {
    let generation = 0;
    const digest = vi.fn(async () => new Uint8Array(32).fill(9).buffer);
    vi.stubGlobal('crypto', { randomUUID: () => `${++generation}3333333-3333-4333-8333-333333333333`, getRandomValues: (bytes: Uint8Array) => bytes.fill(7), subtle: { digest } });
    const first = await createInvitationMaterial('member', 86400);
    const second = await createInvitationMaterial('member', 86400);
    const url = new URL(first.link);
    const [id, secret] = url.hash.slice(1).split('.');
    expect(url.pathname).toBe('/app/join'); expect(url.search).toBe('');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const decoded = Uint8Array.from(atob((secret as string).replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
    expect(decoded).toHaveLength(32);
    const hex = Array.from(decoded, n => n.toString(16).padStart(2, '0')).join('');
    expect(digest.mock.calls).toHaveLength(2);
    const firstDigest = digest.mock.calls[0] as unknown as [string, Uint8Array];
    expect(firstDigest[0]).toBe('SHA-256');
    expect(new TextDecoder().decode(firstDigest[1])).toBe(`workloom-invite:v1:${id}:${hex}`);
    const expected = '09'.repeat(32);
    expect(first.input).toEqual({ id, hashVersion: 1, secretHash: expected, role: 'member', expiresInSeconds: 86400 });
    expect(JSON.stringify(first.input).includes(secret as string)).toBe(false);
    expect(first.link === second.link).toBe(false);
  });
  it('has no weak entropy fallback when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', {});
    await expect(createInvitationMaterial('viewer', 604800)).rejects.toThrow();
  });
});
