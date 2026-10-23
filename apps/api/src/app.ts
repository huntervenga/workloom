import {managedLocalAsanaTarget,registerLocalAsanaImportRoutes,type LocalAsanaImporter} from './http/local-asana-import-routes.js';
import { registerWorkspaceSlugRoutes } from './http/workspace-slug-routes.js';
import { createWorkspaceSlugApplication } from '@workloom/db';
import type { WorkspaceSlugApplication } from '@workloom/domain';
import {registerSharedActivityRoutes} from './http/shared-activity-routes.js';
import {registerSummaryTemplateRoutes} from './http/summary-template-routes.js';
import type { DuplicationApplication } from '@workloom/domain';
import { createDuplicationApplication } from '@workloom/db';
import { registerDuplicationRoutes } from './http/duplication-routes.js';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  createAccessRepository,
  createDatabase,
  createCutoffApplication,
  createDependencyApplication,
  createMeetingApplication,
  createInboxApplication,
  createMyTasksApplication,
  createWorkspaceChangeHeadApplication,
  createLocalCredentialApplication,
  createTeamApplication,
  createLocalMcpApplication,
  createAutomationApplication,
  createTaskDefaultsApplication,
  createProjectCopyApplication,
  createTaskContinuationApplication,
  type AutomationApplication,
  createPlanningApplication,
  createProjectImportApplication,
  createReadinessProbe,
  createRecurrenceApplication,
  createSharedAuthStore,
  createTaskApplication,
  createTaskCommentsApplication,
  createPersonalTablePreferenceApplication,
  createTaskFieldApplication,
  createPlanningCheckApplication,
  createGenericReportApplication,
  createSummaryTemplateApplication,
  createSharedActivityApplication,
  createLeaveApplication,
  createTaskScheduleApplication,
  createTaskRowApplication,
  createWorkCategoryApplication,
  createWorkspaceCreateApplication,
  describeErrorForLog,
  FIXTURE_ACTOR_IDS,
  type Database,
  type ReadinessProbe,
} from '@workloom/db';
import type { InboxApplication, SharedActivityApplication, SummaryTemplateApplication, PlanningCheckApplication, LeaveApplication, GenericReportApplication, TeamApplication, CutoffApplication, PersonalTablePreferenceApplication, TaskCommentsApplication, MyTasksApplication, WorkspaceChangeHeadApplication, LocalCredentialApplication, LocalMcpApplication, TaskDefaultsApplication, ProjectCopyApplication, TaskContinuationApplication, AccessRepository, DependencyApplication, MeetingApplication, PlanningApplication, ProjectImportApplication, RecurrenceApplication, SharedAuthStore, TaskScheduleApplication, TaskApplication, TaskFieldApplication, TaskRowApplication, WorkCategoryApplication, WorkspaceCreateApplication } from '@workloom/domain';
import Fastify, { type FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';

import type { AppConfig } from './config.js';
import { createDevSessionStore, type DevSessionStore } from './identity/dev-sessions.js';
import { createDevIdentityAdapter, type IdentityAdapter } from './identity/identity-adapter.js';
import { createSharedAuthService, type AuthFetch, type SharedAuthService } from './identity/shared-auth.js';
import { registerAuthConfigRoute, registerSharedAuthRoutes } from './http/auth-routes.js';
import { createInvitationHandoff } from './identity/invitation-handoff.js';
import { HttpError, mapError } from './http/errors.js';
import { registerCutoffRoutes } from './http/cutoff-routes.js';
import { registerCategoryRoutes } from './http/category-routes.js';
import {registerLeaveRoutes} from './http/leave-routes.js';
import {registerPlanningCheckRoutes} from './http/planning-check-routes.js';
import { registerGenericReportRoutes } from './http/generic-report-routes.js';
import { registerFieldRoutes } from './http/field-routes.js';
import { registerDependencyRoutes } from './http/dependency-routes.js';
import { registerMeetingRoutes } from './http/meeting-routes.js';
import { registerImportRoutes } from './http/import-routes.js';
import {registerLocalMcpRoutes} from './http/local-mcp-routes.js';
import { registerTaskContinuationRoutes } from './http/task-continuation-routes.js';
import { registerProjectCopyRoutes } from './http/project-copy-routes.js';
import { registerTaskDefaultsRoutes } from './http/task-defaults-routes.js';
import { registerApiTokenRoutes } from './http/api-token-routes.js';
import { PUBLIC_API_PREFIX, registerPublicApiRoutes } from './http/public-api-routes.js';
import { MCP_PATH, registerMcpHttp } from './http/mcp-http.js';
import { registerPlanningRoutes } from './http/planning-routes.js';
import { registerRecurrenceRoutes } from './http/recurrence-routes.js';
import { registerScheduleRoutes } from './http/schedule-routes.js';
import { assertAllowedHost, assertTrustedOrigin, type RequestGuardOptions } from './http/request-guards.js';
import { registerApiRoutes, registerDevRoutes, registerHealthRoutes } from './http/routes.js';
import { registerTaskRoutes } from './http/task-routes.js';
import { registerTaskRowRoutes } from './http/task-row-routes.js';
import { registerWorkspaceCreateRoutes } from './http/workspace-create-routes.js';
import { registerTeamRoutes } from './http/team-routes.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { createRateLimiter } from './http/rate-limit.js';
import { registerInboxRoutes } from './http/inbox-routes.js';
import { registerMyTasksRoutes } from './http/my-tasks-routes.js';
import { registerWorkspaceChangeHeadRoutes } from './http/workspace-change-head-routes.js';
import { registerTaskCommentsRoutes } from './http/task-comments-routes.js';
import { registerPersonalTablePreferenceRoutes } from './http/table-preferences-routes.js';
import { DEFAULT_WEB_DIST_DIR,registerStaticWeb, replyWebNavigation, resolveWebDist } from './http/static-web.js';

export interface AppDependencies {
  readonly workspaceSlugApplication?: WorkspaceSlugApplication;
  readonly sharedActivityApplication?: SharedActivityApplication;
  readonly duplicationApplication?: DuplicationApplication;
  readonly leaveApplication?: LeaveApplication;
  readonly genericReportApplication?: GenericReportApplication;
  readonly summaryTemplateApplication?: SummaryTemplateApplication;
  readonly planningCheckApplication?: PlanningCheckApplication;
  readonly teamApplication?: TeamApplication;
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
  /** Atomic table-row creation (task, first values, explicit plan/actual); same existing pool. */
  readonly taskRowApplication?: TaskRowApplication;
  /** Real-user workspace creation; registered only for shared identity. Same existing pool. */
  readonly workspaceCreateApplication?: WorkspaceCreateApplication;
  /** Self-only workspace task inbox; reads share one read-only snapshot. */
  readonly myTasksApplication?: MyTasksApplication;
  readonly inboxApplication?: InboxApplication;
  /** Authorized current-workspace head; uses one read-only snapshot. */
  readonly workspaceChangeHeadApplication?: WorkspaceChangeHeadApplication;
  readonly taskCommentsApplication?: TaskCommentsApplication;
  readonly personalTablePreferenceApplication?: PersonalTablePreferenceApplication;
  /**
   * Overrides the custom field service built from the database (HTTP tests). Without it and
   * without a database (P0/P1a HTTP tests), the P1b field routes are not registered.
   */
  readonly taskFieldApplication?: TaskFieldApplication;
  /** Shared planning service, or an injected transport-test port; uses the existing pool. */
  readonly planningApplication?: PlanningApplication;
  readonly cutoffApplication?: CutoffApplication;
  /** Category binding, reasoned recategorization and work-type reporting; same existing pool. */
  readonly workCategoryApplication?: WorkCategoryApplication;
  /** Shared dated-meeting service; current ACL and attendance guards stay in domain. */
  readonly meetingApplication?: MeetingApplication;
  /** Shared P3b recurrence service, or an injected transport-test port; uses the existing pool. */
  readonly recurrenceApplication?: RecurrenceApplication;
  /** P4a shared application from the existing pool, injectable for transport tests. */
  readonly dependencyApplication?: DependencyApplication;
  /** P4b schedule application; same existing pool, injectable for focused transport tests. */
  readonly taskScheduleApplication?: TaskScheduleApplication;
  /** P5a bounded file import, current privileged source access and atomic apply owned by domain. */
  readonly projectImportApplication?: ProjectImportApplication;
  /** Credential-bound MCP facade; writes require current scopes and the shared barrier check. */
  readonly localCredentialApplication?: LocalCredentialApplication;
  readonly localMcpApplication?: LocalMcpApplication;
  /** Personal access tokens, the public REST API and the remote MCP share this one core. */
  readonly automationApplication?: AutomationApplication;
  readonly taskDefaultsApplication?: TaskDefaultsApplication;
  readonly projectCopyApplication?: ProjectCopyApplication;
  readonly taskContinuationApplication?: TaskContinuationApplication;
  /** Trusted local test port; registration still requires local/shared managed target. */
  readonly localAsanaImporter?: LocalAsanaImporter;
  readonly identityAdapter?: IdentityAdapter;
  readonly devSessions?: DevSessionStore;
  /** AUTH_MODE=shared store; without it the store is built from the database (never in-memory). */
  readonly sharedAuthStore?: SharedAuthStore;
  /** JWT key resolver for focused crypto tests; default is the remote JWKS. */
  readonly authJwtKey?: JWTVerifyGetKey;
  /** Auth refresh/logout HTTP seam for focused tests; JWT verification never uses it. */
  readonly authFetch?: AuthFetch;
  /** Shared Auth clock for focused tests. */
  readonly clock?: () => Date;
  /** Web dist directory; null disables static serving. Default: apps/web/dist when config.serveWeb. */
  readonly webDistDir?: string | null;
  /** false disables logging (tests). */
  readonly logger?: boolean;
}

const DEV_SESSION_TTL_SECONDS = 8 * 60 * 60;
const BODY_LIMIT_BYTES = 16 * 1024;

/** Defense in depth: the request serializer below already omits headers, bodies and query strings. */
const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'req.body.secret',
  'req.body.secretHash',
  'body.secret',
  'body.secretHash',
  'req.body.accessToken',
  'req.body.refreshToken',
  'req.body.state',
  'req.query.returnTo',
  'req.query.state',
  'body.accessToken',
  'body.refreshToken',
  'body.state',
];

