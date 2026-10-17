import { screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { alphaMembers, anna, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { PERIOD_A, commitment, log, rootPath, routes, weekPath, work } from './test/fixtures';
import { choosePicker, personPicker, personLabel } from './test/pickers';

beforeAll(async () => { await import('../../routes/WeeklyPage'); });
const colleague = alphaMembers[1];
if (!colleague) throw new Error('Missing colleague');
const other = { ...commitment(0), id: 'f3000000-0000-4000-8000-000000000002', membershipId: colleague.id };
const plans = () => within(screen.getByRole('table', { name: 'Personal plans' }));

function setup() {
  const { calls } = installFakeApi({ ...routes(), [`GET ${rootPath}/periods/${PERIOD_A}/commitments`]: () => ok([commitment(), other]), [`GET ${rootPath}/recorded-work`]: () => ok([log(0), { ...log(60), id: 'f7000000-0000-4000-8000-000000000002', membershipId: colleague.id }]) });
  return { ...renderApp(`${weekPath}?period=${PERIOD_A}&worker=${colleague.id}`), calls };
}

describe('weekly plans and hours display lens', () => {
  it('defaults to all people and filters saved rows independently from entry person and report cohort', async () => {
    const { user, calls } = setup();
    await screen.findByRole('table', { name: 'Personal plans' });
    expect(screen.getByRole('combobox', { name: 'Show plans and hours for' })).toHaveTextContent('All people');
    expect(plans().getAllByRole('row')).toHaveLength(3);
    await choosePicker(user, 'Show plans and hours for', `${anna.displayName} (me)`);
    expect(plans().getAllByRole('row')).toHaveLength(2);
    expect(plans().getByText(anna.displayName)).toBeVisible();
    expect(plans().queryByText(colleague.displayName)).not.toBeInTheDocument();
    const actuals = within(screen.getByRole('list', { name: 'Actual-hour entries' }));
    expect(actuals.getAllByRole('listitem')).toHaveLength(1);
    expect(actuals.getByText('0m')).toBeVisible();
    expect(personPicker()).toHaveTextContent(personLabel(colleague.id));
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await user.click(screen.getByRole('button', { name: 'Work types' }));
    expect(screen.getByRole('checkbox', { name: anna.displayName })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: colleague.displayName })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Plan and hours' }));
    expect(plans().getAllByRole('row')).toHaveLength(2);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('announces a hidden saved-plan draft and restores its exact person and hours through Show all', async () => {
    const { user, calls } = setup();
    await screen.findByRole('table', { name: 'Personal plans' });
    const row = plans().getAllByRole('row').find(item => item.textContent?.includes(colleague.displayName));
    if (!row) throw new Error('Missing colleague row');
    await user.click(within(row).getByRole('button', { name: 'Edit plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Personal weekly plan' });
    await user.clear(within(dialog).getByLabelText('Planned hours'));
    await user.type(within(dialog).getByLabelText('Planned hours'), '2:15');
    const close = within(dialog).getAllByRole('button', { name: 'Close' }).find(button => button.hasAttribute('aria-label'));
    if (!close) throw new Error('Missing close control');
    await user.click(close);
    await choosePicker(user, 'Show plans and hours for', `${anna.displayName} (me)`);
    expect(screen.getByText('1 entry is hidden by this view, 1 with unsaved changes.')).toBeVisible();
    const notice = screen.getByText('1 entry is hidden by this view, 1 with unsaved changes.').closest('[role="status"]');
    if (!(notice instanceof HTMLElement)) throw new Error('Missing draft notice');
    await user.click(within(notice).getByRole('button', { name: 'Show all people' }));
    const restored = plans().getAllByRole('row').find(item => item.textContent?.includes(colleague.displayName));
    if (!restored) throw new Error('Missing restored row');
    await user.click(within(restored).getByRole('button', { name: 'Edit plan' }));
    const reopened = screen.getByRole('dialog', { name: 'Personal weekly plan' });
    expect(within(reopened).getByLabelText('Planned hours')).toHaveValue('2:15');
    expect(within(reopened).getByLabelText('Whole task')).toHaveTextContent(work.title);
    expect(within(reopened).getByRole('region', { name: 'Time entry context' })).toHaveTextContent(colleague.displayName);
    expect(personPicker()).toHaveTextContent(personLabel(colleague.id));
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });
});
