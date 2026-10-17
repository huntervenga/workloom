import type { UserRecord } from '../access/ports.js';

/** Trusted claims verified by the API before provisioning; never merge by profile fields. */
export interface SharedAuthIdentityInput {
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly workspaceName: string;
  readonly timezone: string;
}

export interface SharedAuthIdentity {
  readonly user: UserRecord & { readonly kind: 'real' };
  readonly workspaceId: string;
  readonly membershipId: string;
}

/** Only a hash of the opaque cookie and API-encrypted token payload enter persistence. */
export interface SharedAuthSessionRecord {
  readonly sessionHash: string;
  readonly userId: string;
  readonly encryptedTokens: string;
  readonly accessExpiresAt: string;
  readonly expiresAt: string;
  readonly revision: number;
  readonly revokedAt: string | null;
}

export type SharedAuthSessionInput = Omit<SharedAuthSessionRecord, 'revision' | 'revokedAt'>;
export type SharedAuthSessionUpdate = Partial<Pick<SharedAuthSessionRecord,
  'encryptedTokens' | 'accessExpiresAt' | 'expiresAt' | 'revokedAt'>>;

export interface SharedAuthLoginAttemptInput {
  readonly stateHash: string;
  readonly browserHash: string;
  readonly returnTo: string;
  readonly expiresAt: string;
}

export interface SharedAuthLoginAttemptConsumeInput {
  readonly stateHash: string;
  readonly browserHash: string;
  readonly now: string;
}

/** All timestamp strings are ISO instants. Token encryption belongs to the API, not this port. */
export interface SharedAuthStore {
  provisionIdentity(input: SharedAuthIdentityInput): Promise<SharedAuthIdentity>;
  createSession(input: SharedAuthSessionInput): Promise<void>;
  /** The row lock spans callback and patch commit; expired rows are surfaced for API policy. */
  withLockedSession<T>(sessionHash: string, callback: (record: SharedAuthSessionRecord | null) => Promise<{
    readonly result: T;
    readonly update?: SharedAuthSessionUpdate;
  }>): Promise<T>;
  revokeSession(sessionHash: string): Promise<void>;
  createLoginAttempt(input: SharedAuthLoginAttemptInput): Promise<void>;
  consumeLoginAttempt(input: SharedAuthLoginAttemptConsumeInput): Promise<{ readonly returnTo: string } | null>;
}
