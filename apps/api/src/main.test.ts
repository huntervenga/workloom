import { MigrationStateError } from '@workloom/db';
import type * as DatabaseModule from '@workloom/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConfigModule from './config.js';

const doubles = vi.hoisted(() => ({
  migrate: vi.fn(), loadEnv: vi.fn(), loadConfig: vi.fn(), createApp: vi.fn(),
  listen: vi.fn(), close: vi.fn(), info: vi.fn(), error: vi.fn(),
}));
vi.mock('@workloom/db', async (original) => ({
  ...await original<typeof DatabaseModule>(),
  runMigrations: doubles.migrate, loadEnvFileIfPresent: doubles.loadEnv,
}));
vi.mock('./config.js', async (original) => ({
  ...await original<typeof ConfigModule>(), loadConfig: doubles.loadConfig,
}));
vi.mock('./app.js', () => ({ createApp: doubles.createApp }));

const databaseUrl = 'postgres://fixture:private-password@postgres.railway.internal/workloom';
const result = { appliedNow: ['0034_user_settings'], state: { status: 'current', expectedCount: 35 } };
const signals = ['SIGINT', 'SIGTERM'] as const;
let originalListeners: Map<NodeJS.Signals, Set<NodeJS.SignalsListener>>;
let originalExitCode: typeof process.exitCode;
let output: string[];
let errors: string[];

function configure(appEnv: string, authMode = 'shared') {
  vi.stubEnv('APP_ENV', appEnv);
  doubles.loadConfig.mockReturnValue({ appEnv, authMode, nodeEnv: 'production',
    host: '0.0.0.0', port: 8080, database: { url: databaseUrl, description: 'fixture' } });
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  originalListeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  output = []; errors = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  doubles.migrate.mockResolvedValue(result);
  doubles.listen.mockResolvedValue(undefined);
  doubles.createApp.mockResolvedValue({ listen: doubles.listen, close: doubles.close,
    log: { info: doubles.info, error: doubles.error } });
  configure('production');
});

afterEach(() => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!originalListeners.get(signal)?.has(listener)) process.removeListener(signal, listener);
    }
  }
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('API entrypoint migration gate', () => {
  it.each(['staging', 'production'])('waits for migrations before creating or listening in %s', async (mode) => {
    configure(mode);
    let finish: (value: typeof result) => void = () => { throw new Error('missing resolver'); };
    const pending = new Promise<typeof result>(resolve => { finish = resolve; });
    doubles.migrate.mockReturnValue(pending);
    await import('./main.js');
    await vi.waitFor(() => expect(doubles.migrate).toHaveBeenCalledWith(databaseUrl, { requireLoopback: false }));
    expect(doubles.createApp).not.toHaveBeenCalled();
    expect(doubles.listen).not.toHaveBeenCalled();
    expect(doubles.loadEnv).not.toHaveBeenCalled();
    finish(result);
    await vi.waitFor(() => expect(doubles.listen).toHaveBeenCalledWith({ host: '0.0.0.0', port: 8080 }));
    expect(JSON.parse(output.join(''))).toEqual({ event: 'HOSTED_MIGRATION_COMPLETE', phase: 'startup',
      appliedCount: 1, appliedMigrations: ['0034_user_settings'], expectedCount: 35 });
    expect(output.join('')).not.toContain('private-password');
    expect(errors).toEqual([]);
  });

  it.each(['dev', 'shared'])('does not migrate local databases with %s identity', async (mode) => {
    configure('local', mode);
    await import('./main.js');
    await vi.waitFor(() => expect(doubles.listen).toHaveBeenCalledOnce());
    expect(doubles.migrate).not.toHaveBeenCalled();
    expect(doubles.loadEnv).toHaveBeenCalledOnce();
    expect(output).toEqual([]);
  });

  it('starts normally when pre-deploy has already applied everything', async () => {
    doubles.migrate.mockResolvedValue({ ...result, appliedNow: [] });
    await import('./main.js');
    await vi.waitFor(() => expect(doubles.listen).toHaveBeenCalledOnce());
    expect(JSON.parse(output.join('')).appliedCount).toBe(0);
  });

  it.each([
    { failure: new MigrationStateError('private history detail'), reason: 'MIGRATION_HISTORY_INVALID' },
    { failure: Object.assign(new Error('private SQL and credentials'), { code: '42P01' }), reason: 'MIGRATION_FAILED', code: '42P01' },
    { failure: Object.assign(new Error('private SQL'), { code: 'postgres://private-password@host/db' }), reason: 'MIGRATION_FAILED' },
  ])('refuses startup and emits only safe diagnostics for $reason', async ({ failure, reason, code }) => {
    doubles.migrate.mockRejectedValue(failure);
    await import('./main.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(doubles.createApp).not.toHaveBeenCalled();
    expect(doubles.listen).not.toHaveBeenCalled();
    expect(output).toEqual([]);
    expect(JSON.parse(errors.join(''))).toEqual({ error: 'HOSTED_MIGRATION_FAILED', phase: 'startup', reason,
      ...(code ? { code } : {}) });
    expect(errors.join('')).not.toContain('private');
  });

  it('validates configuration before reaching the database', async () => {
    const { ConfigError } = await import('./config.js');
    doubles.loadConfig.mockImplementation(() => { throw new ConfigError(['invalid fixture config']); });
    await import('./main.js');
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(doubles.migrate).not.toHaveBeenCalled();
    expect(doubles.createApp).not.toHaveBeenCalled();
  });
});
