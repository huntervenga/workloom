import { isIP } from 'node:net';

import {
  DEFAULT_DEV_ACTOR_ID,
  findRailwayMarkers,
  isFixtureActorId,
  parseDatabaseUrl,
  type DatabaseUrlInfo,
} from '@workloom/db';

/** Explicit hosted modes require shared identity and strict HTTPS/database boundaries. */
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
  readonly appEnv: 'local' | 'staging' | 'production';
  readonly authMode: 'dev' | 'shared';
  /** Present exactly when authMode is 'shared'. */
  readonly sharedAuth?: SharedAuthConfig;
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly host: LoopbackBindHost | '0.0.0.0';
  /** 0 = pick a free port at listen time (test harnesses). */
  readonly port: number;
  /** Validated DATABASE_URL. `info.url` is a secret: never log it. */
  readonly database: DatabaseUrlInfo;
  /** Fixture actor used when no dev session selects another one. */
  readonly devActorId: string;
  /** Trusted browser origins; implicit loopback origins exist only in local mode. */
  readonly appOrigins: readonly string[];
  readonly logLevel: LogLevel;
  /** Serve apps/web/dist (optimized build) from the API process. */
  readonly serveWeb: boolean;
  /** Number of reverse-proxy hops in front of the API whose X-Forwarded-For is trusted for client addresses; 0 trusts none. */
  readonly trustProxyHops: number;
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

function isRemoteHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (isIP(host) !== 0 || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(host)) &&
    host !== 'localhost' && !host.endsWith('.localhost') && host !== '::' && host !== '::1' &&
    host !== '0.0.0.0' && !host.startsWith('127.') && !host.startsWith('::ffff:');
}

function parseHostedOrigin(raw: string): string | null {
  const url = parseAuthUrl(raw);
  return url !== null && url.protocol === 'https:' && isRemoteHostname(url.hostname) &&
    url.pathname === '/' && raw.replace(/\/$/, '') === url.origin ? url.origin : null;
}

/** TLS parameters are intentionally finite; postgres.js verify-full retains Node certificate verification. */
function validateHostedDatabase(raw: string | undefined): DatabaseUrlInfo {
  const info = parseDatabaseUrl(raw, { requireLoopback: false });
  const url = new URL(info.url);
  if (!isRemoteHostname(url.hostname)) throw new Error('Hosted DATABASE_URL must target a non-loopback server.');
  if (url.hash !== '' || /[\s\\]/.test(info.url)) throw new Error('Hosted DATABASE_URL must not contain a fragment, whitespace or backslash.');
  const ssl = url.searchParams.getAll('sslmode');
  for (const key of url.searchParams.keys()) {
    if (key !== 'sslmode') throw new Error('Hosted DATABASE_URL only permits the sslmode query parameter.');
  }
  const privateRailway = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+railway\.internal$/.test(url.hostname);
  if (!(ssl.length === 1 && ssl[0] === 'verify-full') && !(privateRailway && ssl.length === 0)) {
    throw new Error('Hosted DATABASE_URL requires sslmode=verify-full; only *.railway.internal may omit it.');
  }
  return info;
}

