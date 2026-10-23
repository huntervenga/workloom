import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { alpha, anna, deferred, failure, installFakeApi, ok } from '../../test/fakeApi';
import { queryKeys } from '../../lib/queryKeys';
import { renderFieldUi } from '../fields/test/fixtures';
import { WorkspaceNavigationProvider } from '../workspace/WorkspaceNavigation';
import { AsanaImportButton } from './AsanaImportButton';
import { asanaImportPath, fileBase64, MAX_ASANA_FILE_BYTES } from './api';

const base = asanaImportPath(alpha.id);
const uploadId = '91000000-0000-4000-8000-000000000001';
const projectId = '92000000-0000-4000-8000-000000000001';
const preview = { projectName: 'Delivery week', tasks: 8, roots: 6, subtasks: 2, sections: 3, createTasks: 7, reuseTasks: 1, completed: 4, fields: [{ name: 'Hours Estimation', type: 'duration' }], warnings: ['source_history', 'milestones_as_tasks:2', 'external_dependencies:3', 'linked_fields', 'unknown-provider-message-do-not-render'] };
const result = { projectId, reportId: null, taskCount: 8, createdTasks: 7, reusedTasks: 1 };
function rawFile(name: string, bytes = name.endsWith('.csv') ? new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('Task ID,Name')]) : new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])) {
  const file = new File([bytes], name, { type: name.endsWith('.json') ? 'application/json' : 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', { value: vi.fn(async () => bytes.slice().buffer), configurable: true });
  return file;
}
function renderImport(isOwner = true) {
  const view = renderFieldUi(<MemoryRouter basename="/app" initialEntries={['/app/w/balancy/projects']}><WorkspaceNavigationProvider actorId={anna.id}><AsanaImportButton actorId={anna.id} workspaceId={alpha.id} isOwner={isOwner} /></WorkspaceNavigationProvider></MemoryRouter>);
  view.client.setQueryData(queryKeys.me, { actor: anna });
  return view;
}
function routes() { return { [`GET ${base}`]: () => ok({ enabled: true }), 'GET /api/v1/workspaces': () => ok([{ ...alpha, slug: 'balancy' }]) }; }
async function choose(view: ReturnType<typeof renderImport>) {
  await view.user.click(await screen.findByRole('button', { name: 'Import from Asana' }));
  await view.user.upload(screen.getByLabelText('Asana JSON export'), rawFile('project.json'));
  await view.user.upload(screen.getByLabelText('Asana CSV export'), rawFile('project.csv', new TextEncoder().encode('Name\nПривет')));
}

describe('local Asana upload', () => {
  it('never probes capability for a non-owner', async () => {
    const api = installFakeApi(routes()); const view = renderImport(false);
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(api.calls.filter(call => call.path === base)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Import from Asana' })).not.toBeInTheDocument();
  });
  it.each([401, 403, 404])('silently hides the button on capability %s without retry', async status => {
    const api = installFakeApi({ ...routes(), [`GET ${base}`]: () => failure(status, 'NOT_FOUND', 'secret raw message') });
    const view = renderImport();
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(api.calls.filter(call => call.path === base)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Import from Asana' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('requires two files, uploads exact bytes only on Check and supports an explicit preview retry', async () => {
    let attempt = 0;
    const api = installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ++attempt === 1 ? failure(422, 'ASANA_IMPORT_INVALID_FILES', '/private/raw-source-path') : ok({ uploadId, preview }) });
    const view = renderImport();
    await view.user.click(await screen.findByRole('button', { name: 'Import from Asana' }));
    expect(screen.getByRole('button', { name: 'Check files' })).toBeDisabled();
    await view.user.upload(screen.getByLabelText('Asana JSON export'), rawFile('project.json'));
    expect(screen.getByRole('button', { name: 'Check files' })).toBeDisabled();
    await view.user.upload(screen.getByLabelText('Asana CSV export'), rawFile('project.csv', new TextEncoder().encode('Name\nПривет')));
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('matching Asana exports');
    expect(screen.queryByText('/private/raw-source-path')).not.toBeInTheDocument();
    expect((screen.getByLabelText('Asana JSON export') as HTMLInputElement).files?.[0]?.name).toBe('project.json');
    await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    expect(await screen.findByRole('heading', { name: 'Delivery week' })).toBeInTheDocument();
    const writes = api.calls.filter(call => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[1]?.body).toEqual({ jsonBase64: '77u/e30=', csvBase64: btoa(String.fromCharCode(...new TextEncoder().encode('Name\nПривет'))), preserveMilestones: false, preserveExternalDependencies: false });
    expect(writes[1]?.credentials).toBe('same-origin');
    expect(writes[1]?.headers.get('X-Workloom-Actor-ID')).toBe(anna.id);
    expect(writes[1]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('applies reviewed upload, invalidates projects and offers a slug-aware link', async () => {
    const api = installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ok({ uploadId, preview }), [`POST ${base}/${uploadId}/apply`]: () => ok(result) });
    const view = renderImport(); const invalidate = vi.spyOn(view.client, 'invalidateQueries');
    await choose(view); await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    await view.user.click(await screen.findByRole('button', { name: 'Import project' }));
    expect(await screen.findByRole('link', { name: 'Open project' })).toHaveAttribute('href', `/app/w/balancy/projects/${projectId}`);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectList(anna.id, alpha.id), exact: true });
    const apply = api.calls.find(call => call.path.endsWith('/apply'));
    expect(apply?.body).toEqual({}); expect(apply?.headers.get('X-Workloom-Actor-ID')).toBe(anna.id);
  });
  it.each([false, true])('starts another project after a known result (existing=%s)', async existing => {
    const api = installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ok({ uploadId, preview: { ...preview, ...(existing ? { existingProjectId: projectId } : {}) } }), [`POST ${base}/${uploadId}/apply`]: () => ok(result) });
    const view = renderImport(); await choose(view);
    await view.user.click(screen.getByText('Advanced import options'));
    await view.user.click(screen.getByRole('checkbox', { name: 'Import milestones as ordinary tasks' }));
    await view.user.click(screen.getByRole('checkbox', { name: 'Keep unresolved external dependencies as source metadata' }));
    await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    if (!existing) await view.user.click(await screen.findByRole('button', { name: 'Import project' }));
    expect(await screen.findByRole('link', { name: 'Open project' })).toBeInTheDocument();
    expect(screen.getByText(/Milestones imported as ordinary tasks: 2/)).toBeInTheDocument();
    expect(screen.getByText(/External dependency labels kept as source metadata: 3/)).toBeInTheDocument();
    expect(screen.getByText(/additional warning/)).toBeInTheDocument();
    expect(screen.queryByText('unknown-provider-message-do-not-render')).not.toBeInTheDocument();
    expect(screen.queryByText('source_history')).not.toBeInTheDocument();
    const posts = api.calls.filter(call => call.method === 'POST').length;
    await view.user.click(screen.getByRole('button', { name: 'Import another project' }));
    expect((screen.getByLabelText('Asana JSON export') as HTMLInputElement).files).toHaveLength(0);
    expect((screen.getByLabelText('Asana CSV export') as HTMLInputElement).files).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Check files' })).toBeDisabled();
    await view.user.click(screen.getByText('Advanced import options'));
    expect(screen.getByRole('checkbox', { name: 'Import milestones as ordinary tasks' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Keep unresolved external dependencies as source metadata' })).not.toBeChecked();
    expect(screen.queryByRole('link', { name: 'Open project' })).not.toBeInTheDocument();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(posts);
  });
  it('keeps the same upload and Idempotency-Key after an unknown apply, including close/reopen', async () => {
    let attempts = 0;
    const api = installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ok({ uploadId, preview }), [`POST ${base}/${uploadId}/apply`]: () => { if (++attempts === 1) throw new TypeError('connection lost'); return ok(result); } });
    const view = renderImport(); await choose(view); await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    await view.user.click(await screen.findByRole('button', { name: 'Import project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('may have finished');
    expect(screen.queryByRole('button', { name: 'Change files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import another project' })).not.toBeInTheDocument();
    await view.user.keyboard('{Escape}');
    await view.user.click(screen.getByRole('button', { name: 'Import from Asana' }));
    await view.user.click(screen.getByRole('button', { name: 'Retry the same import' }));
    expect(await screen.findByRole('link', { name: 'Open project' })).toBeInTheDocument();
    const applies = api.calls.filter(call => call.path.endsWith('/apply'));
    expect(applies).toHaveLength(2); expect(applies[1]?.headers.get('Idempotency-Key')).toBe(applies[0]?.headers.get('Idempotency-Key'));
    expect(api.calls.filter(call => call.path.endsWith('/preview'))).toHaveLength(1);
  });
  it('offers the existing project without a second import', async () => {
    const api = installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ok({ uploadId, preview: { ...preview, existingProjectId: projectId } }) });
    const view = renderImport(); await choose(view); await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    expect(await screen.findByRole('link', { name: 'Open project' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import project' })).not.toBeInTheDocument();
    expect(api.calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
  });
  it('keeps the dialog visible while the import is pending and ignores repeated clicks', async () => {
    const hold = deferred<Response>();
    const api = installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ok({ uploadId, preview }), [`POST ${base}/${uploadId}/apply`]: () => hold.promise });
    const view = renderImport(); await choose(view); await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    await view.user.click(await screen.findByRole('button', { name: 'Import project' }));
    await view.user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import project' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('closing cannot cancel');
    hold.resolve(ok(result));
    expect(await screen.findByRole('link', { name: 'Open project' })).toBeInTheDocument();
    expect(api.calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
  });
  it('does not upload files if the actor changes while their bytes are being read', async () => {
    const hold = deferred<ArrayBuffer>();
    const api = installFakeApi(routes()); const view = renderImport();
    await view.user.click(await screen.findByRole('button', { name: 'Import from Asana' }));
    const file = rawFile('project.json'); Object.defineProperty(file, 'arrayBuffer', { value: () => hold.promise, configurable: true });
    await view.user.upload(screen.getByLabelText('Asana JSON export'), file);
    await view.user.upload(screen.getByLabelText('Asana CSV export'), rawFile('project.csv'));
    await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    view.client.setQueryData(queryKeys.me, { actor: { ...anna, id: '33333333-3333-4333-8333-333333333333' } });
    hold.resolve(new Uint8Array([123, 125]).buffer);
    expect(await screen.findByRole('alert')).toHaveTextContent('session or workspace permissions changed');
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  });
  it('does not publish an import result or invalidate another actor after an in-flight actor change', async () => {
    const hold = deferred<Response>();
    installFakeApi({ ...routes(), [`POST ${base}/preview`]: () => ok({ uploadId, preview }), [`POST ${base}/${uploadId}/apply`]: () => hold.promise });
    const view = renderImport(); const invalidate = vi.spyOn(view.client, 'invalidateQueries');
    await choose(view); await view.user.click(screen.getByRole('button', { name: 'Check files' }));
    await view.user.click(await screen.findByRole('button', { name: 'Import project' }));
    view.client.setQueryData(queryKeys.me, { actor: { ...anna, id: '33333333-3333-4333-8333-333333333333' } });
    hold.resolve(ok(result));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import project' })).toBeEnabled());
    expect(screen.queryByRole('link', { name: 'Open project' })).not.toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalled();
    await view.user.click(screen.getByRole('button', { name: 'Import project' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('session or workspace permissions changed');
  });
  it('rejects oversized files before reading or uploading them', async () => {
    const api = installFakeApi(routes()); const view = renderImport(); await choose(view);
    const file = rawFile('large.json'); Object.defineProperty(file, 'size', { value: MAX_ASANA_FILE_BYTES + 1 });
    await view.user.upload(screen.getByLabelText('Asana JSON export'), file);
    expect(screen.getByRole('alert')).toHaveTextContent('10 MiB');
    expect(screen.getByRole('button', { name: 'Check files' })).toBeDisabled();
    expect(api.calls.filter(call => call.method === 'POST')).toHaveLength(0);
    await expect(fileBase64(file)).rejects.toMatchObject({ kind: 'invalid_input' });
    expect(file.arrayBuffer).not.toHaveBeenCalled();
  });
});
