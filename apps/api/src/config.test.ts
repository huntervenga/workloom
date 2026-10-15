import { DEFAULT_DEV_ACTOR_ID } from '@workloom/db';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const SECRET = 'Sup3r-Secret-Pw';
const base = {
  APP_ENV: 'local',
  AUTH_MODE: 'dev',
  DATABASE_URL: `postgres://workloom:${SECRET}@127.0.0.1:54329/workloom`,
};

function issuesOf(env: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).not.toContain(SECRET);
    return (error as ConfigError).issues;
  }
  throw new Error('expected ConfigError');
}

describe('loadConfig', () => {
  it('accepts the local development mode with safe defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      appEnv: 'local',
      authMode: 'dev',
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 4310,
      devActorId: DEFAULT_DEV_ACTOR_ID,
      appOrigins: ['http://127.0.0.1:4311', 'http://localhost:4311'],
      logLevel: 'info',
      serveWeb: false,
    });
    expect(config.database.description).toBe('postgresql://127.0.0.1:54329/workloom');
  });

  it('allows an optimized production build in local mode and serves the web build', () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production', HOST: '::1', PORT: '0' });
    expect(config).toMatchObject({ nodeEnv: 'production', host: '::1', port: 0, serveWeb: true });
  });

  it.each([
    [{ APP_ENV: undefined }, /APP_ENV is required/],
    [{ APP_ENV: 'staging' }, /APP_ENV=staging is not supported/],
    [{ APP_ENV: 'production' }, /APP_ENV=production is not supported/],
    [{ APP_ENV: 'dev' }, /APP_ENV must be "local"/],
    [{ AUTH_MODE: undefined }, /AUTH_MODE is required/],
    [{ AUTH_MODE: 'shared' }, /AUTH_MODE=shared is not implemented/],
    [{ AUTH_MODE: 'none' }, /AUTH_MODE must be "dev"/],
    [{ NODE_ENV: 'prod' }, /NODE_ENV/],
  ])('rejects unsafe or unsupported modes %o', (override, pattern) => {
    expect(issuesOf({ ...base, ...override }).join('\n')).toMatch(pattern);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com', '127.0.0.2'])('rejects non-loopback HOST %s', (host) => {
    expect(issuesOf({ ...base, HOST: host }).join('\n')).toMatch(/HOST must be a loopback/);
  });

  it.each(['-1', '65536', 'abc', '4310.5', '99999'])('rejects PORT %s', (port) => {
    expect(issuesOf({ ...base, PORT: port }).join('\n')).toMatch(/PORT/);
  });

  it('rejects any Railway marker, naming variables but not values', () => {
    const issues = issuesOf({ ...base, RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_TOKEN: 'token-value-x' });
    expect(issues.join('\n')).toMatch(/RAILWAY_ENVIRONMENT_NAME, RAILWAY_TOKEN/);
    expect(issues.join('\n')).not.toContain('token-value-x');
    expect(issuesOf({ ...base, RAILWAY_SERVICE_ID: '' }).join('\n')).toMatch(/Railway/);
  });

  it('requires a valid loopback DATABASE_URL without echoing credentials', () => {
    expect(issuesOf({ ...base, DATABASE_URL: undefined }).join('\n')).toMatch(/DATABASE_URL is required/);
    expect(issuesOf({ ...base, DATABASE_URL: `mysql://u:${SECRET}@127.0.0.1/db` }).join('\n')).toMatch(/postgres/);
    const remote = issuesOf({ ...base, DATABASE_URL: `postgres://u:${SECRET}@db.example.com:5432/workloom` }).join('\n');
    expect(remote).toMatch(/loopback/);
    expect(remote).not.toContain('db.example.com');
    expect(issuesOf({ ...base, DATABASE_URL: `postgres://u:${SECRET}@127.0.0.1/db?host=10.0.0.1` }).join('\n')).toMatch(/host/);
  });

  it('accepts only allowlisted fixture actors as DEV_ACTOR_ID', () => {
    expect(loadConfig({ ...base, DEV_ACTOR_ID: '5EED0000-0000-4000-8000-000000000106' }).devActorId).toBe(
      '5eed0000-0000-4000-8000-000000000106',
    );
    expect(issuesOf({ ...base, DEV_ACTOR_ID: '5eed0000-0000-4000-8000-000000000999' }).join('\n')).toMatch(/DEV_ACTOR_ID/);
  });

  it('accepts only exact loopback http origins in APP_ORIGIN', () => {
    expect(loadConfig({ ...base, APP_ORIGIN: 'http://127.0.0.1:4311' }).appOrigins).toEqual(['http://127.0.0.1:4311']);
    for (const origin of ['*', 'https://127.0.0.1:4311', 'http://evil.example:4311', 'http://127.0.0.1', 'http://127.0.0.1:4311/app']) {
      expect(issuesOf({ ...base, APP_ORIGIN: origin }).join('\n')).toMatch(/APP_ORIGIN/);
    }
  });

  it('reports every problem at once', () => {
    expect(issuesOf({ APP_ENV: 'production', AUTH_MODE: 'shared', HOST: '0.0.0.0', RAILWAY_ENVIRONMENT: 'x' }).length).toBeGreaterThanOrEqual(5);
  });
});
