import { unauthenticatedError, type AccessRepository, type Actor } from '@workloom/domain';

import { DEV_SESSION_COOKIE, readCookie, type DevSessionStore } from './dev-sessions.js';

/** Minimal request view an identity adapter may inspect. Body, query and custom headers are never consulted. */
export interface IdentityRequest {
  readonly headers: { readonly cookie?: string | undefined };
}

export interface IdentityAdapter {
  readonly mode: 'dev' | 'shared';
  /** Resolves the trusted actor for a request or throws UNAUTHENTICATED. */
  resolveActor(request: IdentityRequest): Promise<Actor>;
}

export interface DevIdentityAdapterOptions {
  /** Server-configured default fixture actor. */
  readonly defaultActorId: string;
  /** Fixture allowlist; sessions for other IDs are ignored. */
  readonly allowlist: readonly string[];
  readonly sessions: DevSessionStore;
  readonly repository: AccessRepository;
}

/**
 * Development identity: the actor is the one selected by a server-owned dev
 * session cookie, otherwise the configured default. The user must exist in the
 * database as a fixture user. Headers such as x-user-id/x-actor-id are ignored.
 */
export function createDevIdentityAdapter(options: DevIdentityAdapterOptions): IdentityAdapter {
  return {
    mode: 'dev',
    async resolveActor(request) {
      const token = readCookie(request.headers.cookie, DEV_SESSION_COOKIE);
      const sessionActor = token === undefined ? null : options.sessions.resolve(token);
      const actorId = sessionActor !== null && options.allowlist.includes(sessionActor) ? sessionActor : options.defaultActorId;

      const user = await options.repository.findUser(actorId);
      if (user === null || user.kind !== 'fixture') {
        throw unauthenticatedError('The development actor is not available. Run npm run db:seed:demo.');
      }
      return { userId: user.id, displayName: user.displayName, kind: user.kind };
    },
  };
}
