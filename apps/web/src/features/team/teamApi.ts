import {
  acceptTeamInvitationInputSchema,
  acceptTeamInvitationResponseSchema,
  issueTeamInvitationInputSchema,
  revokeTeamInvitationInputSchema,
  teamInvitationResponseSchema,
  teamMembershipResponseSchema,
  teamViewResponseSchema,
  updateTeamMembershipInputSchema,
  type AcceptTeamInvitationInput,
  type AcceptTeamInvitationResult,
  type IssueTeamInvitationInput,
  type RevokeTeamInvitationInput,
  type TeamInvitationDto,
  type TeamMembershipDto,
  type TeamViewDto,
  type UpdateTeamMembershipInput,
} from '@workloom/contracts';
import { ApiError, apiGet, apiRequest, isRecord, prepareMutation, type MutationRequest } from '../../lib/api';
import { isUuid } from '../../lib/format';
import { queryKeys } from '../../lib/queryKeys';
import { ACTOR_HEADER } from '../workspace/workspaceCreationApi';

export const ACCEPT_INVITATION_PATH = '/api/v1/invitations/accept';

function workspaceApiPath(workspaceId: string): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function teamPath(workspaceId: string): string {
  return `${workspaceApiPath(workspaceId)}/team`;
}

/** Under the workspace prefix, so leaving or losing the workspace drops it with everything else. */
export function teamQueryKey(actorId: string, workspaceId: string) {
  return [...queryKeys.workspace(actorId, workspaceId), 'team'] as const;
}

/** Only owner and admin screens read the team; other roles never send this request. */
export async function fetchTeamView(workspaceId: string, signal?: AbortSignal): Promise<TeamViewDto> {
  return (await apiGet(teamPath(workspaceId), teamViewResponseSchema, signal)).data;
}

export type TeamCommandKind = 'issueInvitation' | 'revokeInvitation' | 'updateMembership' | 'acceptInvitation';

/**
 * One team command exactly as it is sent: the parsed body, its Idempotency-Key and the actor (and
 * workspace) it was prepared for. Everything is frozen, so an explicit retry resends the same bytes
 * under the same key. An accept command carries the raw secret: it lives in memory only and must
 * never be logged, persisted or handed to the TanStack mutation cache.
 */
export interface TeamCommand<T> {
  readonly kind: TeamCommandKind;
  readonly request: MutationRequest<{ data: T }>;
  readonly actorId: string;
  /** Null only for accept, which is scoped by the invitation instead. */
  readonly workspaceId: string | null;
  /** The invitation or membership the answer must name; null for accept. */
  readonly targetId: string | null;
  readonly idempotencyKey: string;
}

export function prepareIssueInvitation(
  workspaceId: string,
  input: IssueTeamInvitationInput,
  actorId: string,
  idempotencyKey: string,
): TeamCommand<TeamInvitationDto> {
  requireUuid(actorId);
  requireUuid(workspaceId);
  requireUuid(idempotencyKey);
  const request = prepareMutation({
    method: 'POST',
    path: `${workspaceApiPath(workspaceId)}/invitations`,
    input,
    inputSchema: issueTeamInvitationInputSchema,
    responseSchema: teamInvitationResponseSchema,
  });
  const targetId = (request.body as IssueTeamInvitationInput).id;
  return freezeCommand<TeamInvitationDto>('issueInvitation', request, actorId, workspaceId, targetId, idempotencyKey);
}

