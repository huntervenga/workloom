import { describe, expect, it } from 'vitest';
import { createPublicRateLimiter, createRateLimiter } from './rate-limit.js';

describe('rate limiter', () => {
  it('allows the limit within a window, refuses the rest with a wait, and starts over afterwards', () => {
    let clock = 1_000;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 }, () => clock);
    expect([1, 2, 3].map(() => limiter.check('a').allowed)).toEqual([true, true, true]);
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.check('b').allowed).toBe(true);
    clock += 30_000;
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterSeconds: 30 });
    clock += 30_000;
    expect(limiter.check('a').allowed).toBe(true);
  });
  it('never resets a live counter when unseen keys exhaust the bounded key map', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    expect(limiter.check('k0').allowed).toBe(true);
    expect(limiter.check('k1').allowed).toBe(true);
    expect(limiter.check('k2').allowed).toBe(true);
    expect(limiter.check('overflow-a').allowed).toBe(true);
    expect(limiter.check('overflow-b').allowed).toBe(false);
    expect(limiter.check('k0').allowed).toBe(false);
  });
  it('charges a batch by its message count and validates internal costs', () => {
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limiter.check('a', 2).allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    expect(() => limiter.check('a', 0)).toThrow(/positive safe integer/);
  });
  it('keeps an address ceiling when callers rotate token keys and charges batches to both ceilings', () => {
    const rotated = createPublicRateLimiter({ addressLimit: 3, tokenLimit: 2, windowMs: 60_000 });
    expect(rotated.check('203.0.113.1', 'token-a').allowed).toBe(true);
    expect(rotated.check('203.0.113.1', 'token-b').allowed).toBe(true);
    expect(rotated.check('203.0.113.1', 'token-c').allowed).toBe(true);
    expect(rotated.check('203.0.113.1', 'token-d').allowed).toBe(false);

    const tokenBatch = createPublicRateLimiter({ addressLimit: 10, tokenLimit: 3, windowMs: 60_000 });
    expect(tokenBatch.check('203.0.113.2', 'token-a', 3).allowed).toBe(true);
    expect(tokenBatch.check('203.0.113.2', 'token-a').allowed).toBe(false);

    const addressBatch = createPublicRateLimiter({ addressLimit: 10, tokenLimit: 10, windowMs: 60_000 });
    expect(addressBatch.check('203.0.113.2', 'token-b', 7).allowed).toBe(true);
    expect(addressBatch.check('203.0.113.2', 'token-c', 4).allowed).toBe(false);
  });
});
