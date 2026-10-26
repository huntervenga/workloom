import {
  devActorListResponseSchema,
  devSessionInputSchema,
  idSchema,
  meResponseSchema,
  membershipListResponseSchema,
  safeProfilePhotoUrl,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type ActorDto,
  type MeDto,
} from '@workloom/contracts';
import { FIXTURE_ACTOR_IDS, type ReadinessProbe } from '@workloom/db';
import {
  getCurrentActor,
  getWorkspaceForActor,
  listWorkspaceMembers,
  listWorkspacesForActor,
  notFoundError,
  type AccessRepository,
  type UserSettingsApplication,
  type Actor,
  type ActorContext,
} from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { DEV_SESSION_COOKIE, readCookie, serializeSessionCookie, type DevSessionStore } from '../identity/dev-sessions.js';
import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { HttpError } from './errors.js';

export interface RouteDependencies {
  readonly userSettings?: UserSettingsApplication;
  readonly repository: AccessRepository;
  readonly identity: IdentityAdapter;
  readonly readiness: ReadinessProbe;
  readonly devSessions: DevSessionStore;
  readonly devSessionTtlSeconds: number;
}

const workspaceParamsSchema = z.object({ workspaceId: idSchema });

function toActorDto(actor: Pick<Actor, 'userId' | 'displayName' | 'kind'>): ActorDto {
  return { id: actor.userId, displayName: actor.displayName, kind: actor.kind };
}

function toMe(actor: Actor, authMode: IdentityAdapter['mode']): MeDto {
  return { actor: { ...toActorDto(actor), avatarUrl: safeProfilePhotoUrl(actor.avatarUrl) }, authMode };
}

export function registerHealthRoutes(app: FastifyInstance, readiness: ReadinessProbe): void {
  app.get('/healthz/live', async (_request, reply) => reply.send({ status: 'ok' }));

  app.get('/healthz/ready', async (request, reply) => {
    const report = await readiness.check();
    if (!report.ready) {
      request.log.warn({ readiness: report.checks, diagnostic: report.diagnostic }, 'readiness check failed');
    }
    return reply.code(report.ready ? 200 : 503).send({ status: report.ready ? 'ok' : 'unavailable', checks: report.checks });
  });
}

export function registerApiRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  async function actorContext(request: FastifyRequest): Promise<ActorContext> {
    const actor = await deps.identity.resolveActor(request);
    return { actor, source: 'web', requestId: request.id };
  }

  app.get('/api/v1/me', async (request, reply) => {
    const context = await actorContext(request);
    const user = await getCurrentActor(deps.repository, context);
    const settings = await deps.userSettings?.get(context);
    return sendData(
      request,
      reply,
      meResponseSchema,
      { ...toMe({ userId: user.id, displayName: user.displayName, kind: user.kind, avatarUrl: user.avatarUrl ?? null }, deps.identity.mode), ...(settings ? { settings } : {}) },
    );
  });

  app.get('/api/v1/workspaces', async (request, reply) => {
    const workspaces = await listWorkspacesForActor(deps.repository, await actorContext(request));
    return sendData(
      request,
      reply,
      workspaceListResponseSchema,
      workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name, role: workspace.role, timezone: workspace.timezone, weekStart: workspace.weekStart, ...(workspace.slug === undefined ? {} : { slug: workspace.slug }), ...(workspace.slugRevision === undefined ? {} : { slugRevision: workspace.slugRevision }), ...(workspace.slugAliases === undefined ? {} : { slugAliases: workspace.slugAliases }) })),
      { list: true },
    );
  });

  app.get('/api/v1/workspaces/:workspaceId', async (request, reply) => {
    const { workspaceId } = parseInput(workspaceParamsSchema, request.params);
    const { actor } = await actorContext(request);
    const workspace = await getWorkspaceForActor(deps.repository, { actor, workspaceId });
    return sendData(request, reply, workspaceResponseSchema, {
      id: workspace.id,
      name: workspace.name,
      role: workspace.role,
      timezone: workspace.timezone,
      weekStart: workspace.weekStart,
      ...(workspace.slug === undefined ? {} : { slug: workspace.slug }),
      ...(workspace.slugRevision === undefined ? {} : { slugRevision: workspace.slugRevision }),
      ...(workspace.slugAliases === undefined ? {} : { slugAliases: workspace.slugAliases }),
    });
  });

  app.get('/api/v1/workspaces/:workspaceId/memberships', async (request, reply) => {
    const { workspaceId } = parseInput(workspaceParamsSchema, request.params);
    const { actor } = await actorContext(request);
    const members = await listWorkspaceMembers(deps.repository, { actor, workspaceId });
    return sendData(
      request,
      reply,
      membershipListResponseSchema,
      members.map((member) => ({
        id: member.id,
        workspaceId: member.workspaceId,
        userId: member.userId,
        displayName: member.displayName,
        avatarUrl: safeProfilePhotoUrl(member.avatarUrl),
        role: member.role,
      })),
      { list: true },
    );
  });
}

/** Local-only actor switcher. Registered only for APP_ENV=local + AUTH_MODE=dev. */
export function registerDevRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  app.get('/api/v1/dev/actors', async (request, reply) => {
    const users = await deps.repository.findUsers(FIXTURE_ACTOR_IDS);
    const actors = FIXTURE_ACTOR_IDS.flatMap((id) => {
      const user = users.find((candidate) => candidate.id === id && candidate.kind === 'fixture');
      return user === undefined ? [] : [toActorDto({ userId: user.id, displayName: user.displayName, kind: user.kind })];
    });
    return sendData(request, reply, devActorListResponseSchema, actors, { list: true });
  });

  app.post('/api/v1/dev/session', async (request, reply) => {
    if (request.headers['x-workloom-dev-tool'] !== '1') {
      throw new HttpError(403, 'DEV_TOOL_REQUIRED', 'Actor switching requires the local development tool.');
    }
    // The global guard already requires a trusted Origin; switching additionally requires same-origin.
    const host = request.headers.host?.toLowerCase();
    if (host === undefined || request.headers.origin !== `http://${host}`) {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Actor switching must come from the same origin.');
    }

    const { actorId } = parseInput(devSessionInputSchema, request.body);
    const normalized = actorId.toLowerCase();
    if (!FIXTURE_ACTOR_IDS.includes(normalized)) {
      throw notFoundError();
    }
    const user = await deps.repository.findUser(normalized);
    if (user === null || user.kind !== 'fixture') {
      throw notFoundError();
    }

    const previous = readCookie(request.headers.cookie, DEV_SESSION_COOKIE);
    if (previous !== undefined) deps.devSessions.revoke(previous);
    const token = deps.devSessions.create(user.id);
    reply.header('set-cookie', serializeSessionCookie(token, deps.devSessionTtlSeconds));
    request.log.info({ event: 'dev_session_switched' }, 'development actor switched');
    return sendData(request, reply, meResponseSchema, toMe({ userId: user.id, displayName: user.displayName, kind: user.kind }, 'dev'));
  });
}
