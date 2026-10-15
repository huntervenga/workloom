import {
  DEFAULT_DEV_ACTOR_ID,
  findRailwayMarkers,
  isFixtureActorId,
  parseDatabaseUrl,
  type DatabaseUrlInfo,
} from '@workloom/db';

/**
 * Validated server configuration. P0 supports exactly one mode: APP_ENV=local,
 * AUTH_MODE=dev, loopback bind, loopback synthetic database. NODE_ENV only
 * describes the build (development/production) and never unlocks other modes.
 */
export const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type LoopbackBindHost = (typeof LOOPBACK_BIND_HOSTS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_PORT = 4310;
export const DEFAULT_APP_ORIGINS = ['http://127.0.0.1:4311', 'http://localhost:4311'] as const;

export interface AppConfig {
  readonly appEnv: 'local';
  readonly authMode: 'dev';
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly host: LoopbackBindHost;
  /** 0 = pick a free port at listen time (test harnesses). */
  readonly port: number;
  /** Validated DATABASE_URL. `info.url` is a secret: never log it. */
  readonly database: DatabaseUrlInfo;
  /** Fixture actor used when no dev session selects another one. */
  readonly devActorId: string;
  /** Extra trusted browser origins (Vite dev server); the API's own loopback origins are always trusted. */
  readonly appOrigins: readonly string[];
  readonly logLevel: LogLevel;
  /** Serve apps/web/dist (optimized build) from the API process. */
  readonly serveWeb: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Workloom API configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    raw.replace(/\/$/, '') !== url.origin
  ) {
    return null;
  }
  return url.origin;
}

/** Validates the process environment. Throws ConfigError listing every problem; never echoes secrets. */
export function loadConfig(env: Env = process.env): AppConfig {
  const issues: string[] = [];

  const railway = findRailwayMarkers(env);
  if (railway.length > 0) {
    issues.push(`Railway environment detected (${railway.join(', ')}); the development identity mode must not run there.`);
  }

  const appEnv = read(env, 'APP_ENV');
  if (appEnv === undefined) {
    issues.push('APP_ENV is required and must be "local".');
  } else if (appEnv === 'staging' || appEnv === 'production') {
    issues.push(`APP_ENV=${appEnv} is not supported yet: only APP_ENV=local with AUTH_MODE=dev is implemented (shared Auth arrives in P6).`);
  } else if (appEnv !== 'local') {
    issues.push('APP_ENV must be "local".');
  }

  const authMode = read(env, 'AUTH_MODE');
  if (authMode === undefined) {
    issues.push('AUTH_MODE is required and must be "dev".');
  } else if (authMode === 'shared') {
    issues.push('AUTH_MODE=shared is not implemented yet (P6); use AUTH_MODE=dev locally.');
  } else if (authMode !== 'dev') {
    issues.push('AUTH_MODE must be "dev".');
  }

  const nodeEnvRaw = read(env, 'NODE_ENV') ?? 'development';
  let nodeEnv: AppConfig['nodeEnv'] = 'development';
  if (nodeEnvRaw === 'development' || nodeEnvRaw === 'production' || nodeEnvRaw === 'test') {
    nodeEnv = nodeEnvRaw;
  } else {
    issues.push('NODE_ENV must be development, production or test.');
  }

  const hostRaw = read(env, 'HOST') ?? '127.0.0.1';
  const host = (LOOPBACK_BIND_HOSTS as readonly string[]).includes(hostRaw) ? (hostRaw as LoopbackBindHost) : undefined;
  if (host === undefined) {
    issues.push(`HOST must be a loopback address (${LOOPBACK_BIND_HOSTS.join(', ')}); public binds are refused in dev mode.`);
  }

  const portRaw = read(env, 'PORT') ?? String(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    issues.push('PORT must be an integer between 0 and 65535 (0 picks a free port).');
  }

  let database: DatabaseUrlInfo | undefined;
  try {
    database = parseDatabaseUrl(env.DATABASE_URL, { requireLoopback: true });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'DATABASE_URL is invalid.');
  }

  const devActorId = (read(env, 'DEV_ACTOR_ID') ?? DEFAULT_DEV_ACTOR_ID).toLowerCase();
  if (!isFixtureActorId(devActorId)) {
    issues.push('DEV_ACTOR_ID must be one of the allowlisted synthetic fixture actors.');
  }

  const appOrigins: string[] = [];
  const originsRaw = read(env, 'APP_ORIGIN');
  for (const candidate of originsRaw === undefined ? DEFAULT_APP_ORIGINS : originsRaw.split(',')) {
    const origin = parseOrigin(candidate.trim());
    if (origin === null) {
      issues.push('APP_ORIGIN must list http://<loopback>:<port> origins only, separated by commas.');
      break;
    }
    if (!appOrigins.includes(origin)) appOrigins.push(origin);
  }

  const logLevelRaw = read(env, 'LOG_LEVEL') ?? 'info';
  const logLevel = (LOG_LEVELS as readonly string[]).includes(logLevelRaw) ? (logLevelRaw as LogLevel) : undefined;
  if (logLevel === undefined) {
    issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);
  }

  if (issues.length > 0 || database === undefined || host === undefined || logLevel === undefined) {
    throw new ConfigError(issues.length > 0 ? issues : ['Configuration is invalid.']);
  }

  return {
    appEnv: 'local',
    authMode: 'dev',
    nodeEnv,
    host,
    port,
    database,
    devActorId,
    appOrigins,
    logLevel,
    serveWeb: nodeEnv === 'production',
  };
}
