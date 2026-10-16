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
    const wizard = await screen.findByRole('region', { name: 'Импорт CSV проекта' });
    await within(wizard).findByRole('combobox', { name: 'Внешний ID задачи' });
    await app.user.click(within(wizard).getByText('Исходные данные · 2 строк, 4 колонок'));
    expect(within(wizard).getByText('=SUM(1,2)')).toBeInTheDocument();
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: 'Внешний ID задачи' }), '0');
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: 'Название задачи' }), '1');
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: 'Статус по умолчанию' }), STATUS_ID);
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: 'Поле для колонки 3' }), FIELD_ID);
    const coreOption = within(within(wizard).getByRole('combobox', { name: 'Описание' })).getByRole('option', { name: /3 · Hours/ });
    expect(coreOption).toBeDisabled();
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: 'Смысл значения' }), 'current_estimate');
    await app.user.selectOptions(within(wizard).getByRole('combobox', { name: 'Единицы источника' }), 'hours');
    await app.user.click(within(wizard).getByRole('checkbox', { name: /Сохранить только в исходных данных: 4/ }));
    await app.user.click(within(wizard).getByRole('checkbox', { name: /Подтверждаю: эти задачи/ }));
    expect(within(wizard).getByText(/Часы переводятся в целые минуты без округления/)).toBeInTheDocument();
    await app.user.click(within(wizard).getByRole('button', { name: 'Проверить импорт' }));
    const review = await within(wizard).findByRole('region', { name: 'Проверка импорта' });
    expect(within(review).getByText('000900719925474099312345')).toBeInTheDocument();
    expect(within(review).getByText(/90 мин/)).toBeInTheDocument();
    expect(within(review).getByText(/: 0 мин/)).toBeInTheDocument();
    await app.user.click(within(wizard).getByRole('button', { name: 'Применить импорт' }));
    await within(wizard).findByText('Импорт применён');
    expect(within(wizard).getAllByRole('button', { name: 'Открыть импортированную задачу' })).toHaveLength(2);
    const write = calls.find(call => call.path.endsWith('/apply'));
    expect(write?.body).toEqual({ expectedImportRevision: 1, mapping: mapping(), previewHash: 'b'.repeat(64) });
    expect(calls.filter(call => call.method !== 'GET').map(call => call.path)).toEqual([`${path}/preview`, `${path}/apply`]);
    await app.user.click(within(wizard).getByText('Подтверждённое сопоставление и единицы источника'));
    expect(within(wizard).getByRole('combobox', { name: 'Смысл значения' })).toHaveValue('current_estimate');
    expect(within(wizard).getByRole('combobox', { name: 'Единицы источника' })).toHaveValue('hours');
    expect(within(wizard).getByRole('combobox', { name: 'Единицы источника' })).toBeDisabled();
    await waitFor(() => expect(confirmed).toEqual(mapping()));
    app.unmount(); app.queryClient.clear();
    const reopened = renderApp(`${tablePath}?view=import&import=${IMPORT_ID}`);
    const saved = await screen.findByRole('region', { name: 'Импорт CSV проекта' });
    await within(saved).findByText('Импорт применён');
    await reopened.user.click(within(saved).getByText('Подтверждённое сопоставление и единицы источника'));
    expect(within(saved).getByRole('combobox', { name: 'Смысл значения' })).toHaveValue('current_estimate');
    expect(within(saved).getByRole('combobox', { name: 'Единицы источника' })).toHaveValue('hours');
    expect(within(saved).queryByRole('button', { name: 'Применить импорт' })).not.toBeInTheDocument();
    reopened.unmount(); reopened.queryClient.clear();
  });
});
