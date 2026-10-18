import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { idSchema, utcTimestampSchema } from '@workloom/contracts';
import { DomainError, type TaskTimelineCursor } from '@workloom/domain';
export interface TaskTimelineCursorOptions { readonly secret?: string; readonly now?: () => number; readonly ttlMs?: number }
const common = ['kind', 'version', 'workspaceId', 'taskId', 'actorUserId', 'membershipId', 'permissionEpoch', 'limit'];
const integerText = (value: unknown, positive = false) => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n && (!positive || BigInt(value) > 0n);
const canonicalId = (value: unknown) => { const result = idSchema.safeParse(value); return result.success && result.data === value; };
const invalid = () => new DomainError('VALIDATION_FAILED', 'Reload the task discussion.', { details: { fields: ['cursor'] } });
function valid(value: Record<string, unknown>, expires: boolean): boolean {
  const anchor = value.kind === 'task-comments' ? ['createdAt', 'id'] : value.kind === 'task-activity' || value.kind === 'task-timeline' ? ['changeSeq', 'eventOrdinal'] : [];
  const keys = [...common, ...anchor, ...(expires ? ['expiresAt'] : [])];
  if (!anchor.length || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return false;
  if (value.version !== 1 || !['workspaceId', 'taskId', 'actorUserId', 'membershipId'].every(key => canonicalId(value[key])) || !integerText(value.permissionEpoch) || !Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100) return false;
  return value.kind === 'task-comments' ? canonicalId(value.id) && utcTimestampSchema.safeParse(value.createdAt).success && new Date(value.createdAt as string).toISOString() === value.createdAt : integerText(value.changeSeq, true) && Number.isSafeInteger(value.eventOrdinal) && (value.eventOrdinal as number) > 0 && (value.eventOrdinal as number) <= 2147483647;
}
/** Feed/task/actor-bound signed continuation; no cursor from another list family is accepted. */
export function createTaskTimelineCursorCodec(options: TaskTimelineCursorOptions = {}) {
  const key = options.secret === undefined ? randomBytes(32) : Buffer.from(options.secret, 'utf8');
  if (key.length < 32) throw new TypeError('A cursor secret must contain at least 32 bytes.');
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw new TypeError('A cursor TTL must be positive whole milliseconds.');
  const sign = (body: string) => createHmac('sha256', key).update(body, 'utf8').digest();
  return {
    encode(payload: TaskTimelineCursor): string {
      if (!valid(payload as unknown as Record<string, unknown>, false)) throw new TypeError('Invalid task timeline cursor payload.');
      const body = Buffer.from(JSON.stringify({ ...payload, expiresAt: now() + ttl }), 'utf8').toString('base64url');
      const token = `${body}.${sign(body).toString('base64url')}`;
      if (token.length > 2048) throw new TypeError('Task timeline cursor is too long.');
      return token;
    },
    decode(token: string): TaskTimelineCursor {
      if (typeof token !== 'string' || token.length > 2048) throw invalid();
      const [body, signature, ...extra] = token.split('.');
      if (extra.length || !body || !signature || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw invalid();
      const supplied = Buffer.from(signature, 'base64url'), expected = sign(body);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw invalid();
      let value: unknown;
      try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid(); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
      const record = value as Record<string, unknown>;
      if (!valid(record, true) || typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= now() || record.expiresAt > now() + ttl) throw invalid();
      const { expiresAt: _expiresAt, ...payload } = record;
      return payload as unknown as TaskTimelineCursor;
    },
  };
}
