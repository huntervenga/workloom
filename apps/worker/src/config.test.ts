import { describe, expect, it } from 'vitest';

import { WorkerConfigError, loadWorkerConfig } from './config.js';

const SECRET = 'Sup3r-Secret-Pw';
const base = {
  APP_ENV: 'local',
  AUTH_MODE: 'dev',
  DATABASE_URL: `postgres://workloom:${SECRET}@127.0.0.1:54329/workloom`,
};

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadWorkerConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(WorkerConfigError);
    const message = (error as Error).message;
    expect(message).not.toContain(SECRET);
    if (env.DATABASE_URL !== undefined) {
      expect(message).not.toContain(env.DATABASE_URL);
    }
    return (error as WorkerConfigError).issues;
  }
  throw new Error('expected WorkerConfigError');
}

describe('loadWorkerConfig', () => {
  it('accepts the local synthetic mode and keeps the credential-bearing URL only in database.url', () => {
    const config = loadWorkerConfig(base);
    expect(config).toMatchObject({ appEnv: 'local', authMode: 'dev', nodeEnv: 'development', jobConcurrency: 2 });
    expect(config.database.url).toBe(base.DATABASE_URL);
    expect(config.database.description).toBe('postgresql://127.0.0.1:54329/workloom');
    expect(config.database.description).not.toContain(SECRET);
  });

  it('has no job identity: DEV_ACTOR_ID is neither required nor surfaced', () => {
    const withActor = loadWorkerConfig({ ...base, DEV_ACTOR_ID: '00000000-0000-4000-8000-000000000001' });
    const withInvalidActor = loadWorkerConfig({ ...base, DEV_ACTOR_ID: 'not-a-fixture' });
    for (const config of [withActor, withInvalidActor]) {
      expect(Object.keys(config).some((key) => /actor|owner|user/i.test(key))).toBe(false);
    }
  });

  it.each(['production', 'test'] as const)('treats NODE_ENV=%s as a build optimization within local mode', (nodeEnv) => {
    expect(loadWorkerConfig({ ...base, NODE_ENV: nodeEnv }).nodeEnv).toBe(nodeEnv);
  });

  it.each([
    [{ APP_ENV: undefined }, /APP_ENV is required/],
    [{ APP_ENV: 'staging' }, /APP_ENV is required/],
    [{ APP_ENV: 'production' }, /APP_ENV is required/],
    [{ APP_ENV: 'Local' }, /APP_ENV is required/],
    [{ AUTH_MODE: undefined }, /AUTH_MODE is required/],
    [{ AUTH_MODE: 'shared' }, /AUTH_MODE is required/],
    [{ AUTH_MODE: 'none' }, /AUTH_MODE is required/],
    [{ NODE_ENV: 'prod' }, /NODE_ENV/],
  ])('rejects unsupported modes %o', (override, pattern) => {
    expect(issuesOf({ ...base, ...override }).join('\n')).toMatch(pattern);
  });

  it('never lets NODE_ENV=production unlock a hosted APP_ENV or remote database', () => {
    const issues = issuesOf({
      ...base,
      NODE_ENV: 'production',
      APP_ENV: 'production',
      DATABASE_URL: `postgres://workloom:${SECRET}@db.example.com:5432/workloom`,
    }).join('\n');
    expect(issues).toMatch(/APP_ENV is required/);
    expect(issues).toMatch(/loopback/);
  });

  it.each([['RAILWAY_ENVIRONMENT_NAME', 'production'], ['RAILWAY', ''], ['RAILWAY_PROJECT_ID', 'canary-railway-value']])(
    'fails on Railway marker %s even when everything else is local',
    (key, value) => {
      const issues = issuesOf({ ...base, [key]: value });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toContain(key);
      expect(issues.join('\n')).not.toContain('canary-railway-value');
    },
  );

  it.each([
    ['remote host', `postgres://workloom:${SECRET}@10.0.0.5:5432/workloom`, /loopback/],
    ['host override', `postgres://workloom:${SECRET}@127.0.0.1:5432/workloom?host=db.example.com`, /"host" query parameter/],
    ['port override', `postgres://workloom:${SECRET}@127.0.0.1:5432/workloom?port=6543`, /"port" query parameter/],
    ['database override', `postgres://workloom:${SECRET}@127.0.0.1:5432/workloom?dbname=prod`, /"dbname" query parameter/],
    ['bad scheme', `mysql://workloom:${SECRET}@127.0.0.1:5432/workloom`, /scheme/],
    ['unparsable', `postgres://workloom:${SECRET}@127.0.0.1:not-a-port/workloom`, /not a valid URL|invalid port/],
    ['missing', undefined, /DATABASE_URL is required/],
  ])('rejects DATABASE_URL (%s) without echoing it', (_label, url, pattern) => {
    expect(issuesOf({ ...base, DATABASE_URL: url }).join('\n')).toMatch(pattern);
  });

  it('accepts the bounded per-process concurrency values', () => {
    expect(loadWorkerConfig({ ...base, JOB_CONCURRENCY: '1' }).jobConcurrency).toBe(1);
    expect(loadWorkerConfig({ ...base, JOB_CONCURRENCY: ' 2 ' }).jobConcurrency).toBe(2);
  });

  it.each(['0', '3', '-1', '1.5', '2.0', '1e0', 'two', 'canary-concurrency-value'])(
    'rejects JOB_CONCURRENCY=%s without echoing it',
    (value) => {
      const issues = issuesOf({ ...base, JOB_CONCURRENCY: value }).join('\n');
      expect(issues).toMatch(/JOB_CONCURRENCY .* must be an integer from 1 to 2/);
      expect(issues).not.toContain('canary-concurrency-value');
    },
  );

  it.each([
    ['WORKER_DB_POOL_MAX', '0'],
    ['WORKER_DB_POOL_MAX', '50'],
    ['WORKER_QUEUE_POOL_MAX', '1'],
    ['WORKER_QUEUE_POOL_MAX', '20'],
    ['WORKER_POLL_INTERVAL_MS', '100'],
    ['WORKER_POLL_INTERVAL_MS', '3600000'],
    ['WORKER_SHUTDOWN_TIMEOUT_MS', '0'],
    ['WORKER_SHUTDOWN_TIMEOUT_MS', '999999999'],
  ])('keeps %s=%s within its finite bounds', (key, value) => {
    expect(issuesOf({ ...base, [key]: value }).join('\n')).toMatch(new RegExp(`${key} .* must be an integer from`));
  });

  it('requires an application pool large enough for the per-process concurrency', () => {
    expect(issuesOf({ ...base, JOB_CONCURRENCY: '2', WORKER_DB_POOL_MAX: '1' }).join('\n')).toMatch(
      /WORKER_DB_POOL_MAX must be at least JOB_CONCURRENCY/,
    );
    expect(loadWorkerConfig({ ...base, JOB_CONCURRENCY: '1', WORKER_DB_POOL_MAX: '1' }).appPoolMax).toBe(1);
  });

  it('rejects unknown log levels and accepts silent', () => {
    expect(issuesOf({ ...base, LOG_LEVEL: 'verbose' }).join('\n')).toMatch(/LOG_LEVEL must be one of/);
    expect(loadWorkerConfig({ ...base, LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
  });

  it('reports every problem at once', () => {
    const issues = issuesOf({
      RAILWAY_SERVICE_ID: 'x',
      APP_ENV: 'staging',
      DATABASE_URL: `postgres://workloom:${SECRET}@db.example.com/workloom`,
      JOB_CONCURRENCY: '9',
    });
    expect(issues.length).toBeGreaterThanOrEqual(5);
  });
});
