/**
 * Trusted execution context. Only server-side adapters construct these values;
 * a client can never supply actor, capabilities, source or server time.
 */
export const COMMAND_SOURCES = ['web', 'api', 'mcp', 'job', 'import'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

/** P0 knows only synthetic fixture identities; P6 adds real identities. */
export type ActorKind = 'fixture';

export interface Actor {
  /** Internal Workloom user ID (UUID). */
  readonly userId: string;
  readonly displayName: string;
  readonly kind: ActorKind;
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
