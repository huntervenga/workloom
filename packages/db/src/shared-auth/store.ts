import { randomUUID } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { safeProfilePhotoUrl } from '@workloom/contracts';
import type { SharedAuthStore, SharedAuthSessionRecord, SharedAuthSessionUpdate } from '@workloom/domain';
import type { Database } from '../client.js';
import { users, workspaces, memberships, sharedAuthIdentities, sharedAuthSessions, sharedAuthLoginAttempts } from '../schema.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new Error('Invalid shared authentication persistence input.');
function hash(value: string): string { if (typeof value !== 'string' || !HASH.test(value)) throw invalid(); return value; }
function text(value: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw invalid();
  return value;
}
function instant(value: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalid();
  const result = new Date(value); if (!Number.isFinite(result.getTime())) throw invalid(); return result;
}
function cipher(value: string): string {
  text(value, 1048576); if (Buffer.byteLength(value, 'utf8') > 1048576) throw invalid(); return value;
}
function internalReturnTo(value: string): string {
  text(value, 2048);
  let target: URL;
  try { target = new URL(value, 'https://workloom.invalid'); } catch { throw invalid(); }
  if (!value.startsWith('/') || target.origin !== 'https://workloom.invalid' ||
      (target.pathname !== '/app' && !target.pathname.startsWith('/app/'))) throw invalid();
  return value;
}
/** undefined = preserve, null = clear; anything but an already-normalized safe URL is rejected (value never logged). */
function avatar(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (safeProfilePhotoUrl(value) !== value) throw invalid();
  return value;
}
function record(row: typeof sharedAuthSessions.$inferSelect): SharedAuthSessionRecord {
  return { sessionHash: row.sessionHash, userId: row.userId, encryptedTokens: row.encryptedTokens,
    accessExpiresAt: row.accessExpiresAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
    revision: row.revision, revokedAt: row.revokedAt?.toISOString() ?? null };
}

