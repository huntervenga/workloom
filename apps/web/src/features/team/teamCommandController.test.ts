import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MeDto } from '@workloom/contracts';
import { createQueryClient } from '../../lib/queryClient';
import { queryKeys } from '../../lib/queryKeys';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { alpha, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { prepareAcceptInvitation, prepareIssueInvitation } from './teamApi';
import { TeamCommandController } from './teamCommandController';
const actorId = '55555555-5555-4555-8555-555555555555';
const invitationId = '33333333-3333-4333-8333-333333333333';
const key = '77777777-7777-4777-8777-777777777777';
const secret = 'A'.repeat(43);
const membershipId = '88888888-8888-4888-8888-888888888888';
const me: MeDto = { actor: { id: actorId, kind: 'real', displayName: 'Test actor' }, authMode: 'shared' };
const result = { workspaceId: alpha.id, membershipId };
const accept = () => prepareAcceptInvitation({ invitationId, secret }, actorId, key);
const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
function owner() {
  const client = createQueryClient({ retry: false }); clients.push(client); client.setQueryData(queryKeys.me, me);
  const controller = new TeamCommandController(client, actorId), success = vi.fn();
  const detach = controller.attach(success);
  return { client, controller, success, detach };
}
describe('actor-bound Team commands', () => {
  it('sends accept once without a workspace guard and holds exact immutable bytes/key until explicit unknown retry', async () => {
    let attempts = 0;
    const api = installFakeApi({ 'POST /api/v1/invitations/accept': () => ++attempts === 1 ? failure(503, 'UNAVAILABLE', 'private backend text') : ok(result) });
    const { client, controller, success } = owner();
    const command = accept();
    expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(command.request.body)).toBe(true);
    expect(command.request.fingerprint.includes(secret)).toBe(false);
    expect(controller.execute(command)).toBe(true);
    expect(controller.execute(accept())).toBe(false);
    expect(protectedCommandsFor(client).protecting).toBe(true);
    await waitFor(() => expect(controller.getSnapshot().phase).toBe('uncertain'));
    expect(api.calls).toHaveLength(1); expect(JSON.stringify(controller.getSnapshot()).includes(secret)).toBe(false);
    expect(success).not.toHaveBeenCalled();
    expect(controller.retry()).toBe(true);
    await waitFor(() => expect(success).toHaveBeenCalledOnce());
    expect(api.calls).toHaveLength(2);
    expect(api.calls.map(call => call.body)).toEqual([{ invitationId, secret }, { invitationId, secret }]);
    for (const call of api.calls) { expect(call.headers.get('Idempotency-Key')).toBe(key); expect(call.headers.get('X-Workloom-Actor-ID')).toBe(actorId); }
    expect(protectedCommandsFor(client).protecting).toBe(false); expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it('does not publish an answer after the confirmed actor changes and refuses its retry', async () => {
    const pending = deferred<Response>(); const api = installFakeApi({ 'POST /api/v1/invitations/accept': () => pending.promise });
    const { client, controller, success } = owner(); controller.execute(accept());
    await waitFor(() => expect(api.calls).toHaveLength(1));
    client.setQueryData(queryKeys.me, { ...me, actor: { ...me.actor, id: '66666666-6666-4666-8666-666666666666' } });
    pending.resolve(ok(result));
    await waitFor(() => expect(controller.getSnapshot().phase).toBe('uncertain'));
    expect(success).not.toHaveBeenCalled(); expect(controller.retry()).toBe(false); expect(api.calls).toHaveLength(1);
  });
  it('ignores detached owner results even when another owner attaches to that controller', async () => {
    const pending = deferred<Response>(); const api = installFakeApi({ 'POST /api/v1/invitations/accept': () => pending.promise });
    const { controller, success, detach } = owner(); controller.execute(accept());
    await waitFor(() => expect(api.calls).toHaveLength(1)); detach(); const nextSuccess = vi.fn(); controller.attach(nextSuccess);
    pending.resolve(ok(result)); await pending.promise;
    await waitFor(() => expect(controller.getSnapshot().phase).toBe('uncertain'));
    expect(success).not.toHaveBeenCalled(); expect(nextSuccess).not.toHaveBeenCalled(); expect(controller.getSnapshot().result).toBeNull();
  });
  it('returns to idle after confirmed rejection and never auto retries it', async () => {
    const api = installFakeApi({ 'POST /api/v1/invitations/accept': () => failure(409, 'CONFLICT', 'do not show') });
    const { controller, success } = owner(); controller.execute(accept());
    await waitFor(() => expect(controller.getSnapshot().phase).toBe('idle'));
    expect(controller.getSnapshot().error).not.toBeNull(); expect(controller.retry()).toBe(false); expect(api.calls).toHaveLength(1); expect(success).not.toHaveBeenCalled();
  });
  it('blocks workspace commands until current owner/admin access is confirmed', () => {
    installFakeApi({}); const { client, controller } = owner();
    const command = prepareIssueInvitation(alpha.id, { id: invitationId, hashVersion: 1, secretHash: 'a'.repeat(64), role: 'member', expiresInSeconds: 86400 }, actorId, key);
    expect(controller.execute(command)).toBe(false);
    client.setQueryData(queryKeys.workspace(actorId, alpha.id), { ...alpha, role: 'viewer' }); expect(controller.execute(command)).toBe(false);
  });
  it('releases its guard before success callback and never retries a confirmed ACK when UI publication fails', async () => {
    installFakeApi({ 'POST /api/v1/invitations/accept': () => ok(result) });
    const { client, controller } = owner(); controller.attach(() => { expect(protectedCommandsFor(client).protecting).toBe(false); throw new Error('UI publication failed'); });
    controller.execute(accept()); await waitFor(() => expect(controller.getSnapshot().error?.message).toBe('UI publication failed'));
    expect(controller.getSnapshot().phase).toBe('idle'); expect(controller.retry()).toBe(false); expect(controller.getSnapshot().result).toEqual(result);
  });
});
