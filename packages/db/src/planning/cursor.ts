import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { idSchema } from '@workloom/contracts';
import { DomainError, type PlanningCursor } from '@workloom/domain';

/**
 * Signed, short-lived planning list cursors: `base64url(JSON) "." base64url(HMAC-SHA256)`.
 * The codec checks signature, strict shape and TTL only; the domain checks that the
 * workspace, actor, query hash and permission epoch still match the request.
 * Never log secrets or tokens.
 */
export interface PlanningCursorCodec {
  encode(payload: PlanningCursor): string;
  /** Invalid, tampered or expired tokens throw `VALIDATION_FAILED`. */
  decode(token: string): PlanningCursor;
}

export interface PlanningCursorCodecOptions {
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

export const PLANNING_CURSOR_MAX_LENGTH = 4096;
export const PLANNING_CURSOR_TTL_MS = 15 * 60 * 1000;
export const INVALID_CURSOR_MESSAGE = 'Invalid pagination cursor. Reload the planning list.';

const MIN_SECRET_BYTES = 32;
const SIGNATURE_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const EPOCH_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const QUERY_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PAYLOAD_KEYS = [
  'version',
  'workspaceId',
  'actorUserId',
  'permissionEpoch',
  'queryHash',
  'afterId',
  'expiresAt',
] as const;

interface SignedPayload extends PlanningCursor {
  readonly expiresAt: number;
}

function invalidCursor(): DomainError {
  return new DomainError('VALIDATION_FAILED', INVALID_CURSOR_MESSAGE, { details: { fields: ['cursor'] } });
}

/** Canonical (lower-case) ID only: the parsed form must equal the input. */
function isCanonicalId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = idSchema.safeParse(value);
  return parsed.success && parsed.data === value;
}

function isPayload(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    isCanonicalId(value.workspaceId) &&
    isCanonicalId(value.actorUserId) &&
    typeof value.permissionEpoch === 'string' &&
    EPOCH_PATTERN.test(value.permissionEpoch) &&
    typeof value.queryHash === 'string' &&
    QUERY_HASH_PATTERN.test(value.queryHash) &&
    typeof value.afterId === 'string' && /^[0-9a-z:-]{1,200}$/.test(value.afterId)
  );
}

function hasExactKeys(value: object): boolean {
  const keys = Object.keys(value);
  return keys.length === PAYLOAD_KEYS.length && PAYLOAD_KEYS.every((key) => Object.hasOwn(value, key));
}

export function createPlanningCursorCodec(options: PlanningCursorCodecOptions = {}): PlanningCursorCodec {
  const key = options.secret === undefined ? randomBytes(MIN_SECRET_BYTES) : Buffer.from(options.secret, 'utf8');
  if (key.length < MIN_SECRET_BYTES) {
    throw new TypeError(`The cursor secret must be at least ${MIN_SECRET_BYTES} bytes.`);
  }
  const ttlMs = options.ttlMs ?? PLANNING_CURSOR_TTL_MS;
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
        throw new TypeError('Refusing to sign a malformed planning cursor payload.');
      }
      const signed: SignedPayload = {
        version: 1,
        workspaceId: payload.workspaceId,
        actorUserId: payload.actorUserId,
        permissionEpoch: payload.permissionEpoch,
        queryHash: payload.queryHash,
        afterId: payload.afterId,
        expiresAt: now() + ttlMs,
      };
      const body = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
      const token = `${body}.${sign(body).toString('base64url')}`;
      if (token.length > PLANNING_CURSOR_MAX_LENGTH) {
        throw new TypeError('Planning cursor exceeds the maximum length.');
      }
      return token;
    },

    decode(token) {
      if (typeof token !== 'string' || token.length === 0 || token.length > PLANNING_CURSOR_MAX_LENGTH) {
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
        queryHash: payload.queryHash,
        afterId: payload.afterId,
      };
    },
  };
}
