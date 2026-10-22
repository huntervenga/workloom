import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.js';

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
  it('never remembers more than maxKeys keys', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (let index = 0; index < 50; index += 1) limiter.check(`k${index}`);
    expect(limiter.check('k49').allowed).toBe(false);
    expect(limiter.check('k0').allowed).toBe(true);
  });
});
