import { createHash, randomBytes } from 'node:crypto';

/**
 * In-memory, bounded, expiring store of development sessions. The cookie holds
 * a random opaque token; the store keys entries by its SHA-256 so the token
 * itself is never kept. Restarting the API forgets all sessions.
 */
export const DEV_SESSION_COOKIE = 'workloom_dev_session';

export interface DevSessionStore {
  /** Creates a session for an already-validated fixture actor and returns the opaque token. */
  create(actorId: string): string;
  /** Actor of a live session, or null for unknown/expired tokens. */
  resolve(token: string): string | null;
  revoke(token: string): void;
}

export interface DevSessionStoreOptions {
  readonly ttlMs?: number;
  readonly maxSessions?: number;
  readonly now?: () => number;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createDevSessionStore(options: DevSessionStoreOptions = {}): DevSessionStore {
  const ttlMs = options.ttlMs ?? 8 * 60 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 64;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { actorId: string; expiresAt: number }>();

  function purgeExpired(): void {
    const current = now();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(key);
    }
  }

  return {
    create(actorId) {
      purgeExpired();
      while (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next();
        if (oldest.done === true) break;
        sessions.delete(oldest.value);
      }
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), { actorId, expiresAt: now() + ttlMs });
      return token;
    },
    resolve(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const key = digest(token);
      const session = sessions.get(key);
      if (session === undefined) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(key);
        return null;
      }
      return session.actorId;
    },
    revoke(token) {
      if (TOKEN_PATTERN.test(token)) sessions.delete(digest(token));
    },
  };
}

/** Reads one cookie value from a Cookie header without throwing on malformed input. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header.length > 8192) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${DEV_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