/** Logs method and path only; the query string (returnTo, state) never reaches the log. */
function serializeRequestForLog(request: { readonly method?: string | undefined; readonly url?: string | undefined }): {
  method: string;
  url: string;
} {
  return { method: request.method ?? '', url: (request.url ?? '').split(/[?#]/, 1)[0] ?? '' };
}

/**
 * Builds the Fastify app without listening. Opens a database pool only when
 * the repository or readiness probe is not injected; an owned pool is closed
 * in onClose. Never runs migrations.
 */
export async function createApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const ownsDatabase =
    dependencies.database === undefined && (dependencies.accessRepository === undefined || dependencies.readiness === undefined);
  const database = dependencies.database ?? (ownsDatabase ? createDatabase(config.database.url, { requireLoopback: config.appEnv === 'local' }) : undefined);

  const repository = dependencies.accessRepository ?? (database === undefined ? undefined : createAccessRepository(database));
  const readiness = dependencies.readiness ?? (database === undefined ? undefined : createReadinessProbe(database));
  if (repository === undefined || readiness === undefined) {
    throw new Error('createApp needs a database or both accessRepository and readiness.');
  }
  // Reuses the same pool; no additional connection is opened.
  const workspaceSlugApplication = dependencies.workspaceSlugApplication ?? (database === undefined ? undefined : createWorkspaceSlugApplication(database));
  const taskApplication = dependencies.taskApplication ?? (database === undefined ? undefined : createTaskApplication(database));
  const duplicationApplication = dependencies.duplicationApplication ?? (database === undefined ? undefined : createDuplicationApplication(database));
  const taskRowApplication = dependencies.taskRowApplication ?? (database === undefined ? undefined : createTaskRowApplication(database));
  const workspaceCreateApplication =
    dependencies.workspaceCreateApplication ?? (database === undefined ? undefined : createWorkspaceCreateApplication(database));
  const inboxApplication = dependencies.inboxApplication ?? (database === undefined ? undefined : createInboxApplication(database));
  const myTasksApplication = dependencies.myTasksApplication ?? (database === undefined ? undefined : createMyTasksApplication(database));
  const workspaceChangeHeadApplication = dependencies.workspaceChangeHeadApplication ?? (database === undefined ? undefined : createWorkspaceChangeHeadApplication(database));
  const taskCommentsApplication = dependencies.taskCommentsApplication ?? (database === undefined ? undefined : createTaskCommentsApplication(database));
  const personalTablePreferenceApplication = dependencies.personalTablePreferenceApplication ?? (database === undefined ? undefined : createPersonalTablePreferenceApplication(database));
  const taskFieldApplication =
    dependencies.taskFieldApplication ?? (database === undefined ? undefined : createTaskFieldApplication(database));
  const leaveApplication = dependencies.leaveApplication ?? (database === undefined ? undefined : createLeaveApplication(database));
  const planningCheckApplication=dependencies.planningCheckApplication??(database===undefined?undefined:createPlanningCheckApplication(database));
  const sharedActivityApplication=dependencies.sharedActivityApplication??(database===undefined?undefined:createSharedActivityApplication(database));
  const summaryTemplateApplication=dependencies.summaryTemplateApplication??(database===undefined?undefined:createSummaryTemplateApplication(database));
  const genericReportApplication = dependencies.genericReportApplication ?? (database === undefined ? undefined : createGenericReportApplication(database));
  const planningApplication =
    dependencies.planningApplication ?? (database === undefined ? undefined : createPlanningApplication(database));
  const cutoffApplication = dependencies.cutoffApplication ?? (database === undefined ? undefined : createCutoffApplication(database));
  const workCategoryApplication =
    dependencies.workCategoryApplication ?? (database === undefined ? undefined : createWorkCategoryApplication(database));
  const meetingApplication =
    dependencies.meetingApplication ?? (database === undefined ? undefined : createMeetingApplication(database));
  const recurrenceApplication =
    dependencies.recurrenceApplication ?? (database === undefined ? undefined : createRecurrenceApplication(database));
  const dependencyApplication =
    dependencies.dependencyApplication ?? (database === undefined ? undefined : createDependencyApplication(database));
  const taskScheduleApplication =
    dependencies.taskScheduleApplication ?? (database === undefined ? undefined : createTaskScheduleApplication(database));
  const projectImportApplication =
    dependencies.projectImportApplication ?? (database === undefined ? undefined : createProjectImportApplication(database));
  const teamApplication=dependencies.teamApplication??(database===undefined?undefined:createTeamApplication(database));
  const localCredentialApplication=dependencies.localCredentialApplication??(database===undefined?undefined:createLocalCredentialApplication(database,{enableTaskWrites:true}));
  const taskContinuationApplication=dependencies.taskContinuationApplication??(database===undefined?undefined:createTaskContinuationApplication(database));
  const projectCopyApplication=dependencies.projectCopyApplication??(database===undefined?undefined:createProjectCopyApplication(database));
  const taskDefaultsApplication=dependencies.taskDefaultsApplication??(database===undefined?undefined:createTaskDefaultsApplication(database));
  const automationApplication=dependencies.automationApplication??(database===undefined?undefined:createAutomationApplication(database));
  const localMcpApplication=dependencies.localMcpApplication??(database===undefined?undefined:createLocalMcpApplication(database,{enableTaskWrites:true}));
  const devSessions = dependencies.devSessions ?? createDevSessionStore({ ttlMs: DEV_SESSION_TTL_SECONDS * 1000 });

  let sharedAuth: SharedAuthService | undefined;
  if (config.authMode === 'shared') {
    if (config.sharedAuth === undefined) {
      throw new Error('AUTH_MODE=shared requires the shared Auth configuration.');
    }
    const store = dependencies.sharedAuthStore ?? (database === undefined ? undefined : createSharedAuthStore(database));
    if (store === undefined) {
      throw new Error('AUTH_MODE=shared needs a database or an injected sharedAuthStore.');
    }
    sharedAuth = createSharedAuthService({
      config: config.sharedAuth,
      store,
      repository,
      ...(dependencies.authFetch === undefined ? {} : { fetch: dependencies.authFetch }),
      ...(dependencies.authJwtKey === undefined ? {} : { jwtKey: dependencies.authJwtKey }),
      ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
    });
  }

  const identity =
    dependencies.identityAdapter ??
    sharedAuth?.identity ??
    createDevIdentityAdapter({ defaultActorId: config.devActorId, allowlist: FIXTURE_ACTOR_IDS, sessions: devSessions, repository });

  const app = Fastify({
    logger:
      dependencies.logger === false
        ? false
        : {
            level: config.logLevel,
            serializers: { req: serializeRequestForLog },
            redact: {
              paths: LOG_REDACT_PATHS,
              censor: '[redacted]',
            },
          },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    // Behind a reverse proxy the client address comes from X-Forwarded-For, trusted for exactly this many hops.
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
    bodyLimit: BODY_LIMIT_BYTES,
    return503OnClosing: true,
  });

  if (ownsDatabase && database !== undefined) {
    app.addHook('onClose', async () => {
      await database.close();
    });
  }

  const guardOptions: RequestGuardOptions = {
    hosted: config.appEnv !== 'local',
    appOrigins: config.appOrigins,
    getPort: () => {
      if (config.port !== 0) return config.port;
      const address = app.server.address();
      return typeof address === 'object' && address !== null ? (address as AddressInfo).port : 0;
    },
  };

  const tokenLimiter = createRateLimiter({ limit: 300, windowMs: 60_000 });
  const sessionRouteLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
  const anonymousLimiter = createRateLimiter({ limit: 600, windowMs: 60_000 });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (request.url.startsWith('/api') || request.url.startsWith('/healthz')) {
      reply.header('cache-control', 'no-store');
    }
    assertAllowedHost(request, guardOptions);
    // Bearer-only surfaces never read cookies, so the browser cross-site guard does not apply to them.
    const path = request.url.split('?', 1)[0] ?? '';
    if (!(path.startsWith(`${PUBLIC_API_PREFIX}/`) || path === MCP_PATH)) {
      assertTrustedOrigin(request, guardOptions);
      // Sign-in, invitation acceptance and workspace creation are reachable by anyone with (or without) a session: bound them per address.
      if (path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/invitations') || (request.method === 'POST' && path === '/api/v1/workspaces')) {
        const decision = sessionRouteLimiter.check(`${request.ip}|${path.startsWith('/api/v1/auth/') ? 'auth' : 'account'}`);
        if (!decision.allowed) {
          reply.header('retry-after', String(decision.retryAfterSeconds));
          throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.', { retryAfterSeconds: decision.retryAfterSeconds }, { retryable: true });
        }
      }
    } else {
      // Per token when one is presented, otherwise per address, with a lower ceiling for guessing.
      const bearer = /^Bearer (wlm_pat_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
      const decision = bearer ? tokenLimiter.check(createHash('sha256').update(bearer).digest('hex')) : anonymousLimiter.check(request.ip);
      if (!decision.allowed) {
        reply.header('retry-after', String(decision.retryAfterSeconds));
        throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Wait a moment and try again.', { retryAfterSeconds: decision.retryAfterSeconds }, { retryable: true });
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.unexpected) {
      request.log.error({ err: describeErrorForLog(error) }, 'request failed');
    } else if (mapped.statusCode >= 500) {
      request.log.warn({ err: describeErrorForLog(error), code: mapped.body.error.code }, 'request unavailable');
    }
    if (error instanceof HttpError && error.setCookies !== undefined) {
      reply.header('set-cookie', [...error.setCookies]);
    }
    return reply.code(mapped.statusCode).type('application/json; charset=utf-8').send({ ...mapped.body, meta: { requestId: request.id } });
  });

  const webDistCandidate =
    dependencies.webDistDir !== undefined ? dependencies.webDistDir : config.serveWeb ? DEFAULT_WEB_DIST_DIR : null;
  const webDist = webDistCandidate === null ? null : resolveWebDist(webDistCandidate);

  app.setNotFoundHandler((request, reply) => {
    const navigation = webDist === null ? null : replyWebNavigation(request, reply);
    if (navigation !== null) {
      return navigation;
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
  registerAuthConfigRoute(app, config.authMode);
  if (sharedAuth !== undefined) {
    registerSharedAuthRoutes(app, { service: sharedAuth, ...(config.sharedAuth && teamApplication ? { invitationHandoff: createInvitationHandoff(config.sharedAuth, dependencies.clock), team: teamApplication } : {}) });
  }
  registerApiRoutes(app, routeDeps);
  if(managedLocalAsanaTarget(config.appEnv,config.authMode,config.database.url)){
    let importer=dependencies.localAsanaImporter;
    if(!importer){const adapterUrl=new URL('../../../scripts/asana-browser-import.mjs',import.meta.url).href;const adapter=await import(adapterUrl) as {createAsanaBrowserImporter:(options:{databaseUrl:string})=>LocalAsanaImporter};importer=adapter.createAsanaBrowserImporter({databaseUrl:config.database.url});}
    registerLocalAsanaImportRoutes(app,{identity,repository,importer});
  }
  if (identity.mode === 'shared' && workspaceCreateApplication !== undefined) {
    registerWorkspaceCreateRoutes(app, { identity, workspaces: workspaceCreateApplication });
  }
  if (identity.mode === 'shared' && teamApplication !== undefined) {
    registerTeamRoutes(app, {identity,team:teamApplication});
  }
  if (taskApplication !== undefined) {
    registerTaskRoutes(app, { identity, tasks: taskApplication });
  }
  if (duplicationApplication !== undefined) registerDuplicationRoutes(app, { identity, duplication: duplicationApplication });
  if (taskRowApplication !== undefined) {
    registerTaskRowRoutes(app, { identity, rows: taskRowApplication });
  }
  if (workspaceChangeHeadApplication !== undefined) {
    registerWorkspaceChangeHeadRoutes(app, { identity, workspaceChangeHead: workspaceChangeHeadApplication });
  }
  if (inboxApplication !== undefined) registerInboxRoutes(app, { identity, inbox: inboxApplication });
  if (myTasksApplication !== undefined) {
    registerMyTasksRoutes(app, { identity, myTasks: myTasksApplication });
  }
  if (workspaceSlugApplication !== undefined) registerWorkspaceSlugRoutes(app, { identity, slugs: workspaceSlugApplication });
  if (taskCommentsApplication !== undefined) registerTaskCommentsRoutes(app, { identity, comments: taskCommentsApplication });
  if (personalTablePreferenceApplication !== undefined) registerPersonalTablePreferenceRoutes(app, { identity, preferences: personalTablePreferenceApplication });
  if (taskFieldApplication !== undefined) {
    registerFieldRoutes(app, { identity, fields: taskFieldApplication });
  }
  if (leaveApplication !== undefined) registerLeaveRoutes(app,{identity,leave:leaveApplication});
  if(sharedActivityApplication!==undefined)registerSharedActivityRoutes(app,{identity,activities:sharedActivityApplication});
  if(summaryTemplateApplication!==undefined)registerSummaryTemplateRoutes(app,{identity,templates:summaryTemplateApplication});
  if(planningCheckApplication!==undefined)registerPlanningCheckRoutes(app,{identity,checks:planningCheckApplication});
  if (genericReportApplication !== undefined) registerGenericReportRoutes(app, { identity, reports: genericReportApplication });
  if (planningApplication !== undefined) {
    registerPlanningRoutes(app, { identity, planning: planningApplication });
  }
  if (cutoffApplication !== undefined) registerCutoffRoutes(app, { identity, cutoff: cutoffApplication });
  if (workCategoryApplication !== undefined) {
    registerCategoryRoutes(app, { identity, categories: workCategoryApplication });
  }
  if (meetingApplication !== undefined) {
    registerMeetingRoutes(app, { identity, meetings: meetingApplication });
  }
  if (recurrenceApplication !== undefined) {
    registerRecurrenceRoutes(app, { identity, recurrence: recurrenceApplication });
  }
  if (dependencyApplication !== undefined) {
    registerDependencyRoutes(app, { identity, dependencies: dependencyApplication });
  }
  if (taskScheduleApplication !== undefined) {
    registerScheduleRoutes(app, { identity, schedule: taskScheduleApplication });
  }
  if (projectImportApplication !== undefined) {
    registerImportRoutes(app, { identity, imports: projectImportApplication });
  }
  if(localCredentialApplication!==undefined&&localMcpApplication!==undefined){registerLocalMcpRoutes(app,{identity,credentials:localCredentialApplication,mcp:localMcpApplication,guards:guardOptions});}
  if (taskContinuationApplication !== undefined) registerTaskContinuationRoutes(app, { identity, continuation: taskContinuationApplication });
  if (projectCopyApplication !== undefined) registerProjectCopyRoutes(app, { identity, copies: projectCopyApplication });
  if (taskDefaultsApplication !== undefined) registerTaskDefaultsRoutes(app, { identity, defaults: taskDefaultsApplication });
  if (automationApplication !== undefined) {
    registerApiTokenRoutes(app, { identity, automation: automationApplication });
    registerPublicApiRoutes(app, { automation: automationApplication });
    registerMcpHttp(app, { automation: automationApplication });
  }
  if (config.appEnv === 'local' && config.authMode === 'dev') {
    registerDevRoutes(app, routeDeps);
  }
  registerSecurityHeaders(app, { webDistDir: webDist, hosted: config.appEnv !== 'local' });
  if (webDist !== null) {
    await registerStaticWeb(app, webDist);
  }

  return app;
}

/** Alias kept for harnesses that prefer the buildApp name. */
export const buildApp = createApp;
