import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SessionKey, type SharedAuthConfig } from '../config.js';
import { createInvitationHandoff, INVITATION_HANDOFF_COOKIE } from './invitation-handoff.js';
const config = (origin = 'https://workloom.test'): SharedAuthConfig => ({ baseUrl: 'https://auth.test', issuer: 'https://auth.test', audience: 'workloom', jwksUrl: 'https://auth.test/keys', appOrigin: origin, secureCookies: origin.startsWith('https:'), sessionKey: new SessionKey(Buffer.alloc(32, 7)) });
const value = (cookie: string) => cookie.slice(INVITATION_HANDOFF_COOKIE.length + 1).split(';')[0];
const token = () => randomBytes(32).toString('base64url');
const credential = () => ({ invitationId: randomUUID(), secret: token() });

describe('short-lived server-side invitation handoff', () => {
  it('keeps the capability encrypted and binds stage to login attempt then exact new session', () => {
    const handoff = createInvitationHandoff(config()), input = credential(), attempt = token(), session = token();
    const staged = handoff.stage(input);
    expect(staged).toContain('HttpOnly; SameSite=Lax; Secure');
    expect(staged).toContain('Path=/api/v1/auth; Max-Age=600');
    expect(staged).not.toContain(input.secret); expect(staged).not.toContain(input.invitationId);
    expect(handoff.resume(value(staged), session)).toBeNull();
    const bound = handoff.bindLogin(value(staged), attempt, '/app/join');
    const ready = handoff.complete(value(bound), attempt, session);
    expect(ready.ready).toBe(true);
    expect(handoff.resume(value(ready.cookie), session)).toEqual(input);
    expect(handoff.resume(value(ready.cookie), token())).toBeNull();
    // Repeated resume retains exact-retry material; the domain's acceptance receipt owns consumption.
    expect(handoff.resume(value(ready.cookie), session)).toEqual(input);
  });
  it('rejects wrong browser attempt, arbitrary ready cookies, normal logins and tampering', () => {
    const handoff = createInvitationHandoff(config()), attempt = token(), session = token();
    const staged = handoff.stage(credential());
    expect(handoff.bindLogin(value(staged), attempt, '/app')).toBe(handoff.clearCookie());
    const bound = handoff.bindLogin(value(staged), attempt, '/app/join');
    expect(handoff.complete(value(bound), token(), session).ready).toBe(false);
    expect(handoff.complete(value(staged), attempt, session).ready).toBe(false);
    const encoded = value(bound) ?? '';
    expect(handoff.complete(`A${encoded.slice(1)}`, attempt, session).ready).toBe(false);
    expect(handoff.complete(undefined, attempt, session).ready).toBe(false);
    expect(handoff.resume('malformed', session)).toBeNull();
  });
  it('expires throughout OAuth without extending TTL and forbids cross-origin/key reuse', () => {
    let clock = 1_800_000_000_000;
    const handoff = createInvitationHandoff(config(), () => new Date(clock)), attempt = token(), session = token();
    const staged = handoff.stage(credential()); clock += 120_000;
    const bound = handoff.bindLogin(value(staged), attempt, '/app/join');
    expect(bound).toContain('Max-Age=480');
    expect(createInvitationHandoff(config('https://other.test'), () => new Date(clock)).complete(value(bound), attempt, session).ready).toBe(false);
    clock += 480_000;
    expect(handoff.complete(value(bound), attempt, session).ready).toBe(false);
  });
  it('allows controlled account switch only from the session that owns the ready handoff', () => {
    const handoff = createInvitationHandoff(config()), firstAttempt = token(), firstSession = token(), nextAttempt = token(), nextSession = token();
    const staged = handoff.stage(credential());
    const first = handoff.complete(value(handoff.bindLogin(value(staged), firstAttempt, '/app/join')), firstAttempt, firstSession);
    expect(handoff.bindLogin(value(first.cookie), nextAttempt, '/app/join', token())).toBe(handoff.clearCookie());
    const next = handoff.complete(value(handoff.bindLogin(value(first.cookie), nextAttempt, '/app/join', firstSession)), nextAttempt, nextSession);
    expect(next.ready).toBe(true);
    expect(handoff.resume(value(next.cookie), firstSession)).toBeNull();
    expect(handoff.resume(value(next.cookie), nextSession)).not.toBeNull();
  });
  it('never marks loopback cookies Secure and rejects a noncanonical invitation secret', () => {
    const handoff = createInvitationHandoff(config('http://127.0.0.1:4310'));
    expect(handoff.stage(credential())).not.toContain('; Secure');
    const input = credential();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tail = alphabet.indexOf(input.secret.at(-1) ?? '');
    expect(() => handoff.stage({ ...input, secret: input.secret.slice(0, -1) + alphabet[tail + 1] })).toThrow('Invalid invitation material.');
  });
});
