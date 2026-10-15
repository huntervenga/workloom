import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TestDatabaseConfigError,
  requireTestDatabaseUrl,
  withDatabaseName,
} from './support/test-database-url.js';

// Regression for the destructive-harness guard. Like every integration file, collection
// requires an explicit, valid TEST_DATABASE_URL; the cases below then use synthetic URLs
// and env objects only and never open a connection. Real PostgreSQL is covered elsewhere.
requireTestDatabaseUrl();

const password = `pw-${randomUUID()}`;
const sentinel = `target_${randomUUID().replaceAll('-', '')}`;
const base = `postgres://qa_user:${password}@127.0.0.1:54329/workloom_test`;

function configError(run: () => unknown): TestDatabaseConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TestDatabaseConfigError);
    return error as TestDatabaseConfigError;
  }
  throw new Error('Expected TestDatabaseConfigError, but the call succeeded.');
}

function expectNoLeak(error: Error): void {
  expect(error.message).not.toContain(password);
  expect(error.message).not.toContain(sentinel);
}

describe('requireTestDatabaseUrl', () => {
  it.each([
    ['percent-encoded key', `?%64atabase=${sentinel}`, 'database'],
    ['mixed-case key', `?USERNAME=${sentinel}`, 'username'],
    ['duplicate key', `?sslmode=disable&database=workloom_test&database=${sentinel}`, 'database'],
    ['port override', '?PORT=5432', 'port'],
  ])('rejects a %s override before any connection', (_case, query, param) => {
    const error = configError(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: base + query }));
    expect(error.message).toContain(`"${param}"`);
    expectNoLeak(error);
  });

  it.each([
    'database', 'db', 'dbname', 'user', 'username', 'password', 'pass',
    'port', 'host', 'hostaddr', 'service', 'options',
  ])('rejects the %s override in any case', (param) => {
    const query = `?${param.toUpperCase()}=${sentinel}`;
    const error = configError(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: base + query }));
    expectNoLeak(error);
  });

  it('accepts an explicit workloom_test URL with safe connection parameters', () => {
    const url = requireTestDatabaseUrl({ TEST_DATABASE_URL: `${base}?sslmode=disable&connect_timeout=5` });
    expect(url.pathname).toBe('/workloom_test');
    expect(url.searchParams.get('sslmode')).toBe('disable');
    expect(url.searchParams.get('connect_timeout')).toBe('5');
  });

  it('fails safe without TEST_DATABASE_URL even when DATABASE_URL is set', () => {
    const devUrl = `postgres://dev_user:${password}@127.0.0.1:54329/workloom_test`;
    const envs: NodeJS.ProcessEnv[] = [{ DATABASE_URL: devUrl }, { DATABASE_URL: devUrl, TEST_DATABASE_URL: '  ' }];
    for (const env of envs) {
      const error = configError(() => requireTestDatabaseUrl(env));
      expect(error.message).toContain('TEST_DATABASE_URL is required');
      expect(error.message).not.toContain('dev_user');
      expectNoLeak(error);
    }
  });
});

describe('withDatabaseName', () => {
  it('derives a sibling test database and keeps legitimate parameters', () => {
    const url = requireTestDatabaseUrl({ TEST_DATABASE_URL: `${base}?sslmode=disable&connect_timeout=5` });
    const sibling = withDatabaseName(url, 'workloom_test_qa');
    expect(sibling.pathname).toBe('/workloom_test_qa');
    expect(sibling.host).toBe(url.host);
    expect(sibling.username).toBe('qa_user');
    expect(sibling.password).toBe(password);
    expect(sibling.search).toBe('?sslmode=disable&connect_timeout=5');
    expect(url.pathname).toBe('/workloom_test');
  });

  it('rejects unsafe query input on a URL that bypassed requireTestDatabaseUrl', () => {
    for (const query of [`?Database=${sentinel}`, `?%75ser=${sentinel}`, '?port=5432']) {
      const url = new URL(base + query);
      const error = configError(() => withDatabaseName(url, 'workloom_test_qa'));
      expectNoLeak(error);
      // Rejected, not stripped: the caller's URL is left as it was.
      expect(url.search).toBe(query);
    }
  });
});
