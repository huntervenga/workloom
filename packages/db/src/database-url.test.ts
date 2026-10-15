import { describe, expect, it } from 'vitest';

import { DatabaseConfigError, isLoopbackHost, parseDatabaseUrl } from './database-url.js';

const SECRET = 'S3cr3t-Passw0rd';

function messageOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    return (error as Error).message;
  }
  throw new Error('expected DatabaseConfigError');
}

describe('parseDatabaseUrl', () => {
  it('accepts a local PostgreSQL URL and describes it without credentials', () => {
    const info = parseDatabaseUrl(`postgres://workloom:${SECRET}@127.0.0.1:54329/workloom`, { requireLoopback: true });
    expect(info).toMatchObject({ host: '127.0.0.1', port: 54329, database: 'workloom', isLoopback: true });
    expect(info.description).toBe('postgresql://127.0.0.1:54329/workloom');
    expect(info.description).not.toContain(SECRET);
    expect(info.description).not.toContain('workloom:');
  });

  it('defaults the port and accepts postgresql:// and IPv6 loopback', () => {
    expect(parseDatabaseUrl('postgresql://u@localhost/db').port).toBe(5432);
    expect(parseDatabaseUrl('postgres://u@[::1]:5432/db', { requireLoopback: true }).isLoopback).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', '   '],
    ['not a URL', `workloom:${SECRET}@127.0.0.1/db`],
    ['wrong scheme', `mysql://workloom:${SECRET}@127.0.0.1/db`],
    ['http scheme', `https://workloom:${SECRET}@127.0.0.1/db`],
    ['no database', `postgres://workloom:${SECRET}@127.0.0.1:5432/`],
    ['nested path', `postgres://workloom:${SECRET}@127.0.0.1:5432/a/b`],
  ])('rejects %s without echoing credentials', (_label, raw) => {
    const message = messageOf(() => parseDatabaseUrl(raw));
    expect(message).toContain('DATABASE_URL');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('workloom:');
  });

  it('requires a loopback server in local synthetic mode', () => {
    const message = messageOf(() =>
      parseDatabaseUrl(`postgres://workloom:${SECRET}@db.internal.example:5432/workloom`, { requireLoopback: true }),
    );
    expect(message).toMatch(/loopback/);
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('db.internal.example');
    expect(parseDatabaseUrl('postgres://u:p@db.internal.example/workloom').isLoopback).toBe(false);
  });

  it('rejects query parameters that redirect the connection', () => {
    expect(messageOf(() => parseDatabaseUrl('postgres://u@127.0.0.1/db?host=10.0.0.5', { requireLoopback: true }))).toMatch(
      /"host"/,
    );
    expect(messageOf(() => parseDatabaseUrl('postgres://u@127.0.0.1/db?HostAddr=10.0.0.5', { requireLoopback: true }))).toMatch(
      /"hostaddr"/,
    );
    const credentialMessage = messageOf(() => parseDatabaseUrl(`postgres://u@127.0.0.1/db?password=${SECRET}`));
    expect(credentialMessage).not.toContain(SECRET);
  });

  it('rejects multi-host lists in local mode', () => {
    expect(() => parseDatabaseUrl('postgres://u@127.0.0.1,10.0.0.5/db', { requireLoopback: true })).toThrow(DatabaseConfigError);
  });

  it('uses the configured variable name in messages', () => {
    expect(messageOf(() => parseDatabaseUrl(undefined, { variableName: 'TEST_DATABASE_URL' }))).toContain('TEST_DATABASE_URL');
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback names only', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});
