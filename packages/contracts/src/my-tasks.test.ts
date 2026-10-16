import { describe, expect, it } from 'vitest';
import { myTasksQuerySchema, myTasksResponseSchema } from './my-tasks.js';

describe('self-only personal task query', () => {
  it('requires an explicit pagination result rather than treating omitted metadata as completion', () => {
    expect(myTasksResponseSchema.safeParse({ data: [], meta: { requestId: 'test' } }).success).toBe(false);
    expect(myTasksResponseSchema.safeParse({ data: [], meta: { requestId: 'test', nextCursor: null } }).success).toBe(true);
  });
  it('has bounded explicit defaults and normalizes search and query booleans', () => {
    expect(myTasksQuerySchema.parse({})).toEqual({ relation: 'all', completion: 'open', includeArchived: false, limit: 50 });
    expect(myTasksQuerySchema.parse({ relation: 'participating', completion: 'closed', includeArchived: 'true', search: '  roadmap  ', limit: '200' })).toEqual({ relation: 'participating', completion: 'closed', includeArchived: true, search: 'roadmap', limit: 200 });
    expect(myTasksQuerySchema.parse({ includeArchived: 'false' }).includeArchived).toBe(false);
  });
  it('rejects arbitrary identities, unsupported sorting and unbounded queries', () => {
    for (const query of [{ membershipId: '00000000-0000-4000-8000-000000000001' }, { actorId: 'self' }, { projectId: 'all' }, { sort: 'title' }, { relation: 'anyone' }, { completion: 'unknown' }, { includeArchived: 'yes' }, { includeArchived: 'TRUE' }, { search: 'x'.repeat(201) }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { cursor: '' }, { cursor: 'x'.repeat(2049) }]) expect(myTasksQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false);
  });
});
