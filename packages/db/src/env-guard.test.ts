import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UnsafeEnvironmentError, assertLocalSyntheticEnvironment, findRailwayMarkers, loadEnvFileIfPresent } from './env-guard.js';

describe('findRailwayMarkers', () => {
  it('reports any RAILWAY_* variable by name, even when empty', () => {
    expect(
      findRailwayMarkers({ RAILWAY_ENVIRONMENT: 'production', RAILWAY_PUBLIC_DOMAIN: '', PATH: '/bin', RAILWAY: '1' }),
    ).toEqual(['RAILWAY', 'RAILWAY_ENVIRONMENT', 'RAILWAY_PUBLIC_DOMAIN']);
    expect(findRailwayMarkers({ MY_RAILWAY_NOTE: 'x' })).toEqual([]);
  });
});

describe('assertLocalSyntheticEnvironment', () => {
  it('accepts APP_ENV=local without hosted markers', () => {
    expect(() => assertLocalSyntheticEnvironment({ APP_ENV: 'local' }, 'db:seed:demo')).not.toThrow();
  });

  it.each([{}, { APP_ENV: 'staging' }, { APP_ENV: 'production' }, { APP_ENV: 'local', RAILWAY_PROJECT_ID: 'p' }])(
    'rejects %o',
    (env) => {
      expect(() => assertLocalSyntheticEnvironment(env, 'db:seed:demo')).toThrow(UnsafeEnvironmentError);
    },
  );

  it('names Railway variables but never prints their values', () => {
    try {
      assertLocalSyntheticEnvironment({ APP_ENV: 'local', RAILWAY_TOKEN: 'token-value-123' }, 'db:migrate');
    } catch (error) {
      expect((error as Error).message).toContain('RAILWAY_TOKEN');
      expect((error as Error).message).not.toContain('token-value-123');
      return;
    }
    throw new Error('expected UnsafeEnvironmentError');
  });
});

describe('loadEnvFileIfPresent', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('fills missing variables and keeps existing ones', () => {
    dir = mkdtempSync(join(tmpdir(), 'workloom-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'APP_ENV=local\nPORT=4310\n# comment\n');
    const target: Record<string, string | undefined> = { PORT: '5000' };
    expect(loadEnvFileIfPresent(file, target)).toBe(true);
    expect(target).toEqual({ APP_ENV: 'local', PORT: '5000' });
  });

  it('ignores a missing file', () => {
    expect(loadEnvFileIfPresent(join(tmpdir(), 'definitely-missing-workloom.env'), {})).toBe(false);
  });
});
