import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invitationHandoff } from './invitationHandoff';
const id = '33333333-3333-4333-8333-333333333333';
const secret = 'A'.repeat(43);
const location = (pathname = '/app/join', hash = `#${id}.${secret}`) => ({ pathname, hash, search: '' });
beforeEach(() => invitationHandoff.clear());
describe('invitation credentials in one tab', () => {
  it('strips a valid fragment synchronously and only exposes it to its confirmed actor', () => {
    const history = { state: { router: 'kept' }, replaceState: vi.fn() };
    invitationHandoff.capture(location(), history);
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(history.state, '', '/app/join');
    expect(invitationHandoff.getSnapshot()).toBe('ready');
    expect(invitationHandoff.forActor(id)).toBeNull();
    invitationHandoff.claim(id);
    expect(invitationHandoff.forActor(id)).toEqual({ invitationId: id, secret });
    invitationHandoff.capture(location('/app/join', ''), history);
    invitationHandoff.claim(id);
    expect(invitationHandoff.forActor(id)?.secret).toBe(secret);
    // StrictMode's repeat observation never consumes or swaps the captured credential.
    invitationHandoff.claim('44444444-4444-4444-8444-444444444444');
    expect(invitationHandoff.forActor(id)).toBeNull();
    expect(invitationHandoff.getSnapshot()).toBe('expired');
  });
  it.each(['/app/join/', '/app/JOIN', '/APP/JoIn///', '/app/%6aoin'])('captures all invitation route spellings accepted by the router: %s', pathname => {
    const history = { state: null, replaceState: vi.fn() };
    invitationHandoff.capture(location(pathname), history);
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', pathname);
    invitationHandoff.claim(id);
    expect(invitationHandoff.forActor(id)?.secret).toBe(secret);
  });
  it('clears secrets for anonymous sign-in and route departure, requiring the original link again', () => {
    const history = { state: null, replaceState: vi.fn() };
    invitationHandoff.capture(location(), history);
    invitationHandoff.requireSignIn();
    invitationHandoff.claim(id);
    expect(invitationHandoff.forActor(id)).toBeNull();
    expect(invitationHandoff.getSnapshot()).toBe('sign-in-first');
    invitationHandoff.capture(location(), history);
    invitationHandoff.claim(id);
    invitationHandoff.clear();
    expect(invitationHandoff.forActor(id)).toBeNull();
  });
  it.each(['/app/auth/callback', '/app/w/workspace', '/', '/app/%2Fjoin', '/app/%256aoin', '/app/%6aoin%ZZ'])('never captures or rewrites an unrelated path %s', pathname => {
    const history = { state: null, replaceState: vi.fn() };
    invitationHandoff.capture(location(pathname), history);
    expect(history.replaceState).not.toHaveBeenCalled();
    invitationHandoff.claim(id);
    expect(invitationHandoff.forActor(id)).toBeNull();
  });
  it.each([`#${id}.${'A'.repeat(42)}B`, `#${id}.${'A'.repeat(44)}`, '#ordinary', '#x?secret=hidden'])('strips but rejects malformed and noncanonical credentials', hash => {
    const history = { state: null, replaceState: vi.fn() };
    invitationHandoff.capture(location('/app/join', hash), history);
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/app/join');
    expect(invitationHandoff.getSnapshot()).toBe('invalid');
    invitationHandoff.claim(id);
    expect(invitationHandoff.forActor(id)).toBeNull();
  });
});