function loadSharedAuthConfig(env: Env, issues: string[], hosted = false): SharedAuthConfig | undefined {
  if (hosted) {
    for (const key of ['AUTH_BASE_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_APP_ORIGIN', 'AUTH_SESSION_KEY']) {
      if (read(env, key) === undefined) issues.push(`${key} is explicitly required in hosted mode.`);
    }
  }
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

  const appOrigin = (hosted ? parseHostedOrigin : parseAuthAppOrigin)(read(env, 'AUTH_APP_ORIGIN') ?? DEFAULT_AUTH_APP_ORIGIN);
  if (appOrigin === null) {
    issues.push('AUTH_APP_ORIGIN must be an exact allowed browser origin without credentials, path, query or fragment.');
  }

  if (hosted) {
    if (baseUrl === null || baseUrl.protocol !== 'https:' || !isRemoteHostname(baseUrl.hostname)) {
      issues.push('Hosted AUTH_BASE_URL requires HTTPS on a non-loopback host.');
    }
    const issuerUrl = issuer === undefined ? null : parseAuthUrl(issuer);
    if (issuerUrl === null || issuerUrl.protocol !== 'https:' || issuerUrl.href.replace(/\/$/, '') !== base) {
      issues.push('Hosted AUTH_ISSUER must identify the same HTTPS Auth base URL.');
    }
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

  const appEnvRaw = read(env, 'APP_ENV');
  const appEnv = appEnvRaw === 'local' || appEnvRaw === 'staging' || appEnvRaw === 'production' ? appEnvRaw : undefined;
  if (appEnv === undefined) issues.push('APP_ENV is required and must be local, staging or production.');
  const hosted = appEnv === 'staging' || appEnv === 'production';
  const railway = findRailwayMarkers(env);
  if (!hosted && railway.length > 0) {
    issues.push(`Railway environment detected (${railway.join(', ')}); local identity mode must not run there.`);
  }
  if (hosted && read(env, 'NODE_TLS_REJECT_UNAUTHORIZED') === '0') {
    issues.push('Hosted mode refuses disabled TLS certificate verification.');
  }
  if (hosted && Object.keys(env).some((key) => key.startsWith('PG') && read(env, key) !== undefined)) {
    issues.push('Hosted mode requires DATABASE_URL only; PG* environment overrides are refused.');
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

  if (hosted && (authMode !== 'shared' || nodeEnv !== 'production')) {
    issues.push('Hosted mode requires AUTH_MODE=shared and NODE_ENV=production; dev is not supported.');
  }
  const hostRaw = read(env, 'HOST') ?? (hosted ? '0.0.0.0' : '127.0.0.1');
  const host = hosted ? (hostRaw === '0.0.0.0' ? hostRaw : undefined) :
    ((LOOPBACK_BIND_HOSTS as readonly string[]).includes(hostRaw) ? (hostRaw as LoopbackBindHost) : undefined);
  if (host === undefined) {
    issues.push(`HOST must be 0.0.0.0 in hosted mode or a loopback address (${LOOPBACK_BIND_HOSTS.join(', ')}) locally.`);
  }

  const portRaw = read(env, 'PORT') ?? String(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : Number.NaN;
  if (!Number.isInteger(port) || port < (hosted ? 1 : 0) || port > 65535) {
    issues.push(hosted ? 'PORT must be an integer between 1 and 65535 in hosted mode.' : 'PORT must be an integer between 0 and 65535 (0 picks a free port).');
  }

  let database: DatabaseUrlInfo | undefined;
  try {
    database = hosted ? validateHostedDatabase(env.DATABASE_URL) : parseDatabaseUrl(env.DATABASE_URL, { requireLoopback: true });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'DATABASE_URL is invalid.');
  }

  if (hosted && read(env, 'DEV_ACTOR_ID') !== undefined) issues.push('DEV_ACTOR_ID is forbidden in hosted mode.');
  const devActorId = (read(env, 'DEV_ACTOR_ID') ?? DEFAULT_DEV_ACTOR_ID).toLowerCase();
  if (!isFixtureActorId(devActorId)) {
    issues.push('DEV_ACTOR_ID must be one of the allowlisted synthetic fixture actors.');
  }

  const appOrigins: string[] = [];
  const originsRaw = read(env, 'APP_ORIGIN');
  for (const candidate of originsRaw === undefined ? (hosted ? [] : DEFAULT_APP_ORIGINS) : originsRaw.split(',')) {
    const origin = (hosted ? parseHostedOrigin : parseOrigin)(candidate.trim());
    if (origin === null) {
      issues.push('APP_ORIGIN must list http://<loopback>:<port> origins only, separated by commas.');
      break;
    }
    if (!appOrigins.includes(origin)) appOrigins.push(origin);
  }

  const hopsRaw = read(env, 'TRUST_PROXY_HOPS') ?? '0';
  const trustProxyHops = /^[0-5]$/.test(hopsRaw) ? Number(hopsRaw) : undefined;
  if (trustProxyHops === undefined) issues.push('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  const logLevelRaw = read(env, 'LOG_LEVEL') ?? 'info';
  const logLevel = (LOG_LEVELS as readonly string[]).includes(logLevelRaw) ? (logLevelRaw as LogLevel) : undefined;
  if (logLevel === undefined) {
    issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);
  }

  const sharedAuth = authMode === 'shared' ? loadSharedAuthConfig(env, issues, hosted) : undefined;
  if (hosted && sharedAuth !== undefined && appOrigins.some((origin) => origin !== sharedAuth.appOrigin)) {
    issues.push('Hosted APP_ORIGIN must contain only the canonical AUTH_APP_ORIGIN.');
  }
  // The canonical Auth app origin is the browser origin; trust it like an APP_ORIGIN entry.
  if (sharedAuth !== undefined && !appOrigins.includes(sharedAuth.appOrigin)) {
    appOrigins.push(sharedAuth.appOrigin);
  }

  if (
    issues.length > 0 ||
    appEnv === undefined ||
    database === undefined ||
    host === undefined ||
    logLevel === undefined ||
    trustProxyHops === undefined ||
    authMode === undefined ||
    (authMode === 'shared' && sharedAuth === undefined)
  ) {
    throw new ConfigError(issues.length > 0 ? issues : ['Configuration is invalid.']);
  }

  return {
    appEnv,
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
    trustProxyHops,
  };
}
