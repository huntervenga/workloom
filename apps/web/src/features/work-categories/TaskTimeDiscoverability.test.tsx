import { screen, waitFor } from '@testing-library/react';
import { beforeAll, expect, it } from 'vitest';
import { alpha, installFakeApi, ok, renderApp } from '../../test/fakeApi';
import { MEMBER_ID, PERIOD_A, PROJECT_ID, rootPath, legacyTablePath, tablePath, tableRoutes, task } from './test/fixtures';

beforeAll(async () => { await import('../../routes/ProjectPage'); });
it('shows actual hours before a week is chosen and opens explicit context without reading or writing facts', async () => {
  const { calls } = installFakeApi(tableRoutes());
  const ui = renderApp(legacyTablePath());
  await screen.findByRole('button', { name: task.title });
  expect(screen.getByRole('columnheader', { name: /Weekly actual hours/ })).toBeInTheDocument();
  expect(screen.getByText(/Choose a week to enter planned or actual hours/)).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Week for hours' })).toHaveTextContent('Choose a week explicitly');
  await ui.user.click(screen.getAllByRole('button', { name: 'Choose week' })[0] as HTMLElement);
  expect(await screen.findByRole('listbox', { name: 'Week for hours' })).toBeInTheDocument();
  expect(calls.some(call => call.path.endsWith('task-time-summary'))).toBe(false);
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('respects a saved hidden Actual preference instead of overriding it when context is absent or present', async () => {
  const { calls } = installFakeApi({ ...tableRoutes(), [`GET ${rootPath}/projects/${PROJECT_ID}/table-preferences/me`]: () => ok({
    workspaceId: alpha.id, projectId: PROJECT_ID, membershipId: MEMBER_ID, revision: 1,
    columns: [{ column: { kind: 'builtin', key: 'title' }, visible: true }, { column: { kind: 'builtin', key: 'weeklyActual' }, visible: false }],
  }) });
  const ui = renderApp(legacyTablePath(`${tablePath}?week=${PERIOD_A}&worker=${MEMBER_ID}`));
  await screen.findByRole('button', { name: task.title });
  await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Weekly actual hours/ })).not.toBeInTheDocument());
  ui.unmount();
  renderApp(legacyTablePath());
  await screen.findByRole('button', { name: task.title });
  await waitFor(() => expect(screen.queryByRole('columnheader', { name: /Weekly actual hours/ })).not.toBeInTheDocument());
  expect(calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