export function prepareRevokeInvitation(
  workspaceId: string,
  invitationId: string,
  input: RevokeTeamInvitationInput,
  actorId: string,
  idempotencyKey: string,
): TeamCommand<TeamInvitationDto> {
  requireUuid(actorId);
  requireUuid(workspaceId);
  requireUuid(invitationId);
  requireUuid(idempotencyKey);
  const request = prepareMutation({
    method: 'POST',
    path: `${workspaceApiPath(workspaceId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
    input,
    inputSchema: revokeTeamInvitationInputSchema,
    responseSchema: teamInvitationResponseSchema,
  });
  return freezeCommand<TeamInvitationDto>('revokeInvitation', request, actorId, workspaceId, invitationId, idempotencyKey);
}

/** Changes the role of an active membership or revokes it; there is no restore. */
export function prepareMembershipUpdate(
  workspaceId: string,
  membershipId: string,
  input: UpdateTeamMembershipInput,
  actorId: string,
  idempotencyKey: string,
): TeamCommand<TeamMembershipDto> {
  requireUuid(actorId);
  requireUuid(workspaceId);
  requireUuid(membershipId);
  requireUuid(idempotencyKey);
  const request = prepareMutation({
    method: 'PATCH',
    path: `${workspaceApiPath(workspaceId)}/memberships/${encodeURIComponent(membershipId)}`,
    input,
    inputSchema: updateTeamMembershipInputSchema,
    responseSchema: teamMembershipResponseSchema,
  });
  return freezeCommand<TeamMembershipDto>('updateMembership', request, actorId, workspaceId, membershipId, idempotencyKey);
}

/**
 * Accepting is scoped by the actor only. The body is validated here rather than by
 * `prepareMutation`, whose fingerprint embeds the canonical body: this one names the invitation
 * but never contains the secret.
 */
export function prepareAcceptInvitation(
  input: AcceptTeamInvitationInput,
  actorId: string,
  idempotencyKey: string,
): TeamCommand<AcceptTeamInvitationResult> {
  requireUuid(actorId);
  requireUuid(idempotencyKey);
  const parsed = acceptTeamInvitationInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError({ kind: 'invalid_input', status: null });
  const request: MutationRequest<{ data: AcceptTeamInvitationResult }> = {
    method: 'POST',
    path: ACCEPT_INVITATION_PATH,
    body: parsed.data,
    responseSchema: acceptTeamInvitationResponseSchema,
    fingerprint: `acceptInvitation:${parsed.data.invitationId.toLowerCase()}`,
  };
  return freezeCommand<AcceptTeamInvitationResult>('acceptInvitation', request, actorId, null, null, idempotencyKey);
}

/**
 * Sends a prepared team command once, with the key and actor bound in the frozen command. No other
 * identity or workspace headers are added; the server checks the actor against the session. An
 * answer that does not name the commanded invitation or membership is not a confirmed answer.
 */
export async function sendTeamCommand<T>(command: TeamCommand<T>, signal?: AbortSignal): Promise<T> {
  const { request } = command;
  const { status, payload } = await apiRequest(request.path, {
    method: request.method,
    body: request.body,
    headers: { 'Idempotency-Key': command.idempotencyKey, [ACTOR_HEADER]: command.actorId },
    signal,
  });
  const parsed = request.responseSchema.safeParse(payload);
  if (!parsed.success || !answersCommand(command, parsed.data.data)) throw new ApiError({ kind: 'invalid_response', status });
  return parsed.data.data;
}

function answersCommand(command: TeamCommand<unknown>, data: unknown): boolean {
  if (!isRecord(data)) return false;
  // Accept names no workspace up front: the invitation decides it.
  if (command.workspaceId === null) return true;
  return sameId(data['id'], command.targetId) && (!('workspaceId' in data) || sameId(data['workspaceId'], command.workspaceId));
}

function freezeCommand<T>(
  kind: TeamCommandKind,
  request: MutationRequest<{ data: T }>,
  actorId: string,
  workspaceId: string | null,
  targetId: string | null,
  idempotencyKey: string,
): TeamCommand<T> {
  // Every team body is a flat object of primitives, so a shallow freeze makes it immutable.
  const frozen = Object.freeze({ ...request, body: Object.freeze({ ...(request.body as Record<string, unknown>) }) });
  return Object.freeze({ kind, request: frozen, actorId, workspaceId, targetId, idempotencyKey });
}

function requireUuid(value: string): void {
  if (!isUuid(value)) throw new TypeError('TEAM_COMMAND_INVALID_UUID');
}

function sameId(value: unknown, id: string | null): boolean {
  return typeof value === 'string' && id !== null && value.toLowerCase() === id.toLowerCase();
}

