import { describe, expect, it } from 'vitest';

import { DEV_SESSION_COOKIE, createDevSessionStore, readCookie, serializeSessionCookie } from './dev-sessions.js';

const ACTOR = '5eed0000-0000-4000-8000-000000000103';

describe('dev session store', () => {
  it('issues random opaque tokens that do not contain the actor ID', () => {
    const store = createDevSessionStore();
    const first = store.create(ACTOR);
    const second = store.create(ACTOR);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(ACTOR.slice(-6));
    expect(store.resolve(first)).toBe(ACTOR);
  });

  it('expires and revokes sessions', () => {
    let now = 1_000;
    const store = createDevSessionStore({ ttlMs: 100, now: () => now });
    const token = store.create(ACTOR);
    now = 1_099;
    expect(store.resolve(token)).toBe(ACTOR);
    now = 1_100;
    expect(store.resolve(token)).toBeNull();

    const other = store.create(ACTOR);
    store.revoke(other);
    expect(store.resolve(other)).toBeNull();
  });

  it('is bounded and evicts the oldest session', () => {
    const store = createDevSessionStore({ maxSessions: 2 });
    const a = store.create(ACTOR);
    const b = store.create(ACTOR);
    const c = store.create(ACTOR);
    expect(store.resolve(a)).toBeNull();
    expect(store.resolve(b)).toBe(ACTOR);
    expect(store.resolve(c)).toBe(ACTOR);
  });

  it('rejects malformed or guessed tokens', () => {
    const store = createDevSessionStore();
    expect(store.resolve(ACTOR)).toBeNull();
    expect(store.resolve('')).toBeNull();
    expect(store.resolve('x'.repeat(43))).toBeNull();
  });
});

describe('cookies', () => {
  it('reads one cookie and tolerates malformed headers', () => {
    expect(readCookie(`a=1; ${DEV_SESSION_COOKIE}=tok; b=2`, DEV_SESSION_COOKIE)).toBe('tok');
    expect(readCookie('garbage;;;=', DEV_SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, DEV_SESSION_COOKIE)).toBeUndefined();
  });

  it('serializes an HttpOnly SameSite=Strict cookie', () => {
    expect(serializeSessionCookie('tok', 60)).toBe(`${DEV_SESSION_COOKIE}=tok; Path=/; HttpOnly; SameSite=Strict; Max-Age=60`);
  });
});
