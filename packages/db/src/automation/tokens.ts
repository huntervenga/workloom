import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  API_TOKEN_LIMITS, API_TOKEN_PATTERN, API_TOKEN_PREFIX, apiTokenSchema, createApiTokenInputSchema,
  type ApiTokenDto, type ApiTokenScope, type CreateApiTokenInput, type CreatedApiTokenDto,
} from '@workloom/contracts';
import { DomainError, notFoundError, unauthenticatedError } from '@workloom/domain';
import type { WorkloomExecutor } from '../client.js';
import { apiTokens, users } from '../schema.js';

export const hashApiToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function generateApiToken(): { id: string; token: string; hash: string; prefix: string } {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { id: randomUUID(), token, hash: hashApiToken(token), prefix: token.slice(0, 12) };
}

/** Syntax only; a malformed value never reaches the database. */
export function parseApiToken(value: string): string {
  if (!API_TOKEN_PATTERN.test(value)) throw unauthenticatedError();
  return hashApiToken(value);
}

export interface ApiPrincipal {
  readonly tokenId: string;
  readonly tokenName: string;
  readonly userId: string;
  readonly displayName: string;
  readonly kind: 'real' | 'fixture';
  readonly scopes: readonly ApiTokenScope[];
  readonly workspaceIds: readonly string[] | null;
  readonly expiresAt: Date;
}

const toDto = (row: typeof apiTokens.$inferSelect): ApiTokenDto => apiTokenSchema.parse({
  id: row.id, name: row.name, tokenPrefix: row.tokenPrefix, scopes: row.scopes, workspaceIds: row.workspaceIds ?? null,
  createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null, lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
});

/** Current database time, so token expiry never depends on an application-server clock. */
export async function databaseNow(tx: WorkloomExecutor): Promise<Date> {
  const [row] = await tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
  if (!row) throw new Error('Database clock unavailable.');
  return new Date(row.at);
}

/** Loads the principal for a token hash if the token is valid right now; otherwise throws UNAUTHENTICATED. */
export async function loadPrincipal(tx: WorkloomExecutor, tokenHash: string, at: Date, lockForWrite = false): Promise<ApiPrincipal> {
  const query = tx.select({ token: apiTokens, displayName: users.displayName, kind: users.kind })
    .from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId)).where(eq(apiTokens.tokenHash, tokenHash)).limit(1);
  // A write holds the token row in share mode so a concurrent revoke waits for it instead of racing it.
  const [row] = await (lockForWrite ? query.for('share', { of: apiTokens }) : query);
  if (!row || row.token.revokedAt !== null || row.token.expiresAt.getTime() <= at.getTime()) throw unauthenticatedError();
  return {
    tokenId: row.token.id, tokenName: row.token.name, userId: row.token.userId, displayName: row.displayName,
    kind: row.kind === 'real' ? 'real' : 'fixture', // Being allowed to change tasks always includes seeing them: the write is answered with the stored task.
    scopes: withImpliedRead(row.token.scopes as ApiTokenScope[]),
    workspaceIds: row.token.workspaceIds ?? null, expiresAt: row.token.expiresAt,
  };
}

function withImpliedRead(scopes: readonly ApiTokenScope[]): ApiTokenScope[] {
  return scopes.includes('tasks:write') && !scopes.includes('read') ? ['read', ...scopes] : [...scopes];
}

export async function issueApiToken(tx: WorkloomExecutor, userId: string, input: CreateApiTokenInput): Promise<CreatedApiTokenDto> {
  const parsed = createApiTokenInputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError('VALIDATION_FAILED', 'Invalid token request.');
  const p = parsed.data;
  // Two simultaneous requests must not both pass the count below.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'api-token-issue:' + userId}))`);
  const existing = await tx.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.userId, userId), sql`${apiTokens.revokedAt} is null`, sql`${apiTokens.expiresAt} > now()`)).limit(API_TOKEN_LIMITS.tokensPerUser + 1);
  if (existing.length >= API_TOKEN_LIMITS.tokensPerUser) throw new DomainError('DOMAIN_VALIDATION_FAILED', `At most ${API_TOKEN_LIMITS.tokensPerUser} active tokens per user. Revoke one first.`);
  const generated = generateApiToken();
  const createdAt = await databaseNow(tx);
  const expiresAt = new Date(createdAt.getTime() + p.expiresInDays * 86_400_000);
  const [row] = await tx.insert(apiTokens).values({
    id: generated.id, userId, name: p.name, tokenHash: generated.hash, tokenPrefix: generated.prefix,
    scopes: p.scopes, workspaceIds: p.workspaceIds && p.workspaceIds.length > 0 ? [...new Set(p.workspaceIds.map(id => id.toLowerCase()))] : null,
    createdAt, expiresAt,
  }).returning();
  if (!row) throw new Error('Token insert returned no row.');
  return { ...toDto(row), token: generated.token };
}

export async function listApiTokens(tx: WorkloomExecutor, userId: string): Promise<ApiTokenDto[]> {
  const rows = await tx.select().from(apiTokens).where(eq(apiTokens.userId, userId)).orderBy(desc(apiTokens.createdAt)).limit(200);
  return rows.map(toDto);
}

export async function revokeApiToken(tx: WorkloomExecutor, userId: string, tokenId: string): Promise<ApiTokenDto> {
  const [row] = await tx.select().from(apiTokens).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId))).limit(1);
  if (!row) throw notFoundError();
  if (row.revokedAt !== null) return toDto(row);
  const [updated] = await tx.update(apiTokens).set({ revokedAt: await databaseNow(tx) }).where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId))).returning();
  return toDto(updated ?? row);
}
