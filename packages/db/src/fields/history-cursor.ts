import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { idSchema } from '@workloom/contracts';
import { DomainError, type TaskFieldHistoryCursorPayload } from '@workloom/domain';

/**
 * Signed, short-lived field value history cursors: `base64url(JSON) "." base64url(HMAC-SHA256)`.
 * The codec checks signature, strict shape, bounds and TTL only; the domain checks that the
 * workspace, actor, permission epoch, task and field still match the request.
 * Never log secrets or tokens.
 */
export interface TaskFieldHistoryCursorCodec {
  encode(payload: TaskFieldHistoryCursorPayload): string;
  /** Invalid, tampered or expired tokens throw `VALIDATION_FAILED`. */
  decode(token: string): TaskFieldHistoryCursorPayload;
}

export interface TaskFieldHistoryCursorCodecOptions {
  /**
   * HMAC key of at least 32 bytes (UTF-8). Omitted: a random per-instance key, so a process
   * restart invalidates outstanding cursors and clients refetch the first page.
   */
  readonly secret?: string;
  /** Default 15 minutes. */
  readonly ttlMs?: number;
  /** Clock in epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export const TASK_FIELD_HISTORY_CURSOR_MAX_LENGTH = 2048;
export const TASK_FIELD_HISTORY_CURSOR_TTL_MS = 15 * 60 * 1000;
export const INVALID_HISTORY_CURSOR_MESSAGE = 'Invalid history cursor. Reload the field history.';

const MIN_SECRET_BYTES = 32;
const SIGNATURE_BYTES = 32;
const MAX_INT32 = 2_147_483_647;
/** Largest PostgreSQL `bigint`; larger decimals would overflow the keyset parameter cast. */
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const PAYLOAD_KEYS = [
  'version',
  'workspaceId',
  'actorUserId',
  'permissionEpoch',
  'taskId',
  'fieldId',
  'changeSeq',
  'eventOrdinal',
  'id',
  'expiresAt',
] as const;

interface SignedPayload extends TaskFieldHistoryCursorPayload {
  readonly expiresAt: number;
}

function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', INVALID_HISTORY_CURSOR_MESSAGE, { details: { fields: ['cursor'] } });
}

/** Canonical (lower-case) ID only: the parsed form must equal the input. */
function isCanonicalId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = idSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

/** Canonical decimal within `[min, MAX_PG_BIGINT]`. */
function isBigintDecimal(value: unknown, min: bigint): value is string {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) return false;
  const parsed = BigInt(value);
  return parsed >= min && parsed <= MAX_PG_BIGINT;
}

function isPayload(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    isCanonicalId(value.workspaceId) &&
    isCanonicalId(value.actorUserId) &&
    isBigintDecimal(value.permissionEpoch, 0n) &&
    isCanonicalId(value.taskId) &&
    isCanonicalId(value.fieldId) &&
    isBigintDecimal(value.changeSeq, 1n) &&
    Number.isInteger(value.eventOrdinal) &&
    (value.eventOrdinal as number) >= 1 &&
    (value.eventOrdinal as number) <= MAX_INT32 &&
    isCanonicalId(value.id)
  );
}

function hasExactKeys(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every((key) => Object.hasOwn(value, key));
}

export function createTaskFieldHistoryCursorCodec(
  options: TaskFieldHistoryCursorCodecOptions = {},
): TaskFieldHistoryCursorCodec {
  const key = options.secret === undefined ? randomBytes(MIN_SECRET_BYTES) : Buffer.from(options.secret, 'utf8');
  if (key.length < MIN_SECRET_BYTES) {
    throw new TypeError(`The cursor secret must be at least ${MIN_SECRET_BYTES} bytes.`);
  }
  const ttlMs = options.ttlMs ?? TASK_FIELD_HISTORY_CURSOR_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('The cursor TTL must be a positive integer of milliseconds.');
  }
  const now = options.now ?? Date.now;

  function sign(body: string): Buffer {
    return createHmac('sha256', key).update(body, 'utf8').digest();
  }

  return {
    encode(payload) {
      const record = payload as unknown as Record<string, unknown>;
      if (!isPayload(record)) {
        throw new TypeError('Refusing to sign a malformed history cursor payload.');
      }
      const signed: SignedPayload = {
        version: 1,
        workspaceId: payload.workspaceId,
        actorUserId: payload.actorUserId,
        permissionEpoch: payload.permissionEpoch,
        taskId: payload.taskId,
        fieldId: payload.fieldId,
        changeSeq: payload.changeSeq,
        eventOrdinal: payload.eventOrdinal,
        id: payload.id,
        expiresAt: now() + ttlMs,
      };
      const body = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
      const token = `${body}.${sign(body).toString('base64url')}`;
      if (token.length > TASK_FIELD_HISTORY_CURSOR_MAX_LENGTH) {
        throw new TypeError('History cursor exceeds the maximum length.');
      }
      return token;
    },

    decode(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > TASK_FIELD_HISTORY_CURSOR_MAX_LENGTH) {
        throw invalidCursor();
      }
      const parts = token.split('.');
      const [body, signature] = parts;
      if (
        parts.length !== 2 ||
        body === undefined ||
        signature === undefined ||
        !BASE64URL_PATTERN.test(body) ||
        !BASE64URL_PATTERN.test(signature)
      ) {
        throw invalidCursor();
      }
      const actual = Buffer.from(signature, 'base64url');
      if (actual.length !== SIGNATURE_BYTES || !timingSafeEqual(actual, sign(body))) {
        throw invalidCursor();
      }

      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        throw invalidCursor();
      }
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded) || !hasExactKeys(decoded)) {
        throw invalidCursor();
      }
      const record = decoded as Record<string, unknown>;
      const expiresAt = record.expiresAt;
      const current = now();
      if (
        !isPayload(record) ||
        !Number.isSafeInteger(expiresAt) ||
        (expiresAt as number) <= current ||
        (expiresAt as number) > current + ttlMs
      ) {
        throw invalidCursor();
      }
      const payload = record as unknown as SignedPayload;
      return {
        version: 1,
        workspaceId: payload.workspaceId,
        actorUserId: payload.actorUserId,
        permissionEpoch: payload.permissionEpoch,
        taskId: payload.taskId,
        fieldId: payload.fieldId,
        changeSeq: payload.changeSeq,
        eventOrdinal: payload.eventOrdinal,
        id: payload.id,
      };
    },
  };
}
