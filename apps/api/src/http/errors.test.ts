import { errorResponseSchema, MATERIALIZATION_REQUIRED } from '@workloom/contracts';
import { DOMAIN_ERROR_CODES, DomainError, notFoundError } from '@workloom/domain';
import { describe, expect, it } from 'vitest';

import { DOMAIN_ERROR_STATUS, HttpError, mapError } from './errors.js';

describe('mapError', () => {
  it('maps every domain error code to the documented status', () => {
    for (const code of DOMAIN_ERROR_CODES) {
      expect(DOMAIN_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(mapError(notFoundError()).statusCode).toBe(404);
    expect(mapError(new DomainError('CAPABILITY_REQUIRED', 'no')).statusCode).toBe(403);
    expect(mapError(new DomainError('UNAUTHENTICATED', 'no')).statusCode).toBe(401);
    expect(mapError(new DomainError('REVISION_CONFLICT', 'no')).statusCode).toBe(409);
    expect(mapError(new DomainError('PLAN_VALUE_UNRESOLVED', 'no')).statusCode).toBe(422);
    expect(mapError(new DomainError('TEMPORARILY_UNAVAILABLE', 'later')).body.error.retryable).toBe(true);
  });

  it('maps the contract MATERIALIZATION_REQUIRED code to a controlled 409 with domain-owned details', () => {
    const code = MATERIALIZATION_REQUIRED;
    expect(DOMAIN_ERROR_STATUS[code]).toBe(409);
    const details = { periodIds: ['5eed0000-0000-4000-8000-000000000601'], action: 'materialize' };
    const error = new DomainError(code, 'Materialize the period census first.', { details, cause: new Error('select secret') });
    expect(mapError(error)).toEqual({
      statusCode: 409,
      unexpected: false,
      body: { error: { code: MATERIALIZATION_REQUIRED, message: 'Materialize the period census first.', details, retryable: error.retryable } },
    });
    expect(JSON.stringify(mapError(error).body)).not.toContain('secret');
  });

  it('keeps object details and drops non-object details', () => {
    const withDetails = mapError(new DomainError('VALIDATION_FAILED', 'bad', { details: { fields: ['actorId'] } }));
    expect(withDetails.body.error.details).toEqual({ fields: ['actorId'] });
    const primitive = mapError(new DomainError('VALIDATION_FAILED', 'bad', { details: 'raw input' }));
    expect(primitive.body.error).not.toHaveProperty('details');
  });

  it('hides unexpected errors behind a generic 500', () => {
    const mapped = mapError(new Error('select * from users where password = secret'));
    expect(mapped).toMatchObject({ statusCode: 500, unexpected: true, body: { error: { code: 'INTERNAL_ERROR' } } });
    expect(JSON.stringify(mapped.body)).not.toContain('secret');
  });

  it('maps database outages to a safe retryable 503', () => {
    const wrapped = Object.assign(new Error('Failed query: ... params: x'), {
      query: 'select',
      params: ['x'],
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    });
    const mapped = mapError(wrapped);
    expect(mapped).toMatchObject({ statusCode: 503, body: { error: { code: 'TEMPORARILY_UNAVAILABLE', retryable: true } } });
    expect(JSON.stringify(mapped.body)).not.toContain('127.0.0.1');
  });

  it('maps transport errors', () => {
    expect(mapError(new HttpError(421, 'HOST_NOT_ALLOWED', 'no')).statusCode).toBe(421);
    expect(mapError(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 })).statusCode).toBe(413);
    expect(mapError(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 })).statusCode).toBe(415);
    expect(mapError(Object.assign(new SyntaxError('Unexpected token'), { statusCode: 400 })).body.error.code).toBe('VALIDATION_FAILED');
  });

  it('keeps an unsupported media type at 415', () => {
    const mapped = mapError(Object.assign(new Error('Unsupported Media Type: text/plain'), { code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }));
    expect(mapped).toMatchObject({ statusCode: 415, unexpected: false, body: { error: { code: 'UNSUPPORTED_MEDIA_TYPE', retryable: false } } });
    expect(JSON.stringify(mapped.body)).not.toContain('text/plain');
  });

  it('maps a mismatched Content-Length to a 400 malformed request, not 415', () => {
    const mapped = mapError(
      Object.assign(new Error('Request body size did not match Content-Length 999'), { code: 'FST_ERR_CTP_INVALID_CONTENT_LENGTH', statusCode: 400 }),
    );
    expect(mapped).toEqual({
      statusCode: 400,
      unexpected: false,
      body: { error: { code: 'BAD_REQUEST', message: 'The request is malformed.', retryable: false } },
    });
    expect(JSON.stringify(mapped.body)).not.toContain('999');
  });

  it('produces bodies that satisfy the contract error schema', () => {
    for (const error of [notFoundError(), new Error('x'), new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'no')]) {
      expect(errorResponseSchema.safeParse({ ...mapError(error).body, meta: { requestId: 'r' } }).success).toBe(true);
    }
  });
});
