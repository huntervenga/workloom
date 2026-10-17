import { createWorkspaceInputSchema, workspaceResponseSchema, type CreateWorkspaceInput, type WorkspaceDto } from '@workloom/contracts';
import { ApiError, apiRequest, prepareMutation, type MutationRequest } from '../../lib/api';
import { isUuid } from '../../lib/format';

/** Same limits as the create-workspace input in @workloom/contracts, which remains the authority. */
export const WORKSPACE_NAME_MAX = 200;
export const WORKSPACE_TIMEZONE_MAX = 64;

export const ACTOR_HEADER = 'X-Workloom-Actor-ID';

/**
 * One create command exactly as it is sent: the parsed body, its Idempotency-Key and the actor it
 * was prepared for. It is frozen, so an explicit retry resends the same bytes under the same key
 * and can never pick up another actor, draft or body.
 */
export interface WorkspaceCreationCommand {
  readonly request: MutationRequest<{ data: WorkspaceDto }>;
  readonly input: Readonly<CreateWorkspaceInput>;
  readonly idempotencyKey: string;
  readonly actorId: string;
}

/** Validates the draft against the shared schema; invalid input throws `invalid_input` and is never sent. */
export function prepareWorkspaceCreation(input: CreateWorkspaceInput, actorId: string, idempotencyKey: string): WorkspaceCreationCommand {
  if (!isUuid(idempotencyKey)) throw new TypeError('A mutation needs a UUID Idempotency-Key.');
  const request = prepareMutation({
    method: 'POST',
    path: '/api/v1/workspaces',
    input,
    inputSchema: createWorkspaceInputSchema,
    responseSchema: workspaceResponseSchema,
  });
  return Object.freeze({
    request,
    input: Object.freeze({ ...(request.body as CreateWorkspaceInput) }),
    idempotencyKey,
    actorId,
  });
}

/**
 * Sends a prepared create command once, like `sendMutation`, plus the actor header the server
 * checks against the session. The shared helper adds no identity headers, so this feature-only
 * sender binds it from the frozen command instead of changing the core helper.
 */
export async function sendWorkspaceCreation(command: WorkspaceCreationCommand, signal?: AbortSignal): Promise<WorkspaceDto> {
  const { request } = command;
  const { status, payload } = await apiRequest(request.path, {
    method: request.method,
    body: request.body,
    headers: { 'Idempotency-Key': command.idempotencyKey, [ACTOR_HEADER]: command.actorId },
    signal,
  });
  const parsed = request.responseSchema.safeParse(payload);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_response', status });
  return parsed.data.data;
}
