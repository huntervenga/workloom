import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  createAccessRepository,
  createDatabase,
  createReadinessProbe,
  createTaskApplication,
  describeErrorForLog,
  FIXTURE_ACTOR_IDS,
  type Database,
  type ReadinessProbe,
} from '@workloom/db';
import type { AccessRepository, TaskApplication } from '@workloom/domain';
import Fastify, { type FastifyInstance } from 'fastify';

import type { AppConfig } from './config.js';
import { createDevSessionStore, type DevSessionStore } from './identity/dev-sessions.js';
import { createDevIdentityAdapter, type IdentityAdapter } from './identity/identity-adapter.js';
import { mapError } from './http/errors.js';
import { assertAllowedHost, assertTrustedOrigin, type RequestGuardOptions } from './http/request-guards.js';
import { registerApiRoutes, registerDevRoutes, registerHealthRoutes } from './http/routes.js';
import { registerTaskRoutes } from './http/task-routes.js';
import { DEFAULT_WEB_DIST_DIR,registerStaticWeb, resolveWebDist, sendSpaIndex, shouldServeSpa } from './http/static-web.js';

export interface AppDependencies {
  /** Shared database. When given, the app does NOT close it. */
  readonly database?: Database;
  /** Overrides the repository built from the database (HTTP tests). */
  readonly accessRepository?: AccessRepository;
  /** Overrides the readiness probe built from the database (HTTP tests). */
  readonly readiness?: ReadinessProbe;
  /**
   * Overrides the task service built from the database (HTTP tests). Without it and without a
   * database (P0 HTTP tests), the P1a task routes are not registered.
   */
  readonly taskApplication?: TaskApplication;
  readonly identityAdapter?: IdentityAdapter;
  readonly devSessions?: DevSessionStore;
  /** Web dist directory; null disables static serving. Default: apps/web/dist when config.serveWeb. */
  readonly webDistDir?: string | null;
  /** false disables logging (tests). */
  readonly logger?: boolean;
}

const DEV_SESSION_TTL_SECONDS = 8 * 60 * 60;
const BODY_LIMIT_BYTES = 16 * 1024;

/**
 * Builds the Fastify app without listening. Opens a database pool only when
 * the repository or readiness probe is not injected; an owned pool is closed
 * in onClose. Never runs migrations.
 */
export async function createApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const ownsDatabase =
    dependencies.database === undefined && (dependencies.accessRepository === undefined || dependencies.readiness === undefined);
  const database = dependencies.database ?? (ownsDatabase ? createDatabase(config.database.url, { requireLoopback: true }) : undefined);

  const repository = dependencies.accessRepository ?? (database === undefined ? undefined : createAccessRepository(database));
  const readiness = dependencies.readiness ?? (database === undefined ? undefined : createReadinessProbe(database));
  if (repository === undefined || readiness === undefined) {
    throw new Error('createApp needs a database or both accessRepository and readiness.');
  }
  // Reuses the same pool; no additional connection is opened.
  const taskApplication = dependencies.taskApplication ?? (database === undefined ? undefined : createTaskApplication(database));
  const devSessions = dependencies.devSessions ?? createDevSessionStore({ ttlMs: DEV_SESSION_TTL_SECONDS * 1000 });
  const identity =
    dependencies.identityAdapter ??
    createDevIdentityAdapter({ defaultActorId: config.devActorId, allowlist: FIXTURE_ACTOR_IDS, sessions: devSessions, repository });

  const app = Fastify({
    logger:
      dependencies.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
              censor: '[redacted]',
            },
          },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: true,
  });

  if (ownsDatabase && database !== undefined) {
    app.addHook('onClose', async () => {
      await database.close();
    });
  }

  const guardOptions: RequestGuardOptions = {
    appOrigins: config.appOrigins,
    getPort: () => {
      if (config.port !== 0) return config.port;
      const address = app.server.address();
      return typeof address === 'object' && address !== null ? (address as AddressInfo).port : 0;
    },
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (request.url.startsWith('/api') || request.url.startsWith('/healthz')) {
      reply.header('cache-control', 'no-store');
    }
    assertAllowedHost(request, guardOptions);
    assertTrustedOrigin(request, guardOptions);
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.unexpected) {
      request.log.error({ err: describeErrorForLog(error) }, 'request failed');
    } else if (mapped.statusCode >= 500) {
      request.log.warn({ err: describeErrorForLog(error), code: mapped.body.error.code }, 'request unavailable');
    }
    return reply.code(mapped.statusCode).type('application/json; charset=utf-8').send({ ...mapped.body, meta: { requestId: request.id } });
  });

  const webDistCandidate =
    dependencies.webDistDir !== undefined ? dependencies.webDistDir : config.serveWeb ? DEFAULT_WEB_DIST_DIR : null;
  const webDist = webDistCandidate === null ? null : resolveWebDist(webDistCandidate);

  app.setNotFoundHandler((request, reply) => {
    if (webDist !== null && shouldServeSpa(request)) {
      return sendSpaIndex(reply);
    }
    return reply
      .code(404)
      .type('application/json; charset=utf-8')
      .send({
        error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', retryable: false },
        meta: { requestId: request.id },
      });
  });

  const routeDeps = { repository, identity, readiness, devSessions, devSessionTtlSeconds: DEV_SESSION_TTL_SECONDS };
  registerHealthRoutes(app, readiness);
  registerApiRoutes(app, routeDeps);
  if (taskApplication !== undefined) {
    registerTaskRoutes(app, { identity, tasks: taskApplication });
  }
  if (config.appEnv === 'local' && config.authMode === 'dev') {
    registerDevRoutes(app, routeDeps);
  }
  if (webDist !== null) {
    await registerStaticWeb(app, webDist);
  }

  return app;
}

/** Alias kept for harnesses that prefer the buildApp name. */
export const buildApp = createApp;
