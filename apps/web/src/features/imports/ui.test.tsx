import { screen, waitFor, within } from '@testing-library/react';
import type { ProjectImportMapping, PreviewProjectImportInput } from '@workloom/contracts';
import { describe, expect, it } from 'vitest';
import { alpha, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { tablePath, tableRoutes } from '../work-categories/test/fixtures';
import { durationField, FIELD_ID, IMPORT_ID, mapping, preview, PROJECT_ID, rootPath, source, STATUS_ID } from './test/fixtures';

const path = `${rootPath}/projects/${PROJECT_ID}/imports/${IMPORT_ID}`;
describe('project import wizard', () => {
  it('reviews indexed mapping, preserves literal raw cells and reopens confirmed units without creating historical effort', async () => {
    let applied = false; let confirmed = mapping();
    const staged = source();
    const current = () => ({ ...staged, revision: applied ? 2 : 1, status: applied ? 'applied' as const : 'staged' as const, appliedAt: applied ? '2026-10-01T09:00:00.000Z' : null });
    const reconciliation = () => applied ? { status: 'applied', importId: IMPORT_ID, projectId: PROJECT_ID, sourceRows: 2, createdCount: 2, skippedCount: 0, rows: staged.sourceRows.map(row => ({ rowNumber: row.rowNumber, externalId: row.cells[0], targetTaskId: `ab400000-0000-4000-8000-${String(row.rowNumber).padStart(12, '0')}`, state: 'created', ownedRevisions: { taskRevision: 1, participantsRevision: 1, workPackageRevision: 1, fields: [] } })), appliedAt: current().appliedAt, sourceDigest: staged.fileDigest, mappingHash: 'c'.repeat(64), mapping: confirmed } : { status: 'staged', importId: IMPORT_ID, projectId: PROJECT_ID, sourceRows: 2, createdCount: 0, skippedCount: 0, rows: [], appliedAt: null };
    const { calls } = installFakeApi({ ...tableRoutes(),
      [`GET ${rootPath}/fields`]: () => ok([durationField()]),
      [`GET ${rootPath}/projects/${PROJECT_ID}/statuses`]: () => ok([{ id: STATUS_ID, workspaceId: alpha.id, projectId: PROJECT_ID, name: 'В работе', group: 'in_progress', position: 0, revision: 1 }]),
      [`GET ${path}`]: () => ok(current()), [`GET ${path}/reconciliation`]: () => ok(reconciliation()),
      [`POST ${path}/preview`]: request => ok(preview((request.body as PreviewProjectImportInput).mapping)),
      [`POST ${path}/apply`]: request => { confirmed = (request.body as { mapping: ProjectImportMapping }).mapping; applied = true; return ok({ import: current(), reconciliation: reconciliation(), tasks: [], asOfChangeSeq: '2' }); },
    });
    const app = renderApp(`${tablePath}?view=import&import=${IMPORT_ID}`);
    const wizard = await screen.findByRole('region', { name: "Project CSV import" });
    await within(wizard).findByRole('combobox', { name: "External task ID" });
    await app.user.click(within(wizard).getByText("Source data · 2 rows · 4 columns"));
    expect(within(wizard).getByText('=SUM(1,2)')).toBeInTheDocument();
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: "External task ID" }), '0');
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: "Task title" }), '1');
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: "Default status" }), STATUS_ID);
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: "Field for column 3" }), FIELD_ID);
    const coreOption = within(within(wizard).getByRole('combobox', { name: "Description" })).getByRole('option', { name: /3 · Hours/ });
    expect(coreOption).toBeDisabled();
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: "Value meaning" }), 'current_estimate');
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: "Source units" }), 'hours');
    await app.user.click(within(wizard).getByRole('checkbox', { name: /Preserve as source-only: 4/ }));
    await app.user.click(within(wizard).getByRole('checkbox', { name: /I confirm these tasks/ }));
    expect(within(wizard).getByText(/Hours convert to whole minutes without rounding/)).toBeInTheDocument();
    await app.user.click(within(wizard).getByRole('button', { name: "Preview import" }));
    const review = await within(wizard).findByRole('region', { name: "Import preview" });
    expect(within(review).getByText('000900719925474099312345')).toBeInTheDocument();
    expect(within(review).getByText(/90 min/)).toBeInTheDocument();
    expect(within(review).getByText(/: 0 min/)).toBeInTheDocument();
    await app.user.click(within(wizard).getByRole('button', { name: "Apply import" }));
    await within(wizard).findByText("Import applied");
    expect(within(wizard).getAllByRole('button', { name: "Open imported task" })).toHaveLength(2);
    const write = calls.find(call => call.path.endsWith('/apply'));
    expect(write?.body).toEqual({ expectedImportRevision: 1, mapping: mapping(), previewHash: 'b'.repeat(64) });
    expect(calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual([`${path}/preview`, `${path}/apply`]);
    await app.user.click(within(wizard).getByText("Confirmed mapping and source units"));
    expect(within(wizard).getByRole('combobox', { name: "Value meaning" })).toHaveValue('current_estimate');
    expect(within(wizard).getByRole('combobox', { name: "Source units" })).toHaveValue('hours');
    expect(within(wizard).getByRole('combobox', { name: "Source units" })).toBeDisabled();
    await waitFor(() => expect(confirmed).toEqual(mapping()));
    app.unmount(); app.queryClient.clear();
    const reopened = renderApp(`${tablePath}?view=import&import=${IMPORT_ID}`);
    const saved = await screen.findByRole('region', { name: "Project CSV import" });
    await within(saved).findByText("Import applied");
    await reopened.user.click(within(saved).getByText("Confirmed mapping and source units"));
    expect(within(saved).getByRole('combobox', { name: "Value meaning" })).toHaveValue('current_estimate');
    expect(within(saved).getByRole('combobox', { name: "Source units" })).toHaveValue('hours');
    expect(within(saved).queryByRole('button', { name: "Apply import" })).not.toBeInTheDocument();
    reopened.unmount(); reopened.queryClient.clear();
  });
});
