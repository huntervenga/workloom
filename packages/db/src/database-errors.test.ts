import { describe, expect, it } from 'vitest';

import { databaseErrorCode, describeErrorForLog, isDatabaseUnavailableError } from './database-errors.js';

function codeError(code: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { code });
}

describe('database error classification', () => {
  it('finds codes through the cause chain (Drizzle wraps driver errors)', () => {
    const wrapped = Object.assign(new Error('Failed query: select 1\nparams: secret-param'), {
      query: 'select 1',
      params: ['secret-param'],
      cause: codeError('55P03'),
    });
    expect(databaseErrorCode(wrapped)).toBe('55P03');
    expect(isDatabaseUnavailableError(wrapped)).toBe(true);
  });

  it.each(['ECONNREFUSED', 'CONNECT_TIMEOUT', '57P01', '08006', '3D000', '28P01', '42P01', '40001'])(
    'treats %s as temporarily unavailable',
    (code) => {
      expect(isDatabaseUnavailableError(codeError(code))).toBe(true);
    },
  );

  it.each(['23505', '22P02', '42601'])('does not treat %s as unavailable', (code) => {
    expect(isDatabaseUnavailableError(codeError(code))).toBe(false);
  });

  it('drops database messages (SQL, parameters, user names) from log descriptions', () => {
    const wrapped = Object.assign(new Error('Failed query: insert ...\nparams: private-value'), {
      query: 'insert ...',
      params: ['private-value'],
      cause: Object.assign(new Error('password authentication failed for user "workloom"'), { code: '28P01' }),
    });
    const described = describeErrorForLog(wrapped);
    expect(described).toEqual({ type: 'DatabaseError', code: '28P01' });
    expect(JSON.stringify(described)).not.toContain('private-value');
    expect(JSON.stringify(described)).not.toContain('workloom');
  });

  it('keeps messages of ordinary errors', () => {
    expect(describeErrorForLog(new TypeError('bad input'))).toEqual({ type: 'TypeError', message: 'bad input' });
    expect(describeErrorForLog('plain')).toEqual({ type: 'string' });
  });

  it('survives cyclic causes', () => {
    const error = new Error('cyclic') as Error & { cause?: unknown };
    error.cause = error;
    expect(databaseErrorCode(error)).toBeUndefined();
  });
});
