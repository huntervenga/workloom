import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { idSchema, recurrenceCalendarDateSchema, recurrenceHashSchema } from '@workloom/contracts';
import { DomainError, type RecurrenceMaterializationCursor } from '@workloom/domain';

/**
 * Signed, short-lived materialization continuations: `base64url(JSON) "." base64url(HMAC-SHA256)`.
 * Replaces any raw afterKey. The codec checks signature, strict shape and TTL only; the domain checks
 * that workspace, actor, permission epoch, period and manifest hash still match the request.
 * The HMAC is domain-separated from list cursors, so a planning cursor signed with the same secret
 * never verifies here. Never log secrets or tokens.
 */
export interface RecurrenceCursorCodec {
  encode(payload: RecurrenceMaterializationCursor): string;
  /** Invalid, tampered, foreign-purpose or expired tokens throw `VALIDATION_FAILED`. */
  decode(token: string): RecurrenceMaterializationCursor;
}

export interface RecurrenceCursorCodecOptions {
  /**
   * HMAC key of at least 32 bytes (UTF-8). Omitted: a random per-instance key, so a process
   * restart invalidates outstanding cursors and clients restart from the first chunk.
   */
  readonly secret?: string;
  /** Default 15 minutes. */
  readonly ttlMs?: number;
  /** Clock in epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export const RECURRENCE_CURSOR_MAX_LENGTH = 4096;
export const RECURRENCE_CURSOR_TTL_MS = 15 * 60 * 1000;
export const INVALID_RECURRENCE_CURSOR_MESSAGE = 'Invalid materialization cursor. Restart materialization of the period.';

const PURPOSE = 'workloom.recurrence.materialization.v1\n';
const MIN_SECRET_BYTES = 32;
const SIGNATURE_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const EPOCH_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const PAYLOAD_KEYS = [
  'version',
  'workspaceId',
  'actorUserId',
  'permissionEpoch',
  'periodId',
  'manifestHash',
  'afterSeriesId',
  'afterOccurrenceKey',
  'expiresAt',
] as const;

interface SignedPayload extends RecurrenceMaterializationCursor {
  readonly expiresAt: number;
}

function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', INVALID_RECURRENCE_CURSOR_MESSAGE, { details: { fields: ['cursor'] } });
}

/** Canonical (lower-case) ID only: the parsed form must equal the input. */
function isCanonicalId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = idSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

/** The after-anchor is both null (first chunk) or both set; never half an anchor. */
function isAnchor(seriesId: unknown, occurrenceKey: unknown): boolean {
  if (seriesId === null && occurrenceKey === null) return true;
  return isCanonicalId(seriesId) && typeof occurrenceKey === 'string' && recurrenceCalendarDateSchema.safeParse(occurrenceKey).success;
}

function isPayload(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    isCanonicalId(value.workspaceId) &&
    isCanonicalId(value.actorUserId) &&
    typeof value.permissionEpoch === 'string' &&
    EPOCH_PATTERN.test(value.permissionEpoch) &&
    isCanonicalId(value.periodId) &&
    typeof value.manifestHash === 'string' &&
    recurrenceHashSchema.safeParse(value.manifestHash).success &&
    isAnchor(value.afterSeriesId, value.afterOccurrenceKey)
  );
}

function hasExactKeys(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every((key) => Object.hasOwn(value, key));
}

export function createRecurrenceCursorCodec(options: RecurrenceCursorCodecOptions = {}): RecurrenceCursorCodec {
  const key = options.secret === undefined ? randomBytes(MIN_SECRET_BYTES) : Buffer.from(options.secret, 'utf8');
  if (key.length < MIN_SECRET_BYTES) {
    throw new TypeError(`The cursor secret must be at least ${MIN_SECRET_BYTES} bytes.`);
  }
  const ttlMs = options.ttlMs ?? RECURRENCE_CURSOR_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new TypeError('The cursor TTL must be a positive integer of milliseconds.');
  }
  const now = options.now ?? Date.now;

  function sign(body: string): Buffer {
    return createHmac('sha256', key).update(PURPOSE, 'utf8').update(body, 'utf8').digest();
  }

  return {
    encode(payload) {
      const record = payload as unknown as Record<string, unknown>;
      if (!isPayload(record)) {
        throw new TypeError('Refusing to sign a malformed materialization cursor payload.');
      }
      const signed: SignedPayload = {
        version: 1,
        workspaceId: payload.workspaceId,
        actorUserId: payload.actorUserId,
        permissionEpoch: payload.permissionEpoch,
        periodId: payload.periodId,
        manifestHash: payload.manifestHash,
        afterSeriesId: payload.afterSeriesId,
        afterOccurrenceKey: payload.afterOccurrenceKey,
        expiresAt: now() + ttlMs,
      };
      const body = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
      const token = `${body}.${sign(body).toString('base64url')}`;
      if (token.length > RECURRENCE_CURSOR_MAX_LENGTH) {
        throw new TypeError('Materialization cursor exceeds the maximum length.');
      }
      return token;
    },

    decode(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > RECURRENCE_CURSOR_MAX_LENGTH) {
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
        periodId: payload.periodId,
        manifestHash: payload.manifestHash,
        afterSeriesId: payload.afterSeriesId,
        afterOccurrenceKey: payload.afterOccurrenceKey,
      };
    },
  };
}
