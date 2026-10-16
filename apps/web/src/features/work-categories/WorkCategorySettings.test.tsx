import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../lib/queryKeys';
import { alpha, anna, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { lostResponse } from '../planning/test/fixtures';
import { FIELD, PROJECT_ID, binding, definition, rootPath, tablePath, tableRoutes } from './test/fixtures';

describe('project work category binding lifecycle', () => {
  it('keeps the original binding choice/key after closing and loss even when that field is archived meanwhile', async () => {
    const gate = lostResponse();
    let attempts = 0;
    let archived = false;
    const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/fields`]: () => ok([{ ...definition(), archivedAt: archived ? '2026-10-20T10:00:00Z' : null }]), [`GET ${rootPath}/projects/${PROJECT_ID}/work-category-binding`]: () => ok(archived ? { ...binding(), availability: 'field_archived' } : binding(false)), [`PATCH ${rootPath}/projects/${PROJECT_ID}/work-category-binding`]: () => ++attempts === 1 ? gate.promise : ok(binding()) });
    const { user, queryClient } = renderApp(tablePath);
    await user.click(await screen.findByRole('button', { name: 'Типы работы' }));
    let dialog = await screen.findByRole('dialog', { name: 'Тип работы проекта' });
    await user.selectOptions(within(dialog).getByLabelText('Поле типа работы'), FIELD);
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить поле типа работы' }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(within(dialog).getByLabelText('Поле типа работы')).toBeDisabled();
    const close = within(dialog).getAllByRole('button', { name: 'Закрыть' }).find((button) => button.hasAttribute('aria-label'));
    if (!close) throw new Error('Missing close button');
    await user.click(close);
    archived = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.fieldDefinitions(anna.id, alpha.id, PROJECT_ID), exact: true }); await queryClient.invalidateQueries({ queryKey: queryKeys.workCategoryBinding(anna.id, alpha.id, PROJECT_ID), exact: true }); gate.lose(); });
    await user.click(screen.getByRole('button', { name: 'Типы работы' }));
    dialog = await screen.findByRole('dialog', { name: 'Тип работы проекта' });
    expect(within(dialog).getByLabelText('Поле типа работы')).toHaveValue(FIELD);
    await user.click(within(dialog).getByRole('button', { name: 'Повторить отправку' }));
    await waitFor(() => expect(attempts).toBe(2));
    const writes = calls.filter((call) => call.method === 'PATCH');
    expect(writes[0]?.body).toEqual({ expectedRevision: 1, fieldId: FIELD });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.headers.get('Idempotency-Key')).toBe(writes[0]?.headers.get('Idempotency-Key'));
  });
});
