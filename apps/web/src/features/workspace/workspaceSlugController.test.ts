import { afterEach, describe, expect, it } from 'vitest';
import type { ActorDto, WorkspaceDto } from '@workloom/contracts';
import { createQueryClient } from '../../lib/queryClient';
import { protectedCommandsFor } from '../../lib/protectedCommands';
import { queryKeys } from '../../lib/queryKeys';
import { deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { WorkspaceSlugController } from './workspaceSlugController';

const actor: ActorDto = { id: '55555555-5555-4555-8555-555555555555', displayName: 'Owner', kind: 'real' };
const workspace: WorkspaceDto = { id: 'e25f76fe-efdc-4062-9326-2ad44733dd04', name: 'Balancy', role: 'owner', timezone: 'UTC', slug: null, slugRevision: 1, slugAliases: [] };
const path = `/api/v1/workspaces/${workspace.id}/slug`;
const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
function setup(role: WorkspaceDto['role'] = 'owner') {
  const client = createQueryClient({ retry: false }); clients.push(client);
  client.setQueryData(queryKeys.me, { actor, authMode: 'shared' });
  client.setQueryData(queryKeys.workspace(actor.id, workspace.id), { ...workspace, role });
  client.setQueryData(queryKeys.workspaces(actor.id), [workspace]);
  const controller = new WorkspaceSlugController(client, actor.id, workspace.id); controller.activate();
  return { client, controller };
}

describe('company address command', () => {
  it('uses UUID endpoint, normalizes input, pins revision/actor/key and updates both actor caches', async () => {
    const next = { ...workspace, slug: 'balancy', slugRevision: 2 };
    const api = installFakeApi({ [`PATCH ${path}`]: () => ok(next) });
    const { controller, client } = setup();
    await controller.save(' BALANCY ', 1);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.body).toEqual({ slug: 'balancy', expectedSlugRevision: 1 });
    expect(api.calls[0]?.headers.get('X-Workloom-Actor-ID')).toBe(actor.id);
    expect(api.calls[0]?.headers.get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/);
    expect(client.getQueryData(queryKeys.workspace(actor.id, workspace.id))).toEqual(next);
    expect(client.getQueryData(queryKeys.workspaces(actor.id))).toEqual([next]);
    expect(protectedCommandsFor(client).protecting).toBe(false);
    controller.dispose();
  });
  it('freezes an uncertain request and sends it again only on explicit retry', async () => {
    let count = 0;
    const api = installFakeApi({ [`PATCH ${path}`]: () => ++count === 1 ? failure(503, 'TEMPORARILY_UNAVAILABLE', 'hidden') : ok({ ...workspace, slug: 'balancy', slugRevision: 2 }) });
    const { controller, client } = setup();
    await controller.save('balancy', 1);
    expect(controller.getSnapshot().phase).toBe('uncertain');
    expect(protectedCommandsFor(client).protecting).toBe(true);
    await controller.save('another-name', 2);
    expect(api.calls).toHaveLength(1);
    await controller.retry();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[1]?.body).toEqual(api.calls[0]?.body);
    expect(api.calls[1]?.headers.get('Idempotency-Key')).toBe(api.calls[0]?.headers.get('Idempotency-Key'));
    expect(controller.getSnapshot().phase).toBe('editing');
    controller.dispose();
  });
  it('does not send for another actor or non-owner, or publish a late answer after account changes', async () => {
    const answer = deferred<Response>();
    const api = installFakeApi({ [`PATCH ${path}`]: () => answer.promise });
    const { controller, client } = setup('admin');
    await controller.save('balancy', 1); expect(api.calls).toHaveLength(0);
    client.setQueryData(queryKeys.workspace(actor.id, workspace.id), workspace);
    const saving = controller.save('balancy', 1);
    client.setQueryData(queryKeys.me, { actor: { ...actor, id: '66666666-6666-4666-8666-666666666666' }, authMode: 'shared' });
    answer.resolve(ok({ ...workspace, slug: 'balancy', slugRevision: 2 })); await saving;
    expect(client.getQueryData(queryKeys.workspace(actor.id, workspace.id))).toEqual(workspace);
    expect(controller.getSnapshot().phase).toBe('uncertain');
    controller.dispose();
  });
  it('keeps confirmed conflicts editable and never overwrites a newer revision with an old replay', async () => {
    const api = installFakeApi({ [`PATCH ${path}`]: () => failure(409, 'CONFLICT', 'hidden') });
    const { controller, client } = setup();
    await controller.save('balancy', 1);
    expect(controller.getSnapshot().phase).toBe('editing');
    expect(protectedCommandsFor(client).protecting).toBe(false);
    expect(api.calls).toHaveLength(1);
    installFakeApi({ [`PATCH ${path}`]: () => ok({ ...workspace, slug: 'balancy', slugRevision: 2 }) });
    const newer = { ...workspace, slug: 'balancy-team', slugRevision: 3, slugAliases: ['balancy'] };
    client.setQueryData(queryKeys.workspace(actor.id, workspace.id), newer);
    await controller.save('balancy', 1);
    expect(client.getQueryData(queryKeys.workspace(actor.id, workspace.id))).toEqual(newer);
    controller.dispose();
  });
});
