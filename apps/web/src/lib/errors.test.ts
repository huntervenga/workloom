import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeError } from './errors';
describe('discussion error privacy and recovery', () => {
  it.each(['comments', 'commentSave', 'activity'] as const)('keeps missing/denied %s equally unavailable', subject => {
    const missing = describeError(new ApiError({ kind: 'not_found', status: 404, requestId: 'request' }), subject);
    const denied = describeError(new ApiError({ kind: 'forbidden', status: 403, requestId: 'request' }), subject);
    expect(denied).toEqual(missing);
    expect(missing).toMatchObject({ title: 'Task unavailable', retryable: false, unavailable: true, requestId: 'request' });
  });
  it.each(['tablePreference', 'tablePreferenceSave'] as const)('keeps missing/denied own %s equally unavailable', subject => {
    const missing = describeError(new ApiError({ kind: 'not_found', status: 404 }), subject);
    const denied = describeError(new ApiError({ kind: 'forbidden', status: 403 }), subject);
    expect(denied).toEqual(missing);
    expect(missing).toMatchObject({ title: 'Project unavailable', unavailable: true, retryable: false });
  });
  it('uses fixed save copy for a lost answer and never renders arbitrary native exception text', () => {
    expect(describeError(new ApiError({ kind: 'network', status: null }), 'commentSave')).toMatchObject({ title: 'Unable to add the comment', retryable: true, unavailable: false });
    const unknown = describeError(new Error('Secret body or database message'), 'comments');
    expect(JSON.stringify(unknown)).not.toContain('Secret');
    expect(unknown.title).toBe('Unable to load comments');
  });
});
