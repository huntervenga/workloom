/**
 * DATABASE_URL validation. Error messages never contain the URL, user name or
 * password; only the variable name and the rule that failed.
 */
export class DatabaseConfigError extends Error {
  override readonly name = 'DatabaseConfigError';
}

export interface DatabaseUrlInfo {
  /** The validated connection string. Treat as a secret: never log it. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly isLoopback: boolean;
  /** `postgresql://host:port/database` without credentials, safe for logs. */
  readonly description: string;
}

export interface ParseDatabaseUrlOptions {
  /** Name used in error messages. Default `DATABASE_URL`. */
  readonly variableName?: string;
  /**
   * Require a loopback database server. Local synthetic modes set this so that
   * a development process can never write fixture data into a remote database.
   */
  readonly requireLoopback?: boolean;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** libpq/postgres.js query parameters that can redirect the connection to another server. */
const HOST_OVERRIDE_PARAMS = ['host', 'hostaddr', 'service'];
/**
 * Query parameters that override the port, database or credentials from the URL
 * authority/path/userinfo (postgres.js merges query params into its options, and
 * libpq reads `dbname`). Rejected in every mode so the validated target is the real one.
 */
const TARGET_OVERRIDE_PARAMS = ['port', 'database', 'db', 'dbname', 'user', 'username', 'password', 'pass'];

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || IPV4_LOOPBACK.test(normalized);
}

export function parseDatabaseUrl(raw: string | undefined, options: ParseDatabaseUrlOptions = {}): DatabaseUrlInfo {
  const name = options.variableName ?? 'DATABASE_URL';
  const value = raw?.trim();
  if (value === undefined || value === '') {
    throw new DatabaseConfigError(`${name} is required (postgres://user:password@127.0.0.1:5432/database).`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatabaseConfigError(`${name} is not a valid URL. Expected postgres://user:password@host:port/database.`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new DatabaseConfigError(`${name} must use the postgres:// or postgresql:// scheme.`);
  }
  if (url.hostname === '') {
    throw new DatabaseConfigError(`${name} must name a database host.`);
  }

  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new DatabaseConfigError(`${name} has an invalid database name.`);
  }
  if (database === '' || database.includes('/')) {
    throw new DatabaseConfigError(`${name} must name exactly one database in its path.`);
  }

  // Report the canonical parameter name from the list, never the raw key or value.
  const queryKeys = new Set([...url.searchParams.keys()].map((key) => key.toLowerCase()));
  const targetOverride = TARGET_OVERRIDE_PARAMS.find((param) => queryKeys.has(param));
  if (targetOverride !== undefined) {
    throw new DatabaseConfigError(
      `${name} must not override the port, database or credentials with the "${targetOverride}" query parameter.`,
    );
  }

  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigError(`${name} has an invalid port.`);
  }

  const isLoopback = isLoopbackHost(url.hostname);
  if (options.requireLoopback === true) {
    if (!isLoopback) {
      throw new DatabaseConfigError(
        `${name} must point to a loopback PostgreSQL server (127.0.0.1, ::1 or localhost) in local synthetic mode.`,
      );
    }
    const override = HOST_OVERRIDE_PARAMS.find((param) => queryKeys.has(param));
    if (override !== undefined) {
      throw new DatabaseConfigError(`${name} must not override the server with the "${override}" query parameter.`);
    }
  }

  return {
    url: value,
    host: url.hostname,
    port,
    database,
    isLoopback,
    description: `postgresql://${url.hostname}:${port}/${encodeURIComponent(database)}`,
  };
}
