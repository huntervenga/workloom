import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const key = Buffer.alloc(32, 17).toString('base64url');
const base = {
  APP_ENV: 'production', NODE_ENV: 'production', AUTH_MODE: 'shared',
  DATABASE_URL: 'postgres://operator:synthetic-password@db.example.com/workloom?sslmode=verify-full',
  AUTH_BASE_URL: 'https://auth.example.com', AUTH_ISSUER: 'https://auth.example.com',
  AUTH_AUDIENCE: 'pet-projects', AUTH_APP_ORIGIN: 'https://workloom.example.com', AUTH_SESSION_KEY: key,
};
function rejects(override: Record<string, string | undefined>): void {
  expect(() => loadConfig({ ...base, ...override })).toThrow(ConfigError);
  try { loadConfig({ ...base, ...override }); } catch (error) {
    expect(String(error)).not.toContain('synthetic-password');
    expect(String(error)).not.toContain(key);
  }
}

describe('explicit hosted shared configuration', () => {
  it.each(['staging', 'production'])('accepts strict %s including Railway marker without any dev origin', (appEnv) => {
    const config = loadConfig({ ...base, APP_ENV: appEnv, RAILWAY_SERVICE_ID: 'synthetic-service', PORT: '8080' });
    expect(config).toMatchObject({ appEnv, host: '0.0.0.0', port: 8080, authMode: 'shared', serveWeb: true,
      appOrigins: ['https://workloom.example.com'] });
    expect(config.sharedAuth).toMatchObject({ secureCookies: true, issuer: 'https://auth.example.com',
      jwksUrl: 'https://auth.example.com/.well-known/jwks.json' });
  });
  it.each(['AUTH_BASE_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_APP_ORIGIN', 'AUTH_SESSION_KEY'])('requires explicit %s', (field) => rejects({ [field]: undefined }));
  it.each([
    { AUTH_MODE: 'dev' }, { NODE_ENV: 'development' }, { NODE_ENV: 'test' }, { DEV_ACTOR_ID: '5eed0000-0000-4000-8000-000000000101' },
    { HOST: '127.0.0.1' }, { PORT: '0' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, { PGSSLMODE: 'disable' },
    { AUTH_BASE_URL: 'http://auth.example.com' }, { AUTH_BASE_URL: 'https://localhost' },
    { AUTH_ISSUER: 'https://other.example.com' }, { AUTH_APP_ORIGIN: 'http://workloom.example.com' },
    { AUTH_APP_ORIGIN: 'https://127.0.0.1' }, { AUTH_APP_ORIGIN: 'https://workloom.example.com/app' },
    { APP_ORIGIN: '*' }, { APP_ORIGIN: 'https://other.example.com' },
    { APP_ORIGIN: 'https://workloom.example.com,http://127.0.0.1:4311' },
  ])('rejects unsafe hosted override %o', rejects);
  it('keeps the signed issuer literal while matching its Auth service', () => {
    expect(loadConfig({ ...base, AUTH_ISSUER: 'https://auth.example.com/' }).sharedAuth?.issuer).toBe('https://auth.example.com/');
    expect(loadConfig({ ...base, APP_ORIGIN: base.AUTH_APP_ORIGIN }).appOrigins).toEqual([base.AUTH_APP_ORIGIN]);
  });
  it.each([
    'postgres://u:p@db.example.com/db', 'postgres://u:p@127.0.0.1/db?sslmode=verify-full',
    'postgres://u:p@localhost/db?sslmode=verify-full', 'postgres://u:p@2130706433/db?sslmode=verify-full',
    'postgres://u:p@0x7f000001/db?sslmode=verify-full', 'postgres://u:p@[::1]/db?sslmode=verify-full',
    'postgres://u:p@db.example.com/db?sslmode=verify-full#fragment',
    'postgres://u:p@db.example.com/db?sslmode=verify-full&SSLMODE=disable', 'postgres://u:p@127.0.0.2/db?sslmode=verify-full',
    'postgres://u:p@db.railway.internal.evil.com/db', 'postgres://u:p@railway.internal/db',
    'postgres://u:p@db.example.com/db?sslmode=require', 'postgres://u:p@db.example.com/db?sslmode=prefer',
    'postgres://u:p@db.example.com/db?sslmode=verify-full&sslmode=disable',
    'postgres://u:p@db.example.com/db?sslmode=verify-full&ssl=false',
    'postgres://u:p@db.example.com/db?sslmode=verify-full&host=127.0.0.1',
    'postgres://u:p@db.example.com/db?sslmode=verify-full&hostaddr=127.0.0.1',
    'postgres://u:p@db.example.com/db?sslmode=verify-full&options=x',
  ])('rejects ambiguous or insecure database transport %s', (url) => rejects({ DATABASE_URL: url }));
  it('permits exact private Railway DNS without overriding TLS options', () => {
    expect(loadConfig({ ...base, DATABASE_URL: 'postgres://u:p@postgres.railway.internal/db' }).database.isLoopback).toBe(false);
  });
  it('does not unlock local mode merely from Railway or production node env', () => {
    rejects({ APP_ENV: 'local', RAILWAY_PROJECT_ID: 'synthetic' });
    rejects({ APP_ENV: 'local' });
  });
});
