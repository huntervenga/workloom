import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { projectImportAppliedSchema, projectImportMappingSchema, projectImportPreviewSchema, projectImportReconciliationSchema, projectImportSchema, taskFieldDefinitionSchema, type ProjectImportDto, type ProjectImportMapping, type PreviewProjectImportInput } from '@workloom/contracts';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUuid } from '../../lib/format';
import { createQueryClient } from '../../lib/queryClient';
import { alpha, anna, created, deferred, failure, installFakeApi, ok, project, type FakeRequest, type RouteTable } from '../../test/fakeApi';
import { PROJECT_ID, rootPath, STAMP } from '../planning/test/fixtures';
import { buildImportMapping, formFromMapping } from './mapping';
import type { CsvFileSource } from './file';
import { useImportWorkspace, type ImportDraft, type ImportWorkspace } from './useImportWorkspace';

// Actual page-lived controller, mutation hooks and QueryClient; only fetch/file bytes are synthetic.
const clients: QueryClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.clear(); });
const A = 'a9000000-0000-4000-8000-000000000001', B = 'a9000000-0000-4000-8000-000000000002';
const STATUS = 'a9000000-0000-4000-8000-000000000003', FIELD = 'a9000000-0000-4000-8000-000000000004';
const path = `${rootPath}/projects/${PROJECT_ID}/imports`;
function source(id = A, status: 'staged' | 'applied' = 'staged', revision = 1): ProjectImportDto {
  return projectImportSchema.parse({ id, workspaceId: alpha.id, projectId: PROJECT_ID, sourceNamespace: 'asana:test', fileName: id === A ? 'a.csv' : 'b.csv', fileDigest: (id === A ? 'a' : 'b').repeat(64), revision, status, headers: ['ID', 'Name', 'HoursFact'], sourceRows: [{ rowNumber: 1, cells: ['900719925474099312345', id === A ? 'Source A' : 'Source B', '2.5'] }], createdAt: STAMP, appliedAt: status === 'applied' ? STAMP : null });
}
const map = projectImportMappingSchema.parse({ externalIdColumn: 0, titleColumn: 1, defaultStatusId: STATUS, dateFormat: 'iso', shareableScopeConfirmed: true, people: [], statuses: [], sections: [], tags: [], customFields: [], preserveColumns: [2] });
function field(revision = 1) { return taskFieldDefinitionSchema.parse({ id: FIELD, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'HoursFact · Asana snapshot', type: 'duration', revision, definitionVersionId: `a9000000-0000-4000-8000-${String(10 + revision).padStart(12, '0')}`, historyEnabled: true, locked: false, archivedAt: null, options: [], createdAt: STAMP, updatedAt: STAMP }); }
function timeMap(): ProjectImportMapping { return projectImportMappingSchema.parse({ ...map, preserveColumns: [], customFields: [{ column: 2, fieldId: FIELD, expectedDefinitionRevision: 1, empty: 'missing', sourceMeaning: 'current_actual', sourceUnit: 'hours' }] }); }
function review(s: ProjectImportDto, input: PreviewProjectImportInput) {
  return projectImportPreviewSchema.parse({ importId: s.id, projectId: PROJECT_ID, importRevision: input.expectedImportRevision, sourceDigest: s.fileDigest, previewHash: (input.mapping.customFields[0]?.expectedDefinitionRevision === 2 ? 'd' : 'c').repeat(64), rows: [{ rowNumber: 1, externalId: s.sourceRows[0]?.cells[0], targetTaskId: null, action: 'create', title: s.sourceRows[0]?.cells[1], parentExternalId: null, customValues: input.mapping.customFields.map(choice => ({ fieldId: choice.fieldId, value: { type: 'duration', value: 150 }, sourceMeaning: choice.sourceMeaning, sourceUnit: choice.sourceUnit })) }], issues: [], summary: { sourceRows: 1, createCount: 1, skipCount: 0, conflictCount: 0, blockedCount: 0, preservedColumnCount: input.mapping.preserveColumns.length }, recoveryPeriodIds: [] });
}
function recon(s: ProjectImportDto, mapping = map) { return projectImportReconciliationSchema.parse(s.status === 'staged' ? { status: 'staged', importId: s.id, projectId: PROJECT_ID, sourceRows: 1, createdCount: 0, skippedCount: 0, rows: [], appliedAt: null } : { status: 'applied', importId: s.id, projectId: PROJECT_ID, sourceRows: 1, createdCount: 0, skippedCount: 1, rows: [{ rowNumber: 1, externalId: '900719925474099312345', targetTaskId: 'a9000000-0000-4000-8000-000000000099', state: 'skipped', ownedRevisions: { taskRevision: 1, participantsRevision: 1, workPackageRevision: 1, fields: [] } }], appliedAt: STAMP, sourceDigest: s.fileDigest, mappingHash: 'e'.repeat(64), mapping }); }
function applied(s = source(), mapping = map) { const current = { ...s, status: 'applied' as const, revision: 2, appliedAt: STAMP }; return projectImportAppliedSchema.parse({ import: current, reconciliation: recon(current, mapping), tasks: [], asOfChangeSeq: '2' }); }
function file(name = 'a.csv'): CsvFileSource {
  const bytes = new TextEncoder().encode('\ufeffID,Name,HoursFact\r\n900719925474099312345,Source A,2.5\r\n');
  return { name, size: bytes.byteLength, arrayBuffer: async () => { const result = new ArrayBuffer(bytes.byteLength); new Uint8Array(result).set(bytes); return result; } };
}
function api(extra: RouteTable = {}) { return installFakeApi({
  [`POST ${path}`]: () => created(source()), [`POST ${path}/${A}/preview`]: request => ok(review(source(), request.body as PreviewProjectImportInput)), [`POST ${path}/${B}/preview`]: request => ok(review(source(B), request.body as PreviewProjectImportInput)),
  [`GET ${path}/${A}`]: () => ok(source()), [`GET ${path}/${B}`]: () => ok(source(B)), [`GET ${path}/${A}/reconciliation`]: () => ok(recon(source())), [`GET ${path}/${B}/reconciliation`]: () => ok(recon(source(B))),
  [`GET ${rootPath}`]: () => ok(alpha), [`GET ${rootPath}/projects/${PROJECT_ID}`]: () => ok(project(alpha.id, PROJECT_ID, 'Import project')), ...extra,
}); }
function controller(selected = A) {
  const client = createQueryClient({ retry: false }); clients.push(client);
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const onSelect = vi.fn();
  return { ...renderHook(({ selectedId }) => useImportWorkspace(anna.id, alpha.id, PROJECT_ID, selectedId, onSelect), { initialProps: { selectedId: selected }, wrapper: Wrapper }), client, onSelect };
}
function draft(c: ImportWorkspace, id = A): ImportDraft { const result = c.drafts[id]; if (!result) throw new Error('Expected retained draft'); return result; }
function ready(c: ImportWorkspace, s = source(), mapping = map) { c.ensureDraft(s); return { s, mapping }; }
function configure(c: ImportWorkspace, id = A, mapping = map) { c.change(id, formFromMapping(mapping)); }
function exactRetry(calls: FakeRequest[], url: string, input: unknown) {
  const writes = calls.filter(call => call.path === url && call.method === 'POST'); expect(writes).toHaveLength(2);
  const key = writes[0]?.headers.get('Idempotency-Key') ?? ''; expect(isUuid(key)).toBe(true);
  for (const write of writes) { expect(write.headers.get('Idempotency-Key')).toBe(key); expect(write.body).toEqual(input); }
}

