import { createHmac } from 'node:crypto';
import { isDomainError, type TaskCursorPayload } from '@workloom/domain';
import { describe, expect, it } from 'vitest';

import { INVALID_CURSOR_MESSAGE, TASK_CURSOR_TTL_MS, createTaskCursorCodec } from './cursor.js';

const SECRET = 'test-cursor-secret-0123456789abcdef';
const START = Date.UTC(2026, 9, 16, 12, 0, 0);

const payload: TaskCursorPayload = {
  version: 1,
  workspaceId: '00000000-0000-4000-8000-000000000001',
  actorUserId: '00000000-0000-4000-8000-000000000002',
  permissionEpoch: '7',
  queryHash: 'a'.repeat(64),
  position: 1024,
  id: '5eed0000-0000-4000-8000-000000000003',
};

function codecAt(clock: { now: number }, secret = SECRET) {
  return createTaskCursorCodec({ secret, now: () => clock.now });
}

function expectInvalid(decode: () => unknown): void {
  let caught: unknown;
  try {
    decode();
  } catch (error) {
    caught = error;
  }
  expect(isDomainError(caught)).toBe(true);
  expect(caught).toMatchObject({ code: 'VALIDATION_FAILED', message: INVALID_CURSOR_MESSAGE });
}

/** Signs an arbitrary body with the test secret, as an attacker who knew the key could. */
function forge(body: unknown): string {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', SECRET).update(encoded, 'utf8').digest('base64url')}`;
}

describe('task cursor codec', () => {
  it('round-trips a payload without exposing the expiry', () => {
    const clock = { now: START };
    const codec = codecAt(clock);
    const token = codec.encode(payload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(codec.decode(token)).toEqual(payload);
  });

  it('rejects a tampered body or signature', () => {
    const codec = codecAt({ now: START });
    const [body, signature] = codec.encode(payload).split('.') as [string, string];
    const moved = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), position: 0 }),
      'utf8',
    ).toString('base64url');
    expectInvalid(() => codec.decode(`${moved}.${signature}`));
    // The first character carries six significant bits, so changing it always changes the MAC.
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    expectInvalid(() => codec.decode(`${body}.${flipped}`));
  });

  it('rejects truncated and malformed tokens', () => {
    const codec = codecAt({ now: START });
    const token = codec.encode(payload);
    for (const bad of [token.slice(0, -1), token.slice(0, token.indexOf('.')), `${token}.x`, '', 'a.b', `${token}=`]) {
      expectInvalid(() => codec.decode(bad));
    }
    expectInvalid(() => codec.decode('a'.repeat(2049)));
  });

  it('rejects a token signed by another instance key', () => {
    const token = codecAt({ now: START }).encode(payload);
    expectInvalid(() => codecAt({ now: START }, 'another-secret-0123456789abcdefgh').decode(token));
    // Default keys are random per instance: a restart invalidates outstanding cursors.
    expectInvalid(() => createTaskCursorCodec().decode(createTaskCursorCodec().encode(payload)));
  });

  it('expires after the TTL', () => {
    const clock = { now: START };
    const codec = codecAt(clock);
    const token = codec.encode(payload);
    clock.now = START + TASK_CURSOR_TTL_MS - 1;
    expect(codec.decode(token)).toEqual(payload);
    clock.now = START + TASK_CURSOR_TTL_MS;
    expectInvalid(() => codec.decode(token));
  });

  it('rejects validly signed bodies with an unexpected shape', () => {
    const codec = codecAt({ now: START });
    const expiresAt = START + 60_000;
    const base = { ...payload, expiresAt };
    const bodies: unknown[] = [
      [base],
      { ...base, extra: true },
      { ...base, version: 2 },
      { ...base, id: payload.id.toUpperCase() },
      { ...base, permissionEpoch: '01' },
      { ...base, queryHash: 'A'.repeat(64) },
      { ...base, position: -1 },
      { ...base, position: 1.5 },
      { ...base, expiresAt: START + TASK_CURSOR_TTL_MS + 1 },
    ];
    expect(codec.decode(forge(base))).toEqual(payload);
    for (const body of bodies) {
      expectInvalid(() => codec.decode(forge(body)));
    }
  });

  it('refuses short secrets and malformed payloads at encode time', () => {
    expect(() => createTaskCursorCodec({ secret: 'short' })).toThrow(TypeError);
    expect(() => codecAt({ now: START }).encode({ ...payload, workspaceId: 'not-a-uuid' })).toThrow(TypeError);
  });
});
