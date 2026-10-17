import { describe, expect, it } from 'vitest';
import { workspaceChangeHeadQuerySchema, workspaceChangeHeadResponseSchema, workspaceChangeHeadSchema } from './workspace-change-head.js';

const head = {
  workspaceId: 'aa000000-0000-4000-8000-000000000001',
  actorUserId: 'aa000000-0000-4000-8000-000000000002',
  membershipId: 'aa000000-0000-4000-8000-000000000003',
  membershipRevision: 1, role: 'viewer', changeSeq: '0', permissionEpoch: '0',
};

describe('workspace change head contract', () => {
  it('canonicalizes all IDs and preserves zero, unsafe-number-range and maximum bigint decimals', () => {
    const input = { ...head, workspaceId: head.workspaceId.toUpperCase(), actorUserId: head.actorUserId.toUpperCase(), membershipId: head.membershipId.toUpperCase() };
    expect(workspaceChangeHeadSchema.parse(input)).toEqual(head);
    for (const value of ['0', '1', '9007199254740993', '9223372036854775807']) {
      expect(workspaceChangeHeadSchema.parse({ ...head, changeSeq: value, permissionEpoch: value })).toMatchObject({ changeSeq: value, permissionEpoch: value });
    }
  });
  it('rejects noncanonical decimals, numbers and bigint overflow for both sequence fields', () => {
    for (const field of ['changeSeq', 'permissionEpoch']) {
      for (const value of ['-1', '+1', '00', '01', ' 1', '1 ', '1.0', '1e3', '', '9223372036854775808', '18446744073709551616', '9'.repeat(100), 0, 1, 1n, null]) {
        expect(workspaceChangeHeadSchema.safeParse({ ...head, [field]: value }).success, `${field}: ${String(value)}`).toBe(false);
      }
    }
  });
  it('requires a bounded membership revision, known role, valid IDs and every head field', () => {
    for (const value of [0, -1, 1.5, 2147483648, '1', null]) expect(workspaceChangeHeadSchema.safeParse({ ...head, membershipRevision: value }).success).toBe(false);
    expect(workspaceChangeHeadSchema.parse({ ...head, membershipRevision: 2147483647 }).membershipRevision).toBe(2147483647);
    for (const role of ['owner', 'admin', 'member', 'viewer']) expect(workspaceChangeHeadSchema.safeParse({ ...head, role }).success).toBe(true);
    expect(workspaceChangeHeadSchema.safeParse({ ...head, role: 'guest' }).success).toBe(false);
    for (const field of ['workspaceId', 'actorUserId', 'membershipId']) expect(workspaceChangeHeadSchema.safeParse({ ...head, [field]: 'invalid' }).success).toBe(false);
    for (const field of Object.keys(head)) { const incomplete = Object.fromEntries(Object.entries(head).filter(([key]) => key !== field)); expect(workspaceChangeHeadSchema.safeParse(incomplete).success).toBe(false); }
  });
  it('accepts only an empty query and strict payload, envelope and metadata keys', () => {
    expect(workspaceChangeHeadQuerySchema.parse({})).toEqual({});
    for (const field of ['actorUserId', 'actorId', 'membershipId', 'role', 'workspaceId', 'projectId', 'cursor', 'since']) expect(workspaceChangeHeadQuerySchema.safeParse({ [field]: 'x' }).success).toBe(false);
    const response = { data: head, meta: { requestId: 'request' } };
    expect(workspaceChangeHeadResponseSchema.parse(response)).toEqual(response);
    expect(workspaceChangeHeadSchema.safeParse({ ...head, taskIds: [] }).success).toBe(false);
    expect(workspaceChangeHeadResponseSchema.safeParse({ ...response, extra: true }).success).toBe(false);
    expect(workspaceChangeHeadResponseSchema.safeParse({ ...response, data: { ...head, extra: true } }).success).toBe(false);
    expect(workspaceChangeHeadResponseSchema.safeParse({ ...response, meta: { requestId: 'request', extra: true } }).success).toBe(false);
  });
});