/** The API verifies claims and owns AES-GCM encryption. This adapter never decrypts tokens. */
export function createSharedAuthStore(source: Database): SharedAuthStore {
  async function withLockedSession<T>(sessionHash: string, callback: (value: SharedAuthSessionRecord | null) => Promise<{
    readonly result: T; readonly update?: SharedAuthSessionUpdate;
  }>): Promise<T> {
    hash(sessionHash);
    return source.db.transaction(async tx => {
      const [row] = await tx.select().from(sharedAuthSessions).where(eq(sharedAuthSessions.sessionHash, sessionHash)).for('update');
      const decision = await callback(row ? record(row) : null);
      if (decision.update !== undefined) {
        if (!row) throw invalid();
        const update = decision.update;
        if (row.revokedAt !== null && update.revokedAt === null) throw invalid();
        const profileAvatarUrl = avatar(update.profileAvatarUrl);
        if (profileAvatarUrl !== undefined) {
          // Only a live, non-revoking session may write its own real user's photo; never matched by profile fields.
          if (row.revokedAt !== null || update.revokedAt !== undefined) throw invalid();
          const [user] = await tx.update(users).set({ avatarUrl: profileAvatarUrl, updatedAt: new Date() })
            .where(and(eq(users.id, row.userId), eq(users.kind, 'real'))).returning({ id: users.id });
          if (!user) throw invalid();
        }
        const patch: Partial<typeof sharedAuthSessions.$inferInsert> = {};
        if (update.encryptedTokens !== undefined) patch.encryptedTokens = cipher(update.encryptedTokens);
        if (update.accessExpiresAt !== undefined) patch.accessExpiresAt = instant(update.accessExpiresAt);
        if (update.expiresAt !== undefined) patch.expiresAt = instant(update.expiresAt);
        if (update.revokedAt !== undefined) patch.revokedAt = update.revokedAt === null ? null : instant(update.revokedAt);
        if (Object.keys(patch).length) {
          await tx.update(sharedAuthSessions).set({ ...patch, revision: row.revision + 1, updatedAt: new Date() })
            .where(eq(sharedAuthSessions.sessionHash, sessionHash));
        }
      }
      return decision.result;
    });
  }
  return {
    async provisionIdentity(input) {
      const issuer = text(input.issuer, 2048), subject = text(input.subject, 255);
      const displayName = text(input.displayName, 200).trim(), workspaceName = text(input.workspaceName, 200).trim();
      const timezone = text(input.timezone, 64);
      const avatarUrl = avatar(input.avatarUrl);
      try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); } catch { throw invalid(); }
      return source.db.transaction(async tx => {
        // Unambiguous scoped lock and unique composite key protect first login across API processes.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([issuer, subject])}, 0))`);
        const [existing] = await tx.select({ identity: sharedAuthIdentities, user: users }).from(sharedAuthIdentities)
          .innerJoin(users, eq(users.id, sharedAuthIdentities.userId))
          .where(and(eq(sharedAuthIdentities.issuer, issuer), eq(sharedAuthIdentities.subject, subject)));
        if (existing) {
          if (existing.user.kind !== 'real') throw invalid();
          const nextAvatarUrl = avatarUrl === undefined ? existing.user.avatarUrl : avatarUrl;
          if (existing.user.displayName !== displayName || existing.user.avatarUrl !== nextAvatarUrl) {
            await tx.update(users).set({ displayName, avatarUrl: nextAvatarUrl, updatedAt: new Date() }).where(eq(users.id, existing.user.id));
          }
          return { user: { id: existing.user.id, displayName, kind: 'real' as const, avatarUrl: nextAvatarUrl },
            workspaceId: existing.identity.workspaceId, membershipId: existing.identity.membershipId };
        }
        let userId = randomUUID();
        while (userId.toLowerCase() === subject.toLowerCase()) userId = randomUUID();
        const workspaceId = randomUUID(), membershipId = randomUUID();
        await tx.insert(users).values({ id: userId, displayName, kind: 'real', avatarUrl: avatarUrl ?? null });
        await tx.insert(workspaces).values({ id: workspaceId, name: workspaceName, timezone });
        await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner', state: 'active', revision: 1 });
        await tx.insert(sharedAuthIdentities).values({ issuer, subject, userId, workspaceId, membershipId });
        return { user: { id: userId, displayName, kind: 'real' as const, avatarUrl: avatarUrl ?? null }, workspaceId, membershipId };
      });
    },
    async createSession(input) {
      hash(input.sessionHash); if (!UUID.test(input.userId)) throw invalid();
      const encryptedTokens = cipher(input.encryptedTokens), accessExpiresAt = instant(input.accessExpiresAt), expiresAt = instant(input.expiresAt);
      await source.db.transaction(async tx => {
        const [user] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, input.userId)).for('share');
        if (user?.kind !== 'real') throw invalid();
        await tx.insert(sharedAuthSessions).values({ sessionHash: input.sessionHash, userId: input.userId, encryptedTokens, accessExpiresAt, expiresAt });
      });
    },
    withLockedSession,
    async revokeSession(sessionHash) {
      await withLockedSession(sessionHash, async value => value && value.revokedAt === null
        ? { result: undefined, update: { revokedAt: new Date().toISOString() } } : { result: undefined });
    },
    async createLoginAttempt(input) {
      await source.db.insert(sharedAuthLoginAttempts).values({ stateHash: hash(input.stateHash), browserHash: hash(input.browserHash),
        returnTo: internalReturnTo(input.returnTo), expiresAt: instant(input.expiresAt) });
    },
    async consumeLoginAttempt(input) {
      const stateHash = hash(input.stateHash), browserHash = hash(input.browserHash), now = instant(input.now);
      // DELETE obtains a row lock; concurrent consumers cannot both return the one-use state.
      const [attempt] = await source.db.delete(sharedAuthLoginAttempts).where(and(
        eq(sharedAuthLoginAttempts.stateHash, stateHash), eq(sharedAuthLoginAttempts.browserHash, browserHash), gt(sharedAuthLoginAttempts.expiresAt, now),
      )).returning({ returnTo: sharedAuthLoginAttempts.returnTo });
      return attempt ?? null;
    },
  };
}
