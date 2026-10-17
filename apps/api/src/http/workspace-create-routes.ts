import { createWorkspaceInputSchema, idSchema, workspaceResponseSchema } from '@workloom/contracts';
import { DomainError, capabilityRequiredError, type WorkspaceCreateApplication } from '@workloom/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { IdentityAdapter } from '../identity/identity-adapter.js';
import { parseInput, sendData } from './envelope.js';
import { readIdempotencyKey } from './task-routes.js';

export interface WorkspaceCreateRouteDependencies {
  readonly identity: IdentityAdapter;
  readonly workspaces: WorkspaceCreateApplication;
}

const ACTOR_HEADER_MESSAGE = 'A valid X-Workloom-Actor-ID header is required.';

/**
 * The browser's view of who is signed in. It only binds the request to that intent so a stale
 * tab cannot create a workspace for a different session; it never selects or authorizes an actor.
 */
function readIntendedActorId(request: FastifyRequest): string {
  const value = request.headers['x-workloom-actor-id'];
  const parsed = idSchema.safeParse(value);
  if (typeof value !== 'string' || !parsed.success) {
    throw new DomainError('VALIDATION_FAILED', ACTOR_HEADER_MESSAGE, { details: { fields: ['X-Workloom-Actor-ID'] } });
  }
  return parsed.data;
}

/**
 * POST /api/v1/workspaces: creates an empty workspace owned by the verified shared-Auth actor.
 * Replay, payload hashing and current-membership checks belong to the WorkspaceCreateApplication.
 */
export function registerWorkspaceCreateRoutes(app: FastifyInstance, deps: WorkspaceCreateRouteDependencies): void {
  app.post('/api/v1/workspaces', async (request, reply) => {
    // Development fixtures never create workspaces; deny before resolving any identity.
    if (deps.identity.mode !== 'shared') throw capabilityRequiredError();
    const idempotencyKey = readIdempotencyKey(request);
    const intendedActorId = readIntendedActorId(request);
    const input = parseInput(createWorkspaceInputSchema, request.body);

    const actor = await deps.identity.resolveActor(request);
    if (actor.kind !== 'real') throw capabilityRequiredError();
    if (intendedActorId.toLowerCase() !== actor.userId.toLowerCase()) {
      throw new DomainError('REVISION_CONFLICT', 'The signed-in account changed. Reload and retry.');
    }

    const workspace = await deps.workspaces.createWorkspace(
      { actor, source: 'web', requestId: request.id, idempotencyKey },
      input,
    );
    return sendData(request, reply, workspaceResponseSchema, workspace, { statusCode: 201 });
  });
}
