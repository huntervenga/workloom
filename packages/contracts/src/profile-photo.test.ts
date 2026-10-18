import { describe, expect, it } from 'vitest';

import { actorSchema, fixtureActorSchema } from './identity.js';
import { profilePhotoUrlSchema, safeProfilePhotoUrl } from './profile-photo.js';
import { membershipSchema } from './workspaces.js';

const GOOGLE = 'https://lh3.googleusercontent.com/a/ACg8ocK-Ab_12xyz=s96-c';
const ID = '0b9e8d7c-6a5f-4e3d-9c2b-1a0f9e8d7c6b';

describe('safeProfilePhotoUrl', () => {
  it('accepts provider photo URLs and returns the normalized href', () => {
    expect(safeProfilePhotoUrl(GOOGLE)).toBe(GOOGLE);
    expect(safeProfilePhotoUrl('https://avatars.example.com/u/42?sz=128')).toBe('https://avatars.example.com/u/42?sz=128');
    expect(safeProfilePhotoUrl('HTTPS://LH3.GoogleUserContent.com/a/x')).toBe('https://lh3.googleusercontent.com/a/x');
    expect(safeProfilePhotoUrl('https://photos.example.com:443/a')).toBe('https://photos.example.com/a');
    expect(safeProfilePhotoUrl('https://photos.example.com')).toBe('https://photos.example.com/');
  });

  it.each([
    ['http scheme', 'http://lh3.googleusercontent.com/a/x'],
    ['data URL', 'data:image/png;base64,AAAA'],
    ['blob URL', 'blob:https://app.example.com/0b9e8d7c'],
    ['javascript URL', 'javascript:alert(1)'],
    ['relative path', '/a/photo.png'],
    ['protocol-relative', '//lh3.googleusercontent.com/a/x'],
    ['scheme without slashes', 'https:lh3.googleusercontent.com/a/x'],
    ['username', 'https://user@lh3.googleusercontent.com/a/x'],
    ['username and password', 'https://user:secret@lh3.googleusercontent.com/a/x'],
    ['fragment', 'https://lh3.googleusercontent.com/a/x#frag'],
    ['empty fragment', 'https://lh3.googleusercontent.com/a/x#'],
    ['explicit port', 'https://lh3.googleusercontent.com:8443/a/x'],
    ['localhost', 'https://localhost/a.png'],
    ['localhost subdomain', 'https://img.localhost/a.png'],
    ['trailing-dot host', 'https://localhost./a.png'],
    ['reserved suffix', 'https://photos.internal/a.png'],
    ['single label host', 'https://intranet/a.png'],
    ['IPv4 loopback', 'https://127.0.0.1/a.png'],
    ['IPv4 private', 'https://10.0.0.8/a.png'],
    ['IPv4 link-local metadata', 'https://169.254.169.254/latest'],
    ['IPv4 shorthand', 'https://0x7f.1/a.png'],
    ['IPv6 loopback', 'https://[::1]/a.png'],
    ['IPv6 mapped', 'https://[::ffff:7f00:1]/a.png'],
    ['token query', 'https://photos.example.com/a.png?token=abc'],
    ['signed query', 'https://photos.example.com/a.png?sz=96&Signature=abc'],
    ['duplicate size', 'https://photos.example.com/a.png?sz=96&sz=128'],
    ['zero size', 'https://photos.example.com/a.png?sz=0'],
    ['oversized size', 'https://photos.example.com/a.png?sz=4096'],
    ['leading-zero size', 'https://photos.example.com/a.png?sz=096'],
    ['empty query', 'https://photos.example.com/a.png?'],
    ['percent escapes', 'https://photos.example.com/a%2Fb.png'],
    ['backslash', 'https://photos.example.com\\a.png'],
    ['inner whitespace', 'https://photos.example.com/a b.png'],
    ['surrounding whitespace', ' https://photos.example.com/a.png'],
    ['control character', 'https://photos.example.com/a\u0000.png'],
    ['tab', 'https://photos.example.com/\ta.png'],
  ])('rejects %s', (_label, value) => {
    expect(safeProfilePhotoUrl(value)).toBeNull();
  });

  it('rejects non-strings, empty and over-long values', () => {
    for (const value of [undefined, null, 42, {}, ['https://photos.example.com/a'], '']) {
      expect(safeProfilePhotoUrl(value)).toBeNull();
    }
    const base = 'https://photos.example.com/';
    expect(safeProfilePhotoUrl(base + 'a'.repeat(2048 - base.length))).not.toBeNull();
    expect(safeProfilePhotoUrl(base + 'a'.repeat(2049 - base.length))).toBeNull();
  });
});

describe('profilePhotoUrlSchema', () => {
  it('accepts only already-normalized safe URLs', () => {
    expect(profilePhotoUrlSchema.safeParse(GOOGLE).success).toBe(true);
    expect(profilePhotoUrlSchema.safeParse('HTTPS://LH3.GoogleUserContent.com/a/x').success).toBe(false);
    expect(profilePhotoUrlSchema.safeParse('javascript:alert(1)').success).toBe(false);
  });

  it('keeps avatarUrl optional and nullable on actors and members without adding defaults', () => {
    const actor = { id: ID, displayName: 'Ada', kind: 'real' as const };
    expect(actorSchema.parse(actor)).toEqual(actor);
    expect('avatarUrl' in actorSchema.parse(actor)).toBe(false);
    expect(actorSchema.parse({ ...actor, avatarUrl: null })).toEqual({ ...actor, avatarUrl: null });
    expect(actorSchema.parse({ ...actor, avatarUrl: GOOGLE })).toEqual({ ...actor, avatarUrl: GOOGLE });
    expect(actorSchema.safeParse({ ...actor, avatarUrl: 'https://127.0.0.1/a.png' }).success).toBe(false);

    const member = { id: ID, workspaceId: ID, userId: ID, displayName: 'Ada', role: 'owner' as const };
    expect('avatarUrl' in membershipSchema.parse(member)).toBe(false);
    expect(membershipSchema.parse({ ...member, avatarUrl: GOOGLE }).avatarUrl).toBe(GOOGLE);
    expect(membershipSchema.safeParse({ ...member, avatarUrl: 'data:image/png;base64,AAAA' }).success).toBe(false);
  });

  it('keeps the fixture actor schema fixture-only', () => {
    expect(fixtureActorSchema.safeParse({ id: ID, displayName: 'Ada', kind: 'real', avatarUrl: GOOGLE }).success).toBe(false);
    expect('avatarUrl' in fixtureActorSchema.parse({ id: ID, displayName: 'Fixture', kind: 'fixture', avatarUrl: GOOGLE })).toBe(false);
  });
});
