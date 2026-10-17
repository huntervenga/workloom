import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  actorSchema,
  devActorListResponseSchema,
  devSessionInputSchema,
  envelopeSchema,
  errorResponseSchema,
  idSchema,
  meResponseSchema,
  membershipListResponseSchema,
  workspaceListResponseSchema,
  workspaceSchema,
} from './index.js';

const actor = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Synthetic Member One',
  kind: 'fixture',
} as const;

const workspace = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Synthetic Workspace',
  role: 'member',
  timezone: 'Asia/Nicosia',
} as const;

describe('meResponseSchema', () => {
  it('accepts the development identity envelope', () => {
    const body = { data: { actor, authMode: 'dev' }, meta: { requestId: 'req_1' } };

    expect(meResponseSchema.parse(body)).toEqual(body);
  });

  it('accepts shared Auth with a real actor and rejects unknown auth modes', () => {
    const body = { data: { actor: { ...actor, kind: 'real' }, authMode: 'shared' }, meta: { requestId: 'req_1' } };

    expect(meResponseSchema.parse(body)).toEqual(body);
    expect(meResponseSchema.safeParse({ ...body, data: { ...body.data, authMode: 'unknown' } }).success).toBe(false);
  });

  it('rejects unrecognized actor kinds', () => {
    expect(actorSchema.safeParse({ ...actor, kind: 'user' }).success).toBe(false);
  });
});

describe('development identity DTOs', () => {
  it('accepts a list of fixture actors', () => {
    const body = { data: [actor], meta: { requestId: 'req_7' } };

    expect(devActorListResponseSchema.parse(body)).toEqual(body);
  });

  it('keeps real users out of the fixture discovery DTO', () => {
    expect(devActorListResponseSchema.safeParse({ data: [{ ...actor, kind: 'real' }], meta: { requestId: 'req_real' } }).success).toBe(false);
  });

  it('accepts a session request with only a UUID actorId', () => {
    expect(devSessionInputSchema.parse({ actorId: actor.id })).toEqual({ actorId: actor.id });
  });

  it('rejects non-UUID actor ids and unknown keys', () => {
    expect(devSessionInputSchema.safeParse({ actorId: 'actor-1' }).success).toBe(false);
    expect(devSessionInputSchema.safeParse({ actorId: actor.id, role: 'owner' }).success).toBe(false);
  });
});

describe('idSchema', () => {
  it('canonicalizes uppercase UUIDs to lowercase, also inside DTOs', () => {
    const upper = '5EED0000-0000-4000-8000-000000000101';

    expect(idSchema.parse(upper)).toBe('5eed0000-0000-4000-8000-000000000101');
    expect(workspaceSchema.parse({ ...workspace, id: upper }).id).toBe('5eed0000-0000-4000-8000-000000000101');
  });

  it('still rejects values that are not RFC UUIDs', () => {
    expect(idSchema.safeParse('00000000-0000-0000-0000-000000000001').success).toBe(false);
  });
});

describe('workspace DTOs', () => {
  it('rejects roles outside owner/admin/member/viewer', () => {
    expect(workspaceSchema.safeParse({ ...workspace, role: 'superuser' }).success).toBe(false);
  });

  it('rejects identifiers that are not UUIDs', () => {
    expect(workspaceSchema.safeParse({ ...workspace, id: 'workspace-1' }).success).toBe(false);
  });

  it('accepts a workspace list with a null cursor on the last page', () => {
    const body = { data: [workspace], meta: { requestId: 'req_2', nextCursor: null } };

    expect(workspaceListResponseSchema.parse(body)).toEqual(body);
  });

  it('requires workspaceId and userId on memberships', () => {
    const membership = {
      id: '00000000-0000-4000-8000-000000000201',
      workspaceId: workspace.id,
      displayName: actor.displayName,
      role: 'owner',
    };
    const body = { data: [membership], meta: { requestId: 'req_3' } };

    expect(membershipListResponseSchema.safeParse(body).success).toBe(false);
    expect(
      membershipListResponseSchema.safeParse({
        ...body,
        data: [{ ...membership, userId: actor.id }],
      }).success,
    ).toBe(true);
  });
});

describe('envelopeSchema', () => {
  const countEnvelope = envelopeSchema(z.object({ count: z.number() }));

  it('requires meta.requestId', () => {
    expect(countEnvelope.safeParse({ data: { count: 1 }, meta: {} }).success).toBe(false);
  });

  it('accepts a string, null or absent nextCursor and nothing else', () => {
    const data = { count: 1 };

    expect(countEnvelope.safeParse({ data, meta: { requestId: 'r' } }).success).toBe(true);
    expect(countEnvelope.safeParse({ data, meta: { requestId: 'r', nextCursor: 'c1' } }).success).toBe(true);
    expect(countEnvelope.safeParse({ data, meta: { requestId: 'r', nextCursor: null } }).success).toBe(true);
    expect(countEnvelope.safeParse({ data, meta: { requestId: 'r', nextCursor: 2 } }).success).toBe(false);
  });

  it('validates the wrapped payload', () => {
    expect(countEnvelope.safeParse({ data: { count: 'one' }, meta: { requestId: 'r' } }).success).toBe(false);
  });
});

describe('errorResponseSchema', () => {
  it('accepts the documented error shape', () => {
    const body = {
      error: {
        code: 'NOT_FOUND',
        message: 'Workspace not found.',
        details: { resource: 'workspace' },
        retryable: false,
      },
      meta: { requestId: 'req_4' },
    };

    expect(errorResponseSchema.parse(body)).toEqual(body);
  });

  it('requires the retryable flag', () => {
    const body = { error: { code: 'NOT_FOUND', message: 'Workspace not found.' }, meta: { requestId: 'req_5' } };

    expect(errorResponseSchema.safeParse(body).success).toBe(false);
  });

  it('rejects details that are not an object', () => {
    const body = {
      error: { code: 'VALIDATION_FAILED', message: 'Invalid input.', details: 'name', retryable: false },
      meta: { requestId: 'req_6' },
    };

    expect(errorResponseSchema.safeParse(body).success).toBe(false);
  });
});