describe('import page command boundaries', () => {
  it('keeps uncertain staged file/namespace immutable and its late retry cannot replace another selected artifact', async () => {
    const lose = deferred<undefined>(); let sends = 0;
    const { calls } = api({ [`POST ${path}`]: async request => { if (++sends === 1) { await lose.promise; throw new TypeError('Failed to fetch'); } return created({ ...source(), sourceNamespace: (request.body as { sourceNamespace: string }).sourceNamespace }); } });
    const view = controller('');
    await act(async () => { await view.result.current.chooseFile(file()); });
    act(() => view.result.current.setNamespace('asana:original'));
    act(() => view.result.current.stage());
    await waitFor(() => expect(calls.filter(call => call.path === path)).toHaveLength(1));
    const input = calls.find(call => call.path === path)?.body;
    view.rerender({ selectedId: B });
    act(() => { ready(view.result.current, source(B)); });
    act(() => configure(view.result.current, B));
    act(() => view.result.current.change(B, { ...draft(view.result.current, B).form, dateFormat: 'us' }));
    await act(async () => { await view.result.current.chooseFile(file('b.csv')); });
    act(() => { view.result.current.setNamespace('asana:replacement'); view.result.current.clearUpload(); });
    expect(view.result.current.upload.file?.fileName).toBe('a.csv'); expect(view.result.current.upload.namespace).toBe('asana:original');
    await act(async () => { lose.resolve(undefined); });
    await waitFor(() => expect(view.result.current.commands.stage.uncertain).not.toBeNull());
    act(() => view.result.current.commands.stage.retryUncertain());
    await waitFor(() => expect(view.result.current.commands.stage.uncertain).toBeNull());
    expect(view.onSelect).not.toHaveBeenCalled(); expect(draft(view.result.current, B).form.dateFormat).toBe('us');
    exactRetry(calls, path, input);
  });

  it('retries held applyA exactly and marks only its original mapping clean while typed B survives', async () => {
    const lose = deferred<undefined>(); let sends = 0;
    const { calls } = api({ [`POST ${path}/${A}/apply`]: async request => { if (++sends === 1) { await lose.promise; throw new TypeError('Failed to fetch'); } return ok(applied(source(), (request.body as { mapping: ProjectImportMapping }).mapping)); } });
    const view = controller();
    act(() => { ready(view.result.current); ready(view.result.current, source(B)); });
    act(() => { configure(view.result.current); configure(view.result.current, B); });
    await act(async () => { await view.result.current.preview(draft(view.result.current), []); });
    act(() => view.result.current.apply(draft(view.result.current), []));
    await waitFor(() => expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1));
    const original = calls.find(call => call.path.endsWith('/apply'))?.body;
    view.rerender({ selectedId: B });
    act(() => { view.result.current.change(B, { ...draft(view.result.current, B).form, dateFormat: 'us' }); view.result.current.change(A, { ...draft(view.result.current).form, dateFormat: 'us' }); });
    expect(draft(view.result.current).form.dateFormat).toBe('iso');
    await act(async () => { lose.resolve(undefined); });
    await waitFor(() => expect(view.result.current.commands.apply.uncertain?.variables.importId).toBe(A));
    await act(async () => { await view.result.current.preview(draft(view.result.current, B), []); });
    act(() => view.result.current.apply(draft(view.result.current, B), []));
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    act(() => view.result.current.commands.apply.retryUncertain());
    await waitFor(() => expect(draft(view.result.current).source.status).toBe('applied'));
    expect(JSON.stringify(draft(view.result.current).form)).toBe(draft(view.result.current).baseForm);
    expect(draft(view.result.current, B).form.dateFormat).toBe('us');
    expect(JSON.stringify(draft(view.result.current, B).form)).not.toBe(draft(view.result.current, B).baseForm);
    exactRetry(calls, `${path}/${A}/apply`, original);
  });

  it('preserves chosen source units on explicit stale rebase and obtains a new preview with fresh field revisions', async () => {
    let sends = 0;
    const { calls } = api({ [`POST ${path}/${A}/apply`]: request => ++sends === 1 ? failure(409, 'PREVIEW_STALE', 'Field catalog changed') : ok(applied(source(), (request.body as { mapping: ProjectImportMapping }).mapping)) });
    const view = controller(); const originalMap = timeMap();
    act(() => { ready(view.result.current); }); act(() => configure(view.result.current, A, originalMap));
    await act(async () => { await view.result.current.preview(draft(view.result.current), [field()]); });
    act(() => view.result.current.apply(draft(view.result.current), [field()]));
    await waitFor(() => expect(view.result.current.commands.apply.error).not.toBeNull());
    expect(view.result.current.applyHeld).toBeNull();
    const refresh = vi.fn(async () => true);
    await act(async () => { await view.result.current.rebase(draft(view.result.current), refresh); });
    expect(refresh).toHaveBeenCalledOnce(); expect(draft(view.result.current).preview).toBeNull();
    expect(draft(view.result.current).form.customFields[0]).toMatchObject({ fieldId: FIELD, sourceMeaning: 'current_actual', sourceUnit: 'hours' });
    act(() => view.result.current.apply(draft(view.result.current), [field(2)]));
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(1);
    await act(async () => { await view.result.current.preview(draft(view.result.current), [field(2)]); });
    act(() => view.result.current.apply(draft(view.result.current), [field(2)]));
    await waitFor(() => expect(draft(view.result.current).source.status).toBe('applied'));
    const writes = calls.filter(call => call.path.endsWith('/apply'));
    expect(writes[1]?.body).toMatchObject({ expectedImportRevision: 1, previewHash: 'd'.repeat(64), mapping: { customFields: [{ fieldId: FIELD, expectedDefinitionRevision: 2, sourceMeaning: 'current_actual', sourceUnit: 'hours' }] } });
    expect(writes[1]?.headers.get('Idempotency-Key')).not.toBe(writes[0]?.headers.get('Idempotency-Key'));
  });

  it('ignores a late preview whose mapping was changed while the response was pending', async () => {
    const result = deferred<Response>(); let sent: PreviewProjectImportInput | undefined;
    api({ [`POST ${path}/${A}/preview`]: request => { sent = request.body as PreviewProjectImportInput; return result.promise; } });
    const view = controller(); act(() => { ready(view.result.current); }); act(() => configure(view.result.current));
    let request: Promise<void> | undefined;
    act(() => { request = view.result.current.preview(draft(view.result.current), []); });
    act(() => view.result.current.change(A, { ...draft(view.result.current).form, dateFormat: 'us' }));
    await act(async () => { if (!sent) throw new Error('Expected sent preview'); result.resolve(ok(review(source(), sent))); await request; });
    expect(draft(view.result.current).preview).toBeNull(); expect(draft(view.result.current).form.dateFormat).toBe('us');
  });

  it('keeps denial latched until current owner access and every retained source/reconciliation read succeeds', async () => {
    const state = { bDenied: true, role: 'owner' as 'owner' | 'member' };
    const { calls } = api({ [`POST ${path}/${A}/preview`]: () => failure(403, 'CAPABILITY_REQUIRED', 'Denied'), [`GET ${path}/${B}/reconciliation`]: () => state.bDenied ? failure(403, 'CAPABILITY_REQUIRED', 'Other source denied') : ok(recon(source(B))), [`GET ${rootPath}`]: () => ok({ ...alpha, role: state.role }) });
    const view = controller(); act(() => { ready(view.result.current); ready(view.result.current, source(B)); }); act(() => { configure(view.result.current); configure(view.result.current, B); });
    await act(async () => { await view.result.current.preview(draft(view.result.current), []); });
    expect(view.result.current.denied).toBe(true);
    await act(async () => { await view.result.current.recoverAccess(async () => true); });
    expect(view.result.current.denied).toBe(true);
    state.bDenied = false; state.role = 'member';
    await act(async () => { await view.result.current.recoverAccess(async () => true); });
    expect(view.result.current.denied).toBe(true);
    state.role = 'owner';
    await act(async () => { await view.result.current.recoverAccess(async () => true); });
    expect(view.result.current.denied).toBe(false);
    expect(draft(view.result.current).form.shareableScopeConfirmed).toBe(true);
    expect(calls.filter(call => call.path.endsWith('/apply'))).toHaveLength(0);
    expect(calls.filter(call => call.path === `${path}/${B}/reconciliation`)).toHaveLength(2);
  });

  it('does not alter a held apply payload during a requested stale rebase', async () => {
    const result = deferred<Response>(); const refresh = vi.fn(async () => true);
    const { calls } = api({ [`POST ${path}/${A}/apply`]: () => result.promise });
    const view = controller(); act(() => { ready(view.result.current); }); act(() => configure(view.result.current));
    await act(async () => { await view.result.current.preview(draft(view.result.current), []); });
    act(() => view.result.current.apply(draft(view.result.current), []));
    await waitFor(() => expect(view.result.current.applyHeld).not.toBeNull());
    const held = view.result.current.applyHeld;
    await act(async () => { await view.result.current.rebase(draft(view.result.current), refresh); });
    expect(refresh).not.toHaveBeenCalled(); expect(view.result.current.applyHeld).toEqual(held);
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(0);
    await act(async () => { result.resolve(ok(applied())); });
    await waitFor(() => expect(view.result.current.applyHeld).toBeNull());
    const normalized = buildImportMapping(draft(view.result.current).source, draft(view.result.current).form, []);
    expect(normalized?.shareableScopeConfirmed).toBe(true);
  });
});
