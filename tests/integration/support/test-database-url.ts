// Guards for the integration test database. Integration tests run destructive setup
// (create/drop databases, schema resets), so they only ever touch an explicitly named
// synthetic test database. A missing or unsafe URL fails the run; it never skips.

const TEST_DATABASE_NAME = /^workloom_test(_[a-z0-9_]+)?$|^[a-z0-9_]+_test$/;

// Query parameters that would retarget the connection, swap credentials or alter session
// behaviour. postgres.js merges query parameters into its options and StartupMessage, so
// these override the validated host/port/path/userinfo. Matches the backend parseDatabaseUrl
// target/identity list; harmless parameters such as sslmode, ssl and connect_timeout pass.
const CONNECTION_OVERRIDE_PARAMS = new Set([
  'database',
  'db',
  'dbname',
  'user',
  'username',
  'password',
  'pass',
  'port',
  'host',
  'hostaddr',
  'service',
  'options',
]);

export class TestDatabaseConfigError extends Error {
  override readonly name = 'TestDatabaseConfigError';
}

/** Database URL with the password replaced, safe for assertion and error messages. */
export function redactDatabaseUrl(url: URL): string {
  const copy = new URL(url.href);
  if (copy.password) copy.password = '***';
  return copy.href;
}

export function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ''));
}

/** Throws unless `name` is a synthetic test database (`workloom_test…` or `…_test`). */
export function assertTestDatabaseName(name: string): void {
  if (!TEST_DATABASE_NAME.test(name)) {
    throw new TestDatabaseConfigError(
      `Refusing to use database "${name}" for destructive integration setup: ` +
        'the name must start with "workloom_test" or end with "_test".',
    );
  }
}

/**
 * Reads and validates TEST_DATABASE_URL. Never falls back to DATABASE_URL: the dev
 * database holds the demo seed the browser smoke relies on and must not be reset.
 */
export function requireTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): URL {
  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    throw new TestDatabaseConfigError(
      'TEST_DATABASE_URL is required for integration tests and is not set. ' +
        'Start local PostgreSQL (npm run db:up) and export ' +
        'TEST_DATABASE_URL=postgres://<user>:<password>@127.0.0.1:<port>/workloom_test. ' +
        'Integration tests do not fall back to DATABASE_URL or an in-memory repository.',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TestDatabaseConfigError('TEST_DATABASE_URL is not a valid URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new TestDatabaseConfigError(
      `TEST_DATABASE_URL must use postgres:// or postgresql://, got "${url.protocol}".`,
    );
  }
  assertNoConnectionOverrides(url, 'TEST_DATABASE_URL');

  const name = databaseName(url);
  if (!name) {
    throw new TestDatabaseConfigError('TEST_DATABASE_URL has no database name.');
  }
  assertTestDatabaseName(name);

  const devUrl = env.DATABASE_URL?.trim();
  if (devUrl && sameDatabase(devUrl, url)) {
    throw new TestDatabaseConfigError(
      'TEST_DATABASE_URL points at the same database as DATABASE_URL; use a separate synthetic test database.',
    );
  }
  return url;
}

/**
 * Throws if any query parameter would override the URL's target or identity. Keys are
 * matched case-insensitively after URLSearchParams percent-decoding (`%64atabase` is
 * `database`), and keys() repeats duplicates so every occurrence is checked. The error
 * names the canonical parameter only, never its value or the URL.
 */
function assertNoConnectionOverrides(url: URL, label: string): void {
  for (const key of url.searchParams.keys()) {
    const param = key.toLowerCase();
    if (CONNECTION_OVERRIDE_PARAMS.has(param)) {
      throw new TestDatabaseConfigError(
        `${label} must not override connection/database settings via query parameter "${param}".`,
      );
    }
  }
}

function sameDatabase(other: string, url: URL): boolean {
  try {
    const parsed = new URL(other);
    return parsed.host === url.host && databaseName(parsed) === databaseName(url);
  } catch {
    return false;
  }
}

/**
 * URL for a sibling database on the same server, re-validated before use. Rejects (never
 * strips) override parameters, since callers may pass a URL that skipped requireTestDatabaseUrl.
 */
export function withDatabaseName(url: URL, name: string): URL {
  assertNoConnectionOverrides(url, 'Test database URL');
  assertTestDatabaseName(name);
  const copy = new URL(url.href);
  copy.pathname = `/${encodeURIComponent(name)}`;
  return copy;
}
