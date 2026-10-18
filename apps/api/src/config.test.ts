import { inspect } from 'node:util';

import { DEFAULT_DEV_ACTOR_ID } from '@workloom/db';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const SECRET = 'Sup3r-Secret-Pw';
const base = {
  APP_ENV: 'local',
  AUTH_MODE: 'dev',
  DATABASE_URL: `postgres://workloom:${SECRET}@127.0.0.1:54329/workloom`,
};
/** Synthetic 32-byte key; never a real secret. */
const SESSION_KEY_TEXT = 'workloom-synthetic-test-key-0032';
const SESSION_KEY = Buffer.from(SESSION_KEY_TEXT, 'utf8').toString('base64url');
const shared = { ...base, AUTH_MODE: 'shared', AUTH_SESSION_KEY: SESSION_KEY };

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
    [{ APP_ENV: 'staging' }, /Hosted mode requires/],
    [{ APP_ENV: 'production' }, /Hosted mode requires/],
    [{ APP_ENV: 'dev' }, /APP_ENV is required/],
    [{ AUTH_MODE: undefined }, /AUTH_MODE is required/],
    [{ AUTH_MODE: 'shared' }, /AUTH_SESSION_KEY is required for AUTH_MODE=shared/],
    [{ AUTH_MODE: 'none' }, /AUTH_MODE must be "dev" or "shared"/],
    [{ NODE_ENV: 'prod' }, /NODE_ENV/],
  ])('rejects unsafe or unsupported modes %o', (override, pattern) => {
    expect(issuesOf({ ...base, ...override }).join('\n')).toMatch(pattern);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com', '127.0.0.2'])('rejects non-loopback HOST %s', (host) => {
    expect(issuesOf({ ...base, HOST: host }).join('\n')).toMatch(/HOST must be/);
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

  it('keeps the dev shape free of shared Auth settings', () => {
    const config = loadConfig({ ...base, AUTH_SESSION_KEY: SESSION_KEY, AUTH_BASE_URL: 'http://127.0.0.1:4999' });
    expect(Object.keys(config).includes('sharedAuth')).toBe(false);
    expect(config.appOrigins).toEqual(['http://127.0.0.1:4311', 'http://localhost:4311']);
  });
});

describe('loadConfig AUTH_MODE=shared', () => {
  it('uses the shared Auth defaults and adds the local app origin to the trusted origins', () => {
    const config = loadConfig(shared);
    expect(config.authMode).toBe('shared');
    expect(config.sharedAuth).toMatchObject({
      baseUrl: 'https://auth.pavelignatov.com',
      issuer: 'https://auth.pavelignatov.com',
      audience: 'pet-projects',
      jwksUrl: 'https://auth.pavelignatov.com/.well-known/jwks.json',
      appOrigin: 'http://127.0.0.1:4310',
      secureCookies: false,
    });
    expect(config.sharedAuth?.sessionKey.bytes().equals(Buffer.from(SESSION_KEY_TEXT, 'utf8'))).toBe(true);
    expect(config.appOrigins).toEqual(['http://127.0.0.1:4311', 'http://localhost:4311', 'http://127.0.0.1:4310']);
  });

  it('accepts a loopback HTTP fake Auth and keeps the issuer literal exact', () => {
    const config = loadConfig({
      ...shared,
      AUTH_BASE_URL: 'http://127.0.0.1:4999',
      AUTH_ISSUER: 'https://auth.example.test/',
      AUTH_AUDIENCE: 'workloom-test',
      AUTH_APP_ORIGIN: 'https://localhost:4310',
    });
    expect(config.sharedAuth).toMatchObject({
      baseUrl: 'http://127.0.0.1:4999',
      issuer: 'https://auth.example.test/',
      audience: 'workloom-test',
      jwksUrl: 'http://127.0.0.1:4999/.well-known/jwks.json',
      appOrigin: 'https://localhost:4310',
      secureCookies: true,
    });
    expect(loadConfig({ ...shared, AUTH_BASE_URL: 'http://localhost:4999/' }).sharedAuth?.issuer).toBe('http://localhost:4999');
  });

  it.each([
    ['AUTH_BASE_URL', 'http://auth.example.test'],
    ['AUTH_BASE_URL', 'https://user:pw@auth.example.test'],
    ['AUTH_BASE_URL', 'https://auth.example.test/?tenant=x'],
    ['AUTH_BASE_URL', 'https://auth.example.test/#frag'],
    ['AUTH_BASE_URL', 'ftp://auth.example.test'],
    ['AUTH_BASE_URL', 'not a url'],
    ['AUTH_ISSUER', 'http://auth.example.test'],
    ['AUTH_ISSUER', 'https://auth.example.test?tenant=x'],
    ['AUTH_AUDIENCE', 'pet projects'],
    ['AUTH_AUDIENCE', 'a'.repeat(201)],
    ['AUTH_APP_ORIGIN', 'https://app.example.com'],
    ['AUTH_APP_ORIGIN', 'http://192.168.1.10:4310'],
    ['AUTH_APP_ORIGIN', 'http://127.0.0.1:4310/app'],
    ['AUTH_APP_ORIGIN', 'http://127.0.0.1:4310?x=1'],
    ['AUTH_APP_ORIGIN', 'http://127.0.0.1:4310#x'],
    ['AUTH_APP_ORIGIN', 'http://u:p@127.0.0.1:4310'],
    ['AUTH_APP_ORIGIN', '*'],
  ])('rejects %s=%s without echoing it', (key, value) => {
    const issues = issuesOf({ ...shared, [key]: value }).join('\n');
    expect(issues).toMatch(new RegExp(`${key} must`));
    expect(issues.includes(value)).toBe(false);
  });

  it.each([
    ['short', 'too-short-key'],
    ['padded', `${SESSION_KEY}=`],
    ['truncated', SESSION_KEY.slice(0, 42)],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64url')],
    ['standard base64', Buffer.alloc(32, 0xfb).toString('base64')],
    ['non-canonical', `${'A'.repeat(42)}B`],
  ])('rejects a %s AUTH_SESSION_KEY without echoing it', (_label, value) => {
    const issues = issuesOf({ ...shared, AUTH_SESSION_KEY: value }).join('\n');
    expect(issues).toMatch(/AUTH_SESSION_KEY must be exactly 32 bytes/);
    expect(issues.includes(value)).toBe(false);
  });

  it('never exposes the session key through JSON, inspection or string conversion', () => {
    const config = loadConfig(shared);
    const forms = [SESSION_KEY, SESSION_KEY_TEXT, Buffer.from(SESSION_KEY_TEXT, 'utf8').toString('hex')];
    for (const text of [JSON.stringify(config), inspect(config, { depth: 10 }), String(config.sharedAuth?.sessionKey)]) {
      expect(forms.some((form) => text.includes(form))).toBe(false);
    }
  });

  it.each([
    [{ RAILWAY_ENVIRONMENT: 'production' }, /Railway environment detected/],
    [{ DATABASE_URL: `postgres://u:${SECRET}@db.example.com:5432/workloom` }, /loopback/],
    [{ HOST: '0.0.0.0' }, /HOST must be/],
    [{ APP_ENV: 'production' }, /Hosted mode requires/],
  ])('still enforces the local-only guards with a valid key %o', (override, pattern) => {
    const issues = issuesOf({ ...shared, ...override }).join('\n');
    expect(issues).toMatch(pattern);
    expect(issues.includes(SESSION_KEY)).toBe(false);
  });
});
