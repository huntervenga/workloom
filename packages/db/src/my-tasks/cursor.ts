import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { idSchema, sqlCalendarDateSchema } from '@workloom/contracts';
import { DomainError, type MyTasksCursor } from '@workloom/domain';

export interface MyTasksCursorOptions { readonly secret?: string; readonly now?: () => number; readonly ttlMs?: number }
const KEYS = ['kind', 'version', 'workspaceId', 'actorUserId', 'membershipId', 'permissionEpoch', 'queryHash', 'dueDate', 'id', 'expiresAt'] as const;
function invalid(): DomainError { return new DomainError('VALIDATION_FAILED', 'Reload the personal task list.', { details: { fields: ['cursor'] } }); }
function canonicalId(value: unknown): boolean { const parsed = idSchema.safeParse(value); return parsed.success && parsed.data === value; }
function valid(value: Record<string, unknown>): boolean {
  return value.kind === 'my-tasks' && value.version === 1 && canonicalId(value.workspaceId) && canonicalId(value.actorUserId) && canonicalId(value.membershipId) && canonicalId(value.id) && typeof value.permissionEpoch === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value.permissionEpoch) && typeof value.queryHash === 'string' && /^[0-9a-f]{64}$/.test(value.queryHash) && (value.dueDate === null || sqlCalendarDateSchema.safeParse(value.dueDate).success);
}
/** Separate authenticated cursor kind; old task-list tokens are never accepted here. */
export function createMyTasksCursorCodec(options: MyTasksCursorOptions = {}) {
  const key = options.secret === undefined ? randomBytes(32) : Buffer.from(options.secret, 'utf8');
  if (key.length < 32) throw new TypeError('A cursor secret must contain at least 32 bytes.');
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new TypeError('A cursor TTL must be positive whole milliseconds.');
  const sign = (body: string) => createHmac('sha256', key).update(body, 'utf8').digest();
  return {
    encode(payload: MyTasksCursor): string {
      if (Object.keys(payload).length !== KEYS.length - 1 || !KEYS.filter(key => key !== 'expiresAt').every(key => Object.hasOwn(payload, key)) || !valid(payload as unknown as Record<string, unknown>)) throw new TypeError('Invalid personal task cursor payload.');
      const body = Buffer.from(JSON.stringify({ ...payload, expiresAt: now() + ttl }), 'utf8').toString('base64url');
      const token = `${body}.${sign(body).toString('base64url')}`;
      if (token.length > 2048) throw new TypeError('Personal task cursor is too long.');
      return token;
    },
    decode(token: string): MyTasksCursor {
      if (typeof token !== 'string' || token.length > 2048) throw invalid();
      const parts = token.split('.');
      const body = parts[0], signature = parts[1];
      if (parts.length !== 2 || !body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw invalid();
      const supplied = Buffer.from(signature, 'base64url');
      const expected = sign(body);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid();
      let value: unknown;
      try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid(); }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(record, key)) || !valid(record) || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now() || record.expiresAt > now() + ttl) throw invalid();
      const { expiresAt: _expiresAt, ...payload } = record;
      return payload as unknown as MyTasksCursor;
    },
  };
}
