/**
 * Trusted execution context. Only server-side adapters construct these values;
 * a client can never supply actor, capabilities, source or server time.
 */
export const COMMAND_SOURCES = ['web', 'api', 'mcp', 'job', 'import'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

/** Internal identities keep real shared-Auth principals distinct from synthetic fixtures. */
export type ActorKind = 'fixture' | 'real';

export interface Actor {
  /** Internal Workloom user ID (UUID). */
  readonly userId: string;
  readonly displayName: string;
  readonly kind: ActorKind;
  /** Current stored profile photo URL; presentation only, never an authorization input. */
  readonly avatarUrl?: string | null;
}

export interface ActorContext {
  readonly actor: Actor;
  readonly source: CommandSource;
  /** Server-generated correlation ID of the request/job. */
  readonly requestId: string;
}

export interface CommandContext extends ActorContext {
  readonly workspaceId: string;
  readonly idempotencyKey?: string;
}

export function toCommandContext(
  context: ActorContext,
  workspaceId: string,
  idempotencyKey?: string,
): CommandContext {
  return idempotencyKey === undefined
    ? { actor: context.actor, source: context.source, requestId: context.requestId, workspaceId }
    : { actor: context.actor, source: context.source, requestId: context.requestId, workspaceId, idempotencyKey };
}
