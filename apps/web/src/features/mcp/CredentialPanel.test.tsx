import { act, screen, waitFor, within } from '@testing-library/react';
import type { IssueLocalCredentialInput, LocalCredentialDto } from '@workloom/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok, created, renderApp, singleActorRoutes } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
const path = `/api/v1/workspaces/${alpha.id}/mcp-credentials`;
const route = `/w/${alpha.id}/integrations`;
const stamp = '2026-10-16T06:00:00.000Z';
function metadata(input: IssueLocalCredentialInput): LocalCredentialDto { return { id: input.id, workspaceId: alpha.id, ownerUserId: anna.id, name: input.name, hashVersion: 1, scopes: input.scopes, revision: 1, createdAt: stamp, expiresAt: '2026-10-16T20:00:00.000Z', revokedAt: null }; }
// Deterministic test-only browser crypto; the independent Node-environment vector test uses real SHA256.
beforeEach(() => { vi.stubGlobal('crypto', { randomUUID: () => '10000000-0000-4000-8000-000000000001', getRandomValues: (bytes: Uint8Array) => { bytes.set(Array.from({ length: bytes.length }, (_, index) => index)); return bytes; }, subtle: { digest: async () => Uint8Array.from('95ab16b90eaedb9f791d0a5e5f38fb8e551a58555e039771026539a5181356ac'.match(/../g) ?? [], byte => Number.parseInt(byte, 16)).buffer } }); });
describe('private local MCP credential lifecycle', () => {
  it('reveals only after confirmed metadata, retries exact lost issuance and never places the secret in requests/cache', async () => {
    let sends = 0; const records: LocalCredentialDto[] = [];
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha]),
      [`GET ${path}`]: () => ok({ credentials: records, allowedScopes: ['projects.read', 'tasks.read', 'members.read', 'fields.read'] }),
      [`POST ${path}`]: request => { const input = request.body as IssueLocalCredentialInput; if (++sends === 1) throw new TypeError('Lost response'); const row = metadata(input); records.push(row); return created(row); },
    });
    const app = renderApp(route);
    const panel = await screen.findByRole('region', { name: 'Локальный MCP' });
    await app.user.type(within(panel).getByRole('textbox', { name: 'Название ключа' }), 'Мой помощник');
    await app.user.click(within(panel).getByRole('checkbox', { name: 'Читать и искать задачи' }));
    expect(within(panel).queryByRole('checkbox', { name: 'Создавать задачи' })).not.toBeInTheDocument();
    await app.user.click(within(panel).getByRole('button', { name: 'Выпустить ключ' }));
    await within(panel).findByRole('button', { name: 'Повторить исходный выпуск' });
    expect(within(panel).queryByRole('textbox', { name: 'Секрет ключа' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('textbox', { name: 'Название ключа' })).toBeDisabled();
    await app.user.click(within(panel).getByRole('button', { name: 'Повторить исходный выпуск' }));
    const secret = await within(panel).findByRole('textbox', { name: 'Секрет ключа' });
    const token = (secret as HTMLTextAreaElement).value;
    expect(token).toMatch(/^wlm_local_v1_[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/);
    const writes = calls.filter(call => call.method === 'POST'); expect(writes).toHaveLength(2);
    expect(writes[0]?.body).toEqual(writes[1]?.body); expect(writes[0]?.headers.get('Idempotency-Key')).toBe(writes[1]?.headers.get('Idempotency-Key'));
    expect(writes[0]?.body).toMatchObject({ name: 'Мой помощник', hashVersion: 1, scopes: ['tasks.read'], expiresInSeconds: 3600 });
    const queries = JSON.stringify(app.queryClient.getQueryCache().getAll().map(query => query.state.data));
    const mutations = JSON.stringify(app.queryClient.getMutationCache().getAll().map(mutation => ({ variables: mutation.state.variables, data: mutation.state.data })));
    expect(JSON.stringify(calls)).not.toContain(token); expect(queries).not.toContain(token); expect(mutations).not.toContain(token);
    expect(queries).not.toContain((writes[0]?.body as IssueLocalCredentialInput).secretHash);
    await app.user.click(within(panel).getByRole('button', { name: 'Я сохранил ключ — закрыть показ' }));
    expect(within(panel).queryByRole('textbox', { name: 'Секрет ключа' })).not.toBeInTheDocument();
    app.unmount(); app.queryClient.clear();
    const reloaded = renderApp(route); await screen.findByRole('button', { name: 'Отозвать ключ' });
    expect(screen.queryByRole('textbox', { name: 'Секрет ключа' })).not.toBeInTheDocument();
    reloaded.unmount(); reloaded.queryClient.clear();
  });
  it('hides an already shown secret on current denial and requires successful current reads before recovery', async () => {
    let read = 'ok'; let row: LocalCredentialDto | null = null;
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha]),
      [`GET ${path}`]: () => read === 'denied' ? failure(403, 'CAPABILITY_REQUIRED', 'Denied') : read === 'failed' ? failure(500, 'INTERNAL_ERROR', 'Unavailable') : ok({ credentials: row ? [row] : [], allowedScopes: ['tasks.read'] }),
      [`POST ${path}`]: request => { row = metadata(request.body as IssueLocalCredentialInput); return created(row); },
    });
    const app = renderApp(route); await screen.findByRole('checkbox', { name: 'Читать и искать задачи' });
    await app.user.type(screen.getByRole('textbox', { name: 'Название ключа' }), 'Сохраняемый в памяти'); await app.user.click(screen.getByRole('checkbox', { name: 'Читать и искать задачи' })); await app.user.click(screen.getByRole('button', { name: 'Выпустить ключ' }));
    const shown = await screen.findByRole('textbox', { name: 'Секрет ключа' }); const token = (shown as HTMLTextAreaElement).value;
    read = 'denied'; await act(async () => { await app.queryClient.invalidateQueries({ queryKey: [...queryKeys.workspace(anna.id, alpha.id), 'local-mcp-credentials'] }); });
    await screen.findByRole('button', { name: 'Проверить доступ к ключам' }); expect(screen.queryByRole('textbox', { name: 'Секрет ключа' })).not.toBeInTheDocument();
    read = 'failed'; await app.user.click(screen.getByRole('button', { name: 'Проверить доступ к ключам' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Проверить доступ к ключам' })).toBeEnabled()); expect(screen.queryByRole('textbox', { name: 'Секрет ключа' })).not.toBeInTheDocument();
    read = 'ok'; await app.user.click(screen.getByRole('button', { name: 'Проверить доступ к ключам' }));
    expect((await screen.findByRole('textbox', { name: 'Секрет ключа' }) as HTMLTextAreaElement).value).toBe(token);
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    app.unmount(); app.queryClient.clear();
  });
  it('uses current revision for explicit revoke and retains an uncertain original revoke until exact retry confirms', async () => {
    const input: IssueLocalCredentialInput = { id: 'ad100000-0000-4000-8000-000000000001', name: 'Старый ключ', hashVersion: 1, secretHash: 'a'.repeat(64), scopes: ['tasks.read'], expiresInSeconds: 3600 };
    let row = metadata(input), sends = 0; const pending = deferred<Response>();
    const { calls } = installFakeApi({ ...singleActorRoutes(anna, [alpha]), [`GET ${path}`]: () => ok({ credentials: [row], allowedScopes: ['tasks.read'] }), [`POST ${path}/${row.id}/revoke`]: async () => { if (++sends === 1) { await pending.promise; throw new TypeError('Lost response'); } row = { ...row, revision: 2, revokedAt: stamp }; return ok(row); } });
    const app = renderApp(route); await app.user.click(await screen.findByRole('button', { name: 'Отозвать ключ' }));
    await act(async () => { pending.resolve(ok({})); }); await app.user.click(await screen.findByRole('button', { name: 'Повторить исходный отзыв' }));
    await screen.findByText('Отозван'); const writes = calls.filter(call => call.method === 'POST'); expect(writes).toHaveLength(2); expect(writes[0]?.body).toEqual({ expectedRevision: 1 }); expect(writes[1]?.body).toEqual(writes[0]?.body); expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
    app.unmount(); app.queryClient.clear();
  });
});
