import { describe, expect, it } from 'vitest';
import { DomainError, isDomainError, notFoundError, temporarilyUnavailableError } from './errors.js';

describe('DomainError', () => {
  it('carries code, safe details and default retryability', () => {
    const conflict = new DomainError('REVISION_CONFLICT', 'Revision changed.', { details: { currentRevision: 3 } });
    expect(conflict.code).toBe('REVISION_CONFLICT');
    expect(conflict.details).toEqual({ currentRevision: 3 });
    expect(conflict.retryable).toBe(false);
    expect(temporarilyUnavailableError().retryable).toBe(true);
    expect(new DomainError('RATE_LIMITED', 'Slow down.').retryable).toBe(true);
  });

  it('keeps the internal cause out of enumerable fields', () => {
    const cause = new Error('connection string postgres://user:secret@db/x');
    const error = temporarilyUnavailableError(cause);
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('is recognized by brand even across module copies', () => {
    expect(isDomainError(notFoundError())).toBe(true);
    const foreignCopy = Object.create(null) as Record<symbol, unknown>;
    foreignCopy[Symbol.for('workloom.domain.DomainError')] = true;
    expect(isDomainError(foreignCopy)).toBe(true);
    expect(isDomainError(new Error('plain'))).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});
