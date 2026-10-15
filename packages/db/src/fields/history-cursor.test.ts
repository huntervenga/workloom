import { createHmac } from 'node:crypto';
import { isDomainError, type TaskFieldHistoryCursorPayload } from '@workloom/domain';
import { describe, expect, it } from 'vitest';

import {
  INVALID_HISTORY_CURSOR_MESSAGE,
  TASK_FIELD_HISTORY_CURSOR_TTL_MS,
  createTaskFieldHistoryCursorCodec,
} from './history-cursor.js';

const SECRET = 'test-history-cursor-secret-0123456789';
const START = Date.UTC(2026, 9, 16, 12, 0, 0);
const MAX_PG_BIGINT = '9223372036854775807';

// IDs contain hex letters so that an upper-cased variant really differs from the canonical form.
const payload: TaskFieldHistoryCursorPayload = {
  version: 1,
  workspaceId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  actorUserId: 'b1ffcd88-8d1a-4ef8-ac7e-7cc0ce491b22',
  permissionEpoch: '7',
  taskId: 'c2aade77-7e2b-4ef8-9d8f-8dd1df5a2c33',
  fieldId: 'd3bbef66-6f3c-4ef8-8e9a-9ee2ea6b3d44',
  changeSeq: '42',
  eventOrdinal: 3,
  id: 'e4ccfa55-5a4d-4ef8-bfab-aff3fb7c4e55',
};

function codecAt(clock: { now: number }, secret = SECRET) {
  return createTaskFieldHistoryCursorCodec({ secret, now: () => clock.now });
}

function expectInvalid(decode: () => unknown): void {
  let caught: unknown;
  try {
    decode();
  } catch (error) {
    caught = error;
  }
  expect(isDomainError(caught)).toBe(true);
  expect(caught).toMatchObject({ code: 'VALIDATION_FAILED', message: INVALID_HISTORY_CURSOR_MESSAGE });
}

/** Signs an arbitrary body with the test secret, as an attacker who knew the key could. */
function forge(body: unknown): string {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  return `${encoded}.${createHmac('sha256', SECRET).update(encoded, 'utf8').digest('base64url')}`;
}

