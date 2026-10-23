import { createWorkspaceInputSchema, idSchema, type CreateWorkspaceInput, type WorkspaceDto } from '@workloom/contracts';

import { authorizeLoadedAccess } from '../access/access-queries.js';
import { COMMAND_SOURCES, type ActorContext } from '../access/context.js';
import type { UserRecord, WorkspaceAccessRecord } from '../access/ports.js';
import { DomainError, capabilityRequiredError, unauthenticatedError } from '../errors.js';

export type WorkspaceCreateContext = ActorContext & { readonly idempotencyKey: string };

export interface WorkspaceCreateApplication {
  /**
   * Creates an empty workspace owned by the current real actor. A retry with the same
   * actor, key and body returns the same workspace as currently visible to the actor.
   */
  createWorkspace(context: WorkspaceCreateContext, input: CreateWorkspaceInput): Promise<WorkspaceDto>;
}

/** Actor-scoped receipt: no plaintext input, only the canonical payload hash. */
export interface WorkspaceCreationReceipt {
  readonly workspaceId: string;
  readonly payloadHash: string;
}

export interface NewWorkspacePlan {
  readonly workspaceId: string;
  readonly membershipId: string;
  readonly name: string;
  readonly timezone: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly context: ActorContext;
}

/**
 * One bounded creation transaction. The adapter has already taken the advisory lock scoped
 * to (actor, Idempotency-Key) before `work` runs, so concurrent identical requests serialize.
 */
export interface WorkspaceCreateScope {
  /** Persisted user, re-read inside the transaction; null when absent. */
  findActor(userId: string): Promise<UserRecord | null>;
  findReceipt(actorUserId: string, idempotencyKey: string): Promise<WorkspaceCreationReceipt | null>;
  /** Locks the workspace row (the barrier) and then reads the actor's current membership in any state. */
  lockWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceAccessRecord | null>;
  /**
   * Inserts the workspace (default week start and permission epoch), the owner membership,
   * the single `workspace.created` audit event at change sequence 1 and the receipt.
   */
  insertWorkspace(plan: NewWorkspacePlan): Promise<WorkspaceAccessRecord>;
  /** Active workspaces this person owns; bounds how many a single account can create. */
  countOwnedWorkspaces?(userId: string): Promise<number>;
}

export interface WorkspaceCreateUnitOfWork {
  run<T>(actorUserId: string, idempotencyKey: string, work: (scope: WorkspaceCreateScope) => Promise<T>): Promise<T>;
}

export interface WorkspaceCreateServiceDependencies {
  readonly unitOfWork: WorkspaceCreateUnitOfWork;
  readonly newId: () => string;
  /** SHA-256 hex of the canonical payload. */
  readonly digest: (value: string) => string;
}

/** A generous ceiling that stops scripted creation, not real use. */
export const MAX_OWNED_WORKSPACES = 25;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const PAYLOAD_VERSION = 'workspace.create.v1';

function validationError(fields: string[], message = 'The request is invalid.'): DomainError {
  return new DomainError('VALIDATION_FAILED', message, { details: { fields } });
}

function sameId(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Re-validates the trusted context; only real shared-Auth principals may create workspaces. */
function normalizeContext(context: WorkspaceCreateContext): WorkspaceCreateContext {
  const key = context.idempotencyKey;
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw validationError(['Idempotency-Key'], 'A valid Idempotency-Key is required.');
  }
  const userId = idSchema.safeParse(context.actor.userId);
  if (!userId.success) throw unauthenticatedError();
  if (context.actor.kind !== 'real') throw capabilityRequiredError();
  if (!COMMAND_SOURCES.includes(context.source) || typeof context.requestId !== 'string' ||
      context.requestId.length < 1 || context.requestId.length > 128) {
    throw new Error('Workspace creation needs a trusted source and request ID.');
  }
  return {
    actor: { userId: userId.data, displayName: context.actor.displayName, kind: 'real' },
    source: context.source,
    requestId: context.requestId,
    idempotencyKey: key,
  };
}

function toDto(access: WorkspaceAccessRecord): WorkspaceDto {
  return {
    id: access.workspace.id,
    name: access.workspace.name,
    role: access.membership.role,
    timezone: access.workspace.timezone,
  };
}

export function createWorkspaceCreateService(dependencies: WorkspaceCreateServiceDependencies): WorkspaceCreateApplication {
  const newId = (): string => idSchema.parse(dependencies.newId());

  function payloadHash(input: CreateWorkspaceInput): string {
    // Fixed-order array: the hash covers exactly name and timezone, nothing else.
    const hash = dependencies.digest(JSON.stringify([PAYLOAD_VERSION, input.name, input.timezone]));
    if (!PAYLOAD_HASH_PATTERN.test(hash)) throw new Error('Payload digest must be lower-case SHA-256 hex.');
    return hash;
  }

  return {
    async createWorkspace(context, rawInput) {
      const ctx = normalizeContext(context);
      const parsed = createWorkspaceInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw validationError([...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join('.') || '(root)'))]);
      }
      const input = parsed.data;
      const hash = payloadHash(input);
      const actorUserId = ctx.actor.userId;

      return dependencies.unitOfWork.run(actorUserId, ctx.idempotencyKey, async (scope) => {
        const user = await scope.findActor(actorUserId);
        if (user === null) throw unauthenticatedError();
        if (user.kind !== 'real') throw capabilityRequiredError();

        const receipt = await scope.findReceipt(actorUserId, ctx.idempotencyKey);
        if (receipt !== null) {
          // Lock first, then authorize the *current* membership: a revoked or removed owner
          // sees the neutral NOT_FOUND and a demoted owner sees the current role.
          const access = await scope.lockWorkspaceAccess(receipt.workspaceId, actorUserId);
          if (access !== null && (!sameId(access.membership.userId, actorUserId) || !sameId(access.workspace.id, receipt.workspaceId))) {
            throw new Error('Workspace access lookup returned a foreign row.');
          }
          const current = authorizeLoadedAccess(access, 'workspace.read');
          if (receipt.payloadHash !== hash) {
            throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
          }
          return toDto(current);
        }

        if (scope.countOwnedWorkspaces && (await scope.countOwnedWorkspaces(actorUserId)) >= MAX_OWNED_WORKSPACES) {
          throw new DomainError('DOMAIN_VALIDATION_FAILED', `You can own at most ${MAX_OWNED_WORKSPACES} workspaces.`);
        }
        const workspaceId = newId();
        let membershipId = newId();
        while (sameId(membershipId, workspaceId)) membershipId = newId();
        const created = await scope.insertWorkspace({
          workspaceId,
          membershipId,
          name: input.name,
          timezone: input.timezone,
          idempotencyKey: ctx.idempotencyKey,
          payloadHash: hash,
          context: { actor: ctx.actor, source: ctx.source, requestId: ctx.requestId },
        });
        if (!sameId(created.workspace.id, workspaceId) || !sameId(created.membership.id, membershipId) ||
            created.membership.role !== 'owner' || created.membership.state !== 'active') {
          throw new Error('Workspace creation returned an unexpected membership.');
        }
        return toDto(created);
      });
    },
  };
}
