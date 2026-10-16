import { DatabaseConfigError, findRailwayMarkers, parseDatabaseUrl, type DatabaseUrlInfo } from '@workloom/db';

/**
 * Validated worker configuration. Like the API, the worker supports exactly one
 * mode: APP_ENV=local, AUTH_MODE=dev, loopback synthetic database. NODE_ENV only
 * describes the build and never unlocks other modes. The worker has no job
 * identity setting: DEV_ACTOR_ID is the API's browser fixture and is ignored here;
 * job actors are resolved by the domain authorizer.
 */
export const WORKER_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type WorkerLogLevel = (typeof WORKER_LOG_LEVELS)[number];

interface IntegerSetting {
  readonly env: string;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
  readonly meaning: string;
}

/** Bounds are per worker process; running several processes multiplies them. */
export const WORKER_INTEGER_SETTINGS = {
  jobConcurrency: { env: 'JOB_CONCURRENCY', min: 1, max: 2, fallback: 2, meaning: 'jobs run at once by this process' },
  appPoolMax: { env: 'WORKER_DB_POOL_MAX', min: 1, max: 5, fallback: 3, meaning: 'application database connections' },
  queuePoolMax: { env: 'WORKER_QUEUE_POOL_MAX', min: 2, max: 5, fallback: 3, meaning: 'queue database connections' },
  pollIntervalMs: { env: 'WORKER_POLL_INTERVAL_MS', min: 500, max: 60_000, fallback: 2_000, meaning: 'queue polling interval' },
  shutdownTimeoutMs: {
    env: 'WORKER_SHUTDOWN_TIMEOUT_MS',
    min: 1_000,
    max: 120_000,
    fallback: 10_000,
    meaning: 'graceful queue stop timeout',
  },
} as const satisfies Record<string, IntegerSetting>;

export interface WorkerConfig {
  readonly appEnv: 'local';
  readonly authMode: 'dev';
  readonly nodeEnv: 'development' | 'production' | 'test';
  /** Validated DATABASE_URL. `info.url` contains credentials: never log it; use `description`. */
  readonly database: DatabaseUrlInfo;
  /** Jobs this process runs concurrently. Not a global limit across processes. */
  readonly jobConcurrency: number;
  /** Max connections of this process's application (domain command) pool. */
  readonly appPoolMax: number;
  /** Max connections of this process's queue client pool. */
  readonly queuePoolMax: number;
  readonly pollIntervalMs: number;
  /** Finite graceful-stop budget handed to the queue client; it does not cancel database work. */
  readonly shutdownTimeoutMs: number;
  readonly logLevel: WorkerLogLevel;
}

export class WorkerConfigError extends Error {
  override readonly name = 'WorkerConfigError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid Workloom worker configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.issues = issues;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function readInteger(env: Env, setting: IntegerSetting, issues: string[]): number {
  const raw = read(env, setting.env);
  if (raw === undefined) {
    return setting.fallback;
  }
  const value = /^\d{1,9}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < setting.min || value > setting.max) {
    // The raw value is not echoed: only the variable name and the rule.
    issues.push(`${setting.env} (${setting.meaning}) must be an integer from ${setting.min} to ${setting.max}.`);
    return setting.fallback;
  }
  return value;
}

/** Validates the process environment. Throws WorkerConfigError listing every problem; never echoes values. */
export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const issues: string[] = [];

  // Checked on its own: a Railway marker fails even when every other setting looks local.
  const railway = findRailwayMarkers(env);
  if (railway.length > 0) {
    issues.push(`Railway environment detected (${railway.join(', ')}); the local synthetic worker must not run there.`);
  }

  if (read(env, 'APP_ENV') !== 'local') {
    issues.push('APP_ENV is required and must be "local"; hosted environments are not supported by the worker yet.');
  }
  if (read(env, 'AUTH_MODE') !== 'dev') {
    issues.push('AUTH_MODE is required and must be "dev" (the same local mode as the API).');
  }

  const nodeEnvRaw = read(env, 'NODE_ENV') ?? 'development';
  let nodeEnv: WorkerConfig['nodeEnv'] = 'development';
  if (nodeEnvRaw === 'development' || nodeEnvRaw === 'production' || nodeEnvRaw === 'test') {
    nodeEnv = nodeEnvRaw;
  } else {
    issues.push('NODE_ENV must be development, production or test.');
  }

  let database: DatabaseUrlInfo | undefined;
  try {
    // Loopback, scheme and host/port/database/credential override rules live in the shared parser.
    database = parseDatabaseUrl(env.DATABASE_URL, { requireLoopback: true });
  } catch (error) {
    issues.push(error instanceof DatabaseConfigError ? error.message : 'DATABASE_URL is invalid.');
  }

  const s = WORKER_INTEGER_SETTINGS;
  const jobConcurrency = readInteger(env, s.jobConcurrency, issues);
  const appPoolMax = readInteger(env, s.appPoolMax, issues);
  const queuePoolMax = readInteger(env, s.queuePoolMax, issues);
  const pollIntervalMs = readInteger(env, s.pollIntervalMs, issues);
  const shutdownTimeoutMs = readInteger(env, s.shutdownTimeoutMs, issues);
  if (appPoolMax < jobConcurrency) {
    issues.push(`${s.appPoolMax.env} must be at least ${s.jobConcurrency.env}: each running job holds one transaction.`);
  }

  const logLevelRaw = read(env, 'LOG_LEVEL') ?? 'info';
  const logLevel = (WORKER_LOG_LEVELS as readonly string[]).includes(logLevelRaw)
    ? (logLevelRaw as WorkerLogLevel)
    : undefined;
  if (logLevel === undefined) {
    issues.push(`LOG_LEVEL must be one of ${WORKER_LOG_LEVELS.join(', ')}.`);
  }

  if (issues.length > 0 || database === undefined || logLevel === undefined) {
    throw new WorkerConfigError(issues.length > 0 ? issues : ['Configuration is invalid.']);
  }

  return {
    appEnv: 'local',
    authMode: 'dev',
    nodeEnv,
    database,
    jobConcurrency,
    appPoolMax,
    queuePoolMax,
    pollIntervalMs,
    shutdownTimeoutMs,
    logLevel,
  };
}
