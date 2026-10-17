import {
  DEFAULT_DEV_ACTOR_ID,
  findRailwayMarkers,
  isFixtureActorId,
  parseDatabaseUrl,
  type DatabaseUrlInfo,
} from '@workloom/db';

/**
 * Validated server configuration. Only APP_ENV=local is supported, with
 * AUTH_MODE=dev (fixture actors) or AUTH_MODE=shared (shared Auth BFF), a
 * loopback bind and a loopback database. NODE_ENV only describes the build
 * (development/production) and never unlocks deployment modes.
 */
export const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type LoopbackBindHost = (typeof LOOPBACK_BIND_HOSTS)[number];

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_PORT = 4310;
export const DEFAULT_APP_ORIGINS = ['http://127.0.0.1:4311', 'http://localhost:4311'] as const;

export const DEFAULT_AUTH_BASE_URL = 'https://auth.pavelignatov.com';
export const DEFAULT_AUTH_AUDIENCE = 'pet-projects';
export const DEFAULT_AUTH_APP_ORIGIN = 'http://127.0.0.1:4310';

const LOOPBACK_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const SESSION_KEY_BYTES = 32;

/** AES-256-GCM key material for stored Auth tokens. Redacted from JSON and inspection. */
export class SessionKey {
  readonly #bytes: Buffer;

  constructor(bytes: Uint8Array) {
    this.#bytes = Buffer.from(bytes);
  }

  /** Returns a copy of the key bytes. */
  bytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  toJSON(): string {
    return '[redacted]';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'SessionKey [redacted]';
  }
}

export interface SharedAuthConfig {
  /** Auth service base URL without a trailing slash. */
  readonly baseUrl: string;
  /** Exact `iss` literal every token must carry. */
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
  /** Canonical browser origin; the Auth callback and Origin checks bind to it. */
  readonly appOrigin: string;
  /** Cookies get the Secure attribute when the app origin is https. */
  readonly secureCookies: boolean;
  /** Never log. */
  readonly sessionKey: SessionKey;
}

export interface AppConfig {
  readonly appEnv: 'local';
  readonly authMode: 'dev' | 'shared';
  /** Present exactly when authMode is 'shared'. */
  readonly sharedAuth?: SharedAuthConfig;
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

/** True when any UTF-16 code unit is a C0 control (U+0000..U+001F) or DEL (U+007F). */
function hasC0OrDel(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** https, or http on an explicit loopback host (local fake Auth); no credentials, query or fragment. */
function parseAuthUrl(raw: string): URL | null {
  if (/[\s\\@?#]/.test(raw) || hasC0OrDel(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const transportOk = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.includes(url.hostname));
  if (!transportOk || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return null;
  }
  return url;
}

/** Exact loopback origin (http or https), no credentials, path, query or fragment. */
function parseAuthAppOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !LOOPBACK_HOSTNAMES.includes(url.hostname) ||
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

/** Canonical unpadded base64url encoding of exactly 32 bytes (43 characters). */
function parseSessionKey(raw: string): SessionKey | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.length !== SESSION_KEY_BYTES || bytes.toString('base64url') !== raw) return null;
  return new SessionKey(bytes);
}

function loadSharedAuthConfig(env: Env, issues: string[]): SharedAuthConfig | undefined {
  const baseUrl = parseAuthUrl(read(env, 'AUTH_BASE_URL') ?? DEFAULT_AUTH_BASE_URL);
  if (baseUrl === null) {
    issues.push('AUTH_BASE_URL must be an https URL (http only on a loopback host) without credentials, query or fragment.');
  }
  const base = baseUrl === null ? undefined : baseUrl.href.replace(/\/$/, '');

  // The issuer literal is compared exactly; it is validated but never normalized.
  const issuer = read(env, 'AUTH_ISSUER') ?? base;
  if (issuer !== undefined && parseAuthUrl(issuer) === null) {
    issues.push('AUTH_ISSUER must be an https URL (http only on a loopback host) without credentials, query or fragment.');
  }

  const audience = read(env, 'AUTH_AUDIENCE') ?? DEFAULT_AUTH_AUDIENCE;
  if (!/^[\x21-\x7e]{1,200}$/.test(audience)) {
    issues.push('AUTH_AUDIENCE must be 1-200 printable ASCII characters without spaces.');
  }

  const appOrigin = parseAuthAppOrigin(read(env, 'AUTH_APP_ORIGIN') ?? DEFAULT_AUTH_APP_ORIGIN);
  if (appOrigin === null) {
    issues.push('AUTH_APP_ORIGIN must be an exact http(s)://<loopback>[:port] origin without credentials, path, query or fragment.');
  }

  const sessionKeyRaw = read(env, 'AUTH_SESSION_KEY');
  const sessionKey = sessionKeyRaw === undefined ? null : parseSessionKey(sessionKeyRaw);
  if (sessionKeyRaw === undefined) {
    issues.push('AUTH_SESSION_KEY is required for AUTH_MODE=shared (32 random bytes, canonical base64url, 43 characters).');
  } else if (sessionKey === null) {
    issues.push('AUTH_SESSION_KEY must be exactly 32 bytes encoded as canonical unpadded base64url (43 characters).');
  }

  if (base === undefined || issuer === undefined || appOrigin === null || sessionKey === null || issues.length > 0) {
    return undefined;
  }
  return {
    baseUrl: base,
    issuer,
    audience,
    jwksUrl: `${base}/.well-known/jwks.json`,
    appOrigin,
    secureCookies: appOrigin.startsWith('https:'),
    sessionKey,
  };
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
    issues.push(`APP_ENV=${appEnv} is not supported yet: only APP_ENV=local is implemented (AUTH_MODE=dev or AUTH_MODE=shared).`);
  } else if (appEnv !== 'local') {
    issues.push('APP_ENV must be "local".');
  }

  const authModeRaw = read(env, 'AUTH_MODE');
  let authMode: AppConfig['authMode'] | undefined;
  if (authModeRaw === undefined) {
    issues.push('AUTH_MODE is required and must be "dev" or "shared".');
  } else if (authModeRaw === 'dev' || authModeRaw === 'shared') {
    authMode = authModeRaw;
  } else {
    issues.push('AUTH_MODE must be "dev" or "shared".');
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

  const sharedAuth = authMode === 'shared' ? loadSharedAuthConfig(env, issues) : undefined;
  // The canonical Auth app origin is the browser origin; trust it like an APP_ORIGIN entry.
  if (sharedAuth !== undefined && !appOrigins.includes(sharedAuth.appOrigin)) {
    appOrigins.push(sharedAuth.appOrigin);
  }

  if (
    issues.length > 0 ||
    database === undefined ||
    host === undefined ||
    logLevel === undefined ||
    authMode === undefined ||
    (authMode === 'shared' && sharedAuth === undefined)
  ) {
    throw new ConfigError(issues.length > 0 ? issues : ['Configuration is invalid.']);
  }

  return {
    appEnv: 'local',
    authMode,
    ...(sharedAuth === undefined ? {} : { sharedAuth }),
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
