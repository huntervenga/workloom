import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localization } from '../../i18n';
import type * as LocalizationExports from '../../i18n';
import { installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { MEMBER_ID, PERIOD_A, TASK_ID, log, rootPath, routes, task, weekPath } from './test/fixtures';

vi.mock('../../i18n', async importOriginal => {
  const actual = await importOriginal<typeof LocalizationExports>();
  const { catalogsFromModules } = await import('../../i18n/LocalizationManager');
  const english = import.meta.glob('../../i18n/locales/en/*.json', { eager: true, import: 'default' });
  const catalogs = catalogsFromModules({
    ...english,
    '../../i18n/locales/de/planning.json': { weeklyActualHoursSaved: 'Die tatsächlichen Wochenstunden wurden gespeichert.' },
  });
  const manager = new actual.LocalizationManager(catalogs);
  return { ...actual, localization: manager, t: manager.t, useTranslation: () => actual.useTranslation(manager) };
});

afterEach(() => { act(() => localization.setLocale('en')); });

describe('weekly save announcement', () => {
  it('retranslates a confirmed zero-hours announcement without repeating the write or translating task data', async () => {
    let saved = false;
    const { calls } = installFakeApi({
      ...routes(),
      [`GET ${rootPath}/recorded-work`]: () => ok(saved ? [log()] : []),
      [`PUT ${rootPath}/tasks/${TASK_ID}/manual-period-work/${PERIOD_A}/${MEMBER_ID}`]: () => { saved = true; return ok(log()); },
    });
    const { user } = renderApp(`${weekPath}?period=${PERIOD_A}`);
    await user.click(await screen.findByRole('button', { name: 'Record actual hours' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record weekly actual hours' });
    await user.selectOptions(within(dialog).getByLabelText('Task'), TASK_ID);
    await user.type(within(dialog).getByLabelText('Actual hours this week'), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Save actual hours' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const announcement = screen.getByText('Weekly actual hours saved.');
    expect(announcement).toHaveAttribute('role', 'status');
    expect(screen.getByRole('region', { name: 'Weekly actual hours' })).toHaveTextContent(task.title);

    act(() => localization.setLocale('de'));

    expect(announcement).toHaveTextContent('Die tatsächlichen Wochenstunden wurden gespeichert.');
    expect(screen.queryByText('Weekly actual hours saved.')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Weekly actual hours' })).toHaveTextContent(task.title);
    const writes = calls.filter(call => call.method !== 'GET');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.body).toEqual({ expectedRevision: null, minutes: 0, state: 'active', reason: null });
  });
});