describe('task field history cursor codec', () => {
  it('round-trips a payload without exposing the expiry', () => {
    const codec = codecAt({ now: START });
    const token = codec.encode(payload);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(codec.decode(token)).toEqual(payload);
  });

  it('rejects a tampered body or signature', () => {
    const codec = codecAt({ now: START });
    const [body, signature] = codec.encode(payload).split('.') as [string, string];
    const moved = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), changeSeq: '41' }),
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
    expectInvalid(() => codec.decode(`${forge(payload).split('.')[0] ?? ''}.${'A'.repeat(43)}`));
  });

  it('rejects a token signed by another key or a restarted instance', () => {
    const token = codecAt({ now: START }).encode(payload);
    expectInvalid(() => codecAt({ now: START }, 'another-history-secret-0123456789ab').decode(token));
    // Default keys are random per instance: a restart invalidates outstanding cursors.
    expectInvalid(() =>
      createTaskFieldHistoryCursorCodec().decode(createTaskFieldHistoryCursorCodec().encode(payload)),
    );
  });

  it('expires after the TTL and rejects expiries beyond it', () => {
    const clock = { now: START };
    const codec = codecAt(clock);
    const token = codec.encode(payload);
    clock.now = START + TASK_FIELD_HISTORY_CURSOR_TTL_MS - 1;
    expect(codec.decode(token)).toEqual(payload);
    clock.now = START + TASK_FIELD_HISTORY_CURSOR_TTL_MS;
    expectInvalid(() => codec.decode(token));

    const fresh = codecAt({ now: START });
    expectInvalid(() => fresh.decode(forge({ ...payload, expiresAt: START + TASK_FIELD_HISTORY_CURSOR_TTL_MS + 1 })));
    expectInvalid(() => fresh.decode(forge({ ...payload, expiresAt: START })));
    expectInvalid(() => fresh.decode(forge({ ...payload, expiresAt: String(START + 60_000) })));
  });

  it('rejects validly signed bodies with unexpected keys or shape', () => {
    const codec = codecAt({ now: START });
    const base = { ...payload, expiresAt: START + 60_000 };
    const missingField = Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'fieldId'));
    const bodies: unknown[] = [
      [base],
      null,
      'cursor',
      missingField,
      { ...base, extra: true },
      { ...base, version: 2 },
      { ...base, version: '1' },
    ];
    expect(codec.decode(forge(base))).toEqual(payload);
    for (const body of bodies) {
      expectInvalid(() => codec.decode(forge(body)));
    }
  });

  it('accepts only canonical lower-case UUIDs', () => {
    const codec = codecAt({ now: START });
    const base = { ...payload, expiresAt: START + 60_000 };
    for (const key of ['workspaceId', 'actorUserId', 'taskId', 'fieldId', 'id'] as const) {
      const upper = payload[key].toUpperCase();
      expect(upper).not.toBe(payload[key]);
      expectInvalid(() => codec.decode(forge({ ...base, [key]: upper })));
      expectInvalid(() => codec.decode(forge({ ...base, [key]: 'not-a-uuid' })));
    }
  });

  it('bounds the sequence, epoch and ordinal to their database ranges', () => {
    const codec = codecAt({ now: START });
    const base = { ...payload, expiresAt: START + 60_000 };
    const accepted = [
      { changeSeq: '1' },
      { changeSeq: MAX_PG_BIGINT },
      { permissionEpoch: '0' },
      { permissionEpoch: MAX_PG_BIGINT },
      { eventOrdinal: 1 },
      { eventOrdinal: 2_147_483_647 },
    ];
    for (const change of accepted) {
      expect(codec.decode(forge({ ...base, ...change }))).toEqual({ ...payload, ...change });
    }
    const rejected: Record<string, unknown>[] = [
      { changeSeq: '0' },
      { changeSeq: '01' },
      { changeSeq: '-1' },
      { changeSeq: '9223372036854775808' },
      { changeSeq: '99999999999999999999' },
      { changeSeq: 42 },
      { permissionEpoch: '-1' },
      { permissionEpoch: '007' },
      { permissionEpoch: '9223372036854775808' },
      { permissionEpoch: 7 },
      { eventOrdinal: 0 },
      { eventOrdinal: 1.5 },
      { eventOrdinal: 2_147_483_648 },
      { eventOrdinal: '3' },
    ];
    for (const change of rejected) {
      expectInvalid(() => codec.decode(forge({ ...base, ...change })));
    }
  });

  it('measures the secret length in UTF-8 bytes', () => {
    // 16 Cyrillic letters are 32 UTF-8 bytes; 31 ASCII characters are 31 bytes.
    const multibyte = 'ключключключключ';
    expect(multibyte).toHaveLength(16);
    const codec = createTaskFieldHistoryCursorCodec({ secret: multibyte, now: () => START });
    expect(codec.decode(codec.encode(payload))).toEqual(payload);
    expect(() => createTaskFieldHistoryCursorCodec({ secret: 'x'.repeat(31) })).toThrow(TypeError);
    expect(() => createTaskFieldHistoryCursorCodec({ secret: 'short' })).toThrow(TypeError);
  });

  it('refuses malformed payloads and TTLs at construction or encode time', () => {
    expect(() => createTaskFieldHistoryCursorCodec({ ttlMs: 0 })).toThrow(TypeError);
    const codec = codecAt({ now: START });
    expect(() => codec.encode({ ...payload, workspaceId: 'not-a-uuid' })).toThrow(TypeError);
    expect(() => codec.encode({ ...payload, taskId: payload.taskId.toUpperCase() })).toThrow(TypeError);
    expect(() => codec.encode({ ...payload, changeSeq: '0' })).toThrow(TypeError);
    expect(() => codec.encode({ ...payload, changeSeq: '9223372036854775808' })).toThrow(TypeError);
    expect(() => codec.encode({ ...payload, eventOrdinal: 0 })).toThrow(TypeError);
  });
});
